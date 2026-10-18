use axum::{
    Json,
    extract::{Multipart, Path, State, multipart::MultipartError},
};
use axum_extra::extract::CookieJar;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{clean_text, valid_slug};
use crate::{
    AppState,
    auth::{self, ADMIN_COOKIE, Admin, hash_password, verify_password},
    db::{bump_rev, now},
    error::{ApiResult, AppError},
    images::{self, StoredImage},
};

/// Longest edge of a freshly uploaded image on the board, in board units.
const DEFAULT_SIZE: f64 = 800.0;
const GAP: f64 = 60.0;

pub async fn session(State(state): State<AppState>, jar: CookieJar) -> ApiResult<Json<Value>> {
    let admin = auth::is_admin(&state, &jar).await?;
    Ok(Json(json!({ "admin": admin, "public_url": state.config.public_url })))
}

#[derive(Deserialize)]
pub struct LoginBody {
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<LoginBody>,
) -> ApiResult<(CookieJar, Json<Value>)> {
    state.throttle.check("admin")?;
    let hash = state.config.admin_password_hash.clone();
    let ok = tokio::task::spawn_blocking(move || verify_password(&body.password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    if !ok {
        state.throttle.fail("admin");
        return Err(AppError::bad("Wrong password"));
    }
    state.throttle.clear("admin");
    let cookie = auth::create_admin_session(&state).await?;
    Ok((jar.add(cookie), Json(json!({ "ok": true }))))
}

pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> ApiResult<(CookieJar, Json<Value>)> {
    if let Some(token) = jar.get(ADMIN_COOKIE).map(|c| c.value().to_string()) {
        state
            .db
            .call(move |c| {
                c.execute("DELETE FROM admin_sessions WHERE token = ?1", [token])?;
                Ok(())
            })
            .await?;
    }
    let removal = auth::make_cookie(&state, ADMIN_COOKIE.into(), String::new(), 0);
    Ok((jar.remove(removal), Json(json!({ "ok": true }))))
}

#[derive(Serialize)]
pub struct BoardSummary {
    id: i64,
    slug: String,
    title: String,
    has_passcode: bool,
    created_at: i64,
    images: i64,
    approved: i64,
    changes_requested: i64,
    open_comments: i64,
    cover_version_id: Option<i64>,
}

pub async fn list_boards(_: Admin, State(state): State<AppState>) -> ApiResult<Json<Vec<BoardSummary>>> {
    let boards = state
        .db
        .call(|c| {
            // "Current" version = highest number per image.
            let rows = c
                .prepare(
                    "WITH cur AS (
                        SELECT v.* FROM image_versions v
                        WHERE v.number = (SELECT MAX(number) FROM image_versions WHERE image_id = v.image_id)
                     )
                     SELECT b.id, b.slug, b.title, b.passcode_hash IS NOT NULL, b.created_at,
                        (SELECT COUNT(*) FROM images i WHERE i.board_id = b.id),
                        (SELECT COUNT(*) FROM cur JOIN images i ON i.id = cur.image_id
                            WHERE i.board_id = b.id AND cur.status = 'approved'),
                        (SELECT COUNT(*) FROM cur JOIN images i ON i.id = cur.image_id
                            WHERE i.board_id = b.id AND cur.status = 'changes_requested'),
                        (SELECT COUNT(*) FROM comments cm JOIN cur ON cur.id = cm.version_id
                            JOIN images i ON i.id = cur.image_id
                            WHERE i.board_id = b.id AND cm.parent_id IS NULL AND cm.resolved_at IS NULL),
                        (SELECT cur.id FROM cur JOIN images i ON i.id = cur.image_id
                            WHERE i.board_id = b.id ORDER BY i.z DESC, i.id LIMIT 1)
                     FROM boards b ORDER BY b.created_at DESC, b.id DESC",
                )?
                .query_map([], |r| {
                    Ok(BoardSummary {
                        id: r.get(0)?,
                        slug: r.get(1)?,
                        title: r.get(2)?,
                        has_passcode: r.get(3)?,
                        created_at: r.get(4)?,
                        images: r.get(5)?,
                        approved: r.get(6)?,
                        changes_requested: r.get(7)?,
                        open_comments: r.get(8)?,
                        cover_version_id: r.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(boards))
}

#[derive(Deserialize)]
pub struct NewBoard {
    slug: String,
    title: String,
    passcode: Option<String>,
}

pub async fn create_board(
    _: Admin,
    State(state): State<AppState>,
    Json(input): Json<NewBoard>,
) -> ApiResult<Json<Value>> {
    let slug = input.slug.trim().to_lowercase();
    if !valid_slug(&slug) {
        return Err(AppError::bad("The link name must be 3–64 characters: lowercase letters, digits and dashes."));
    }
    let title = clean_text(&input.title, "Title", 120)?;
    let passcode_hash = hash_optional_passcode(input.passcode).await?;
    let id = state
        .db
        .call(move |c| {
            let taken = c.query_row("SELECT COUNT(*) FROM boards WHERE slug = ?1", [&slug], |r| r.get::<_, i64>(0))?;
            if taken > 0 {
                return Err(AppError::Conflict("A board with this link already exists".into()));
            }
            c.execute(
                "INSERT INTO boards (slug, title, passcode_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![slug, title, passcode_hash, now()],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
pub struct BoardPatch {
    title: Option<String>,
    /// `Some("")` removes the passcode; `None` leaves it unchanged.
    passcode: Option<String>,
}

pub async fn update_board(
    _: Admin,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<BoardPatch>,
) -> ApiResult<Json<Value>> {
    let title = input.title.as_deref().map(|t| clean_text(t, "Title", 120)).transpose()?;
    let passcode_change = match input.passcode {
        None => None,
        Some(p) => Some(hash_optional_passcode(Some(p)).await?),
    };
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let exists = tx.query_row("SELECT COUNT(*) FROM boards WHERE id = ?1", [id], |r| r.get::<_, i64>(0))?;
            if exists == 0 {
                return Err(AppError::NotFound);
            }
            if let Some(title) = title {
                tx.execute("UPDATE boards SET title = ?1 WHERE id = ?2", params![title, id])?;
            }
            if let Some(hash) = passcode_change {
                tx.execute("UPDATE boards SET passcode_hash = ?1 WHERE id = ?2", params![hash, id])?;
                // A new passcode signs out everyone who entered the old one.
                tx.execute("DELETE FROM board_access WHERE board_id = ?1", [id])?;
            }
            bump_rev(&tx, id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_board(_: Admin, State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let files = state
        .db
        .call(move |c| {
            let files = version_files(
                c,
                "SELECT v.file_key, v.mime, v.display_mime FROM image_versions v
                 JOIN images i ON i.id = v.image_id WHERE i.board_id = ?1",
                id,
            )?;
            if c.execute("DELETE FROM boards WHERE id = ?1", [id])? == 0 {
                return Err(AppError::NotFound);
            }
            Ok(files)
        })
        .await?;
    remove_files(&state, files).await;
    Ok(Json(json!({ "ok": true })))
}

/// Upload one or more images onto a board. Optional `x`/`y` fields give the
/// board point to centre the new row on (normally the middle of the screen);
/// with `anchor=left` the row starts at `x` instead.
pub async fn upload_images(
    _: Admin,
    State(state): State<AppState>,
    Path(board_id): Path<i64>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let exists = state
        .db
        .call(
            move |c| Ok(c.query_row("SELECT COUNT(*) FROM boards WHERE id = ?1", [board_id], |r| r.get::<_, i64>(0))?),
        )
        .await?;
    if exists == 0 {
        return Err(AppError::NotFound);
    }

    let (mut cx, mut cy, mut anchor_left) = (None, None, false);
    let mut stored = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("x") => cx = field.text().await.map_err(multipart_error)?.parse::<f64>().ok(),
            Some("y") => cy = field.text().await.map_err(multipart_error)?.parse::<f64>().ok(),
            Some("anchor") => anchor_left = field.text().await.map_err(multipart_error)? == "left",
            Some("file") => {
                let name = field.file_name().unwrap_or("image").to_string();
                let bytes = field.bytes().await.map_err(multipart_error)?;
                stored.push((name, store_image(&state, bytes.to_vec()).await?));
            }
            _ => {}
        }
    }
    if stored.is_empty() {
        return Err(AppError::bad("No file uploaded"));
    }

    let cleanup: Vec<_> = stored.iter().map(|(_, s)| (s.file_key.clone(), s.mime, s.display_mime)).collect();
    let ids = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let (mut x, y, top_z) = placement(&tx, board_id, cx, cy, anchor_left, &stored)?;
            let mut ids = Vec::new();
            for (i, (name, img)) in stored.iter().enumerate() {
                let (w, h) = default_size(img);
                tx.execute(
                    "INSERT INTO images (board_id, title, x, y, width, z, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![board_id, title_from_filename(name), x, y - h / 2.0, w, top_z + 1 + i as i64, now()],
                )?;
                let image_id = tx.last_insert_rowid();
                insert_version(&tx, image_id, 1, name, img)?;
                ids.push(image_id);
                x += w + GAP;
            }
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(ids)
        })
        .await;
    if ids.is_err() {
        for (key, mime, display_mime) in cleanup {
            images::remove(&state.images_dir, &key, mime, display_mime);
        }
    }
    Ok(Json(json!({ "ids": ids? })))
}

/// Upload a new version of an existing image. Earlier versions keep their
/// comments and status; the new one starts as pending.
pub async fn upload_version(
    _: Admin,
    State(state): State<AppState>,
    Path(image_id): Path<i64>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut upload = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name() == Some("file") {
            let name = field.file_name().unwrap_or("image").to_string();
            let bytes = field.bytes().await.map_err(multipart_error)?;
            upload = Some((name, store_image(&state, bytes.to_vec()).await?));
            break;
        }
    }
    let Some((name, img)) = upload else {
        return Err(AppError::bad("No file uploaded"));
    };
    let (key, mime, display_mime) = (img.file_key.clone(), img.mime, img.display_mime);

    let result = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let board_id: i64 = tx.query_row("SELECT board_id FROM images WHERE id = ?1", [image_id], |r| r.get(0))?;
            let next: i64 = tx.query_row(
                "SELECT COALESCE(MAX(number), 0) + 1 FROM image_versions WHERE image_id = ?1",
                [image_id],
                |r| r.get(0),
            )?;
            let id = insert_version(&tx, image_id, next, &name, &img)?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(json!({ "id": id, "number": next }))
        })
        .await;
    if result.is_err() {
        images::remove(&state.images_dir, &key, mime, display_mime);
    }
    Ok(Json(result?))
}

#[derive(Deserialize)]
pub struct ImagePatch {
    title: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    z: Option<i64>,
}

pub async fn update_image(
    _: Admin,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ImagePatch>,
) -> ApiResult<Json<Value>> {
    let title = input.title.as_deref().map(|t| clean_text(t, "Title", 200)).transpose()?;
    for v in [input.x, input.y, input.width].into_iter().flatten() {
        if !v.is_finite() || v.abs() > 1e7 {
            return Err(AppError::bad("Position out of range"));
        }
    }
    if input.width.is_some_and(|w| w < 20.0) {
        return Err(AppError::bad("Image is too small"));
    }
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let board_id: i64 = tx.query_row("SELECT board_id FROM images WHERE id = ?1", [id], |r| r.get(0))?;
            tx.execute(
                "UPDATE images SET title = COALESCE(?1, title), x = COALESCE(?2, x), y = COALESCE(?3, y),
                 width = COALESCE(?4, width), z = COALESCE(?5, z) WHERE id = ?6",
                params![title, input.x, input.y, input.width, input.z, id],
            )?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_image(_: Admin, State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let files = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let board_id: i64 = tx.query_row("SELECT board_id FROM images WHERE id = ?1", [id], |r| r.get(0))?;
            let files =
                version_files(&tx, "SELECT file_key, mime, display_mime FROM image_versions WHERE image_id = ?1", id)?;
            tx.execute("DELETE FROM images WHERE id = ?1", [id])?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(files)
        })
        .await?;
    remove_files(&state, files).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ResolveBody {
    resolved: bool,
}

pub async fn resolve_comment(
    _: Admin,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ResolveBody>,
) -> ApiResult<Json<Value>> {
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let board_id = comment_board(&tx, id)?;
            let resolved_at = input.resolved.then(now);
            tx.execute("UPDATE comments SET resolved_at = ?1 WHERE id = ?2", params![resolved_at, id])?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_comment(_: Admin, State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let board_id = comment_board(&tx, id)?;
            tx.execute("DELETE FROM comments WHERE id = ?1", [id])?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---- helpers ----

async fn hash_optional_passcode(passcode: Option<String>) -> ApiResult<Option<String>> {
    let Some(p) = passcode.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    if p.chars().count() > 100 {
        return Err(AppError::bad("Passcode is too long"));
    }
    let hash =
        tokio::task::spawn_blocking(move || hash_password(&p)).await.map_err(|e| AppError::Internal(e.into()))??;
    Ok(Some(hash))
}

async fn store_image(state: &AppState, bytes: Vec<u8>) -> ApiResult<StoredImage> {
    let dir = state.images_dir.clone();
    tokio::task::spawn_blocking(move || images::store(&dir, &bytes)).await.map_err(|e| AppError::Internal(e.into()))?
}

fn insert_version(
    conn: &Connection,
    image_id: i64,
    number: i64,
    name: &str,
    img: &StoredImage,
) -> Result<i64, AppError> {
    let name: String = name.chars().take(200).collect();
    conn.execute(
        "INSERT INTO image_versions
            (image_id, number, file_key, original_name, mime, display_mime, px_width, px_height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![image_id, number, img.file_key, name, img.mime, img.display_mime, img.px_width, img.px_height, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

fn default_size(img: &StoredImage) -> (f64, f64) {
    let (w, h) = (img.px_width.max(1) as f64, img.px_height.max(1) as f64);
    let scale = DEFAULT_SIZE / w.max(h);
    (w * scale, h * scale)
}

/// Where to put a batch of new images, as (left x, centre y, highest z).
/// With (cx, cy) the row is centred there, or starts there when `anchor_left`;
/// without them it goes to the right of everything already on the board.
fn placement(
    conn: &Connection,
    board_id: i64,
    cx: Option<f64>,
    cy: Option<f64>,
    anchor_left: bool,
    stored: &[(String, StoredImage)],
) -> Result<(f64, f64, i64), AppError> {
    let (right, top_z): (Option<f64>, Option<i64>) =
        conn.query_row("SELECT MAX(x + width), MAX(z) FROM images WHERE board_id = ?1", [board_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let row_width: f64 =
        stored.iter().map(|(_, img)| default_size(img).0).sum::<f64>() + GAP * (stored.len() as f64 - 1.0);
    let (x, y) = match (cx, cy) {
        (Some(cx), Some(cy)) if cx.is_finite() && cy.is_finite() => {
            (if anchor_left { cx } else { cx - row_width / 2.0 }, cy)
        }
        _ => (right.map_or(0.0, |r| r + GAP), DEFAULT_SIZE / 2.0),
    };
    Ok((x, y, top_z.unwrap_or(0)))
}

fn title_from_filename(name: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let t: String = stem.replace(['_', '-'], " ").trim().chars().take(200).collect();
    if t.is_empty() { "Image".into() } else { t }
}

fn comment_board(conn: &Connection, comment_id: i64) -> Result<i64, AppError> {
    Ok(conn.query_row(
        "SELECT i.board_id FROM comments c JOIN image_versions v ON v.id = c.version_id
         JOIN images i ON i.id = v.image_id WHERE c.id = ?1",
        [comment_id],
        |r| r.get(0),
    )?)
}

type FileRef = (String, String, String);

fn version_files(conn: &Connection, sql: &str, id: i64) -> Result<Vec<FileRef>, AppError> {
    Ok(conn.prepare(sql)?.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?)
}

async fn remove_files(state: &AppState, files: Vec<FileRef>) {
    let dir = state.images_dir.clone();
    let _ = tokio::task::spawn_blocking(move || {
        for (key, mime, display_mime) in files {
            images::remove(&dir, &key, &mime, &display_mime);
        }
    })
    .await;
}

fn multipart_error(e: MultipartError) -> AppError {
    if e.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        AppError::TooLarge
    } else {
        AppError::bad(format!("Upload failed: {}", e.body_text()))
    }
}
