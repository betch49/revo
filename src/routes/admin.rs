use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, State},
};
use axum_extra::extract::CookieJar;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{board::board_meta, clean_text, slugify, valid_slug};
use crate::{
    AppState,
    auth::{self, ACCESS_LEVELS, ADMIN_COOKIE, Admin, hash_password, verify_password},
    db::now,
    error::{ApiResult, AppError},
    hub::SERVER,
    images,
};

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
    access: String,
    has_passcode: bool,
    created_at: i64,
    updated_at: i64,
    items: i64,
    open_comments: i64,
    online: usize,
}

pub async fn list_boards(_: Admin, State(state): State<AppState>) -> ApiResult<Json<Vec<BoardSummary>>> {
    let mut boards = state
        .db
        .call(|c| {
            let rows = c
                .prepare(
                    "SELECT b.id, b.slug, b.title, b.access, b.passcode_hash IS NOT NULL, b.created_at, b.updated_at,
                        (SELECT COUNT(*) FROM items i WHERE i.board_id = b.id),
                        (SELECT COUNT(*) FROM comments c WHERE c.board_id = b.id
                            AND c.parent_id IS NULL AND c.resolved_at IS NULL)
                     FROM boards b ORDER BY b.updated_at DESC, b.id DESC",
                )?
                .query_map([], |r| {
                    Ok(BoardSummary {
                        id: r.get(0)?,
                        slug: r.get(1)?,
                        title: r.get(2)?,
                        access: r.get(3)?,
                        has_passcode: r.get(4)?,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                        items: r.get(7)?,
                        open_comments: r.get(8)?,
                        online: 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    for b in &mut boards {
        b.online = state.hub.peer_count(b.id);
    }
    Ok(Json(boards))
}

#[derive(Deserialize)]
pub struct NewBoard {
    title: String,
    /// Optional custom link name; derived from the title when missing.
    slug: Option<String>,
}

pub async fn create_board(
    _: Admin,
    State(state): State<AppState>,
    Json(input): Json<NewBoard>,
) -> ApiResult<Json<Value>> {
    let title = clean_text(&input.title, "Title", 120)?;
    let custom = input.slug.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if let Some(s) = &custom
        && !valid_slug(s)
    {
        return Err(AppError::bad("The link name must be 3–64 characters: lowercase letters, digits and dashes."));
    }
    let board = state
        .db
        .call(move |c| {
            let slug = match custom {
                Some(s) => {
                    if slug_taken(c, &s)? {
                        return Err(AppError::Conflict("A board with this link already exists".into()));
                    }
                    s
                }
                None => free_slug(c, &slugify(&title))?,
            };
            let t = now();
            c.execute(
                "INSERT INTO boards (slug, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![slug, title, t],
            )?;
            board_meta(c, c.last_insert_rowid())
        })
        .await?;
    Ok(Json(json!(board)))
}

#[derive(Deserialize)]
pub struct BoardPatch {
    title: Option<String>,
    /// private | view | comment | edit
    access: Option<String>,
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
    if let Some(a) = &input.access
        && !ACCESS_LEVELS.contains(&a.as_str())
    {
        return Err(AppError::bad("Unknown access level"));
    }
    let passcode_change = match input.passcode {
        None => None,
        Some(p) => Some(hash_optional_passcode(Some(p)).await?),
    };
    let access_changed = input.access.is_some() || passcode_change.is_some();
    let board = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            board_meta(&tx, id)?;
            if let Some(title) = title {
                tx.execute("UPDATE boards SET title = ?1 WHERE id = ?2", params![title, id])?;
            }
            if let Some(access) = input.access {
                tx.execute("UPDATE boards SET access = ?1 WHERE id = ?2", params![access, id])?;
            }
            if let Some(hash) = passcode_change {
                tx.execute("UPDATE boards SET passcode_hash = ?1 WHERE id = ?2", params![hash, id])?;
                // A new passcode signs out everyone who entered the old one.
                tx.execute("DELETE FROM board_access WHERE board_id = ?1", [id])?;
            }
            crate::db::touch_board(&tx, id)?;
            let board = board_meta(&tx, id)?;
            tx.commit()?;
            Ok(board)
        })
        .await?;
    // Open boards pick up the new title; after an access change they re-check
    // whether each visitor may still be there.
    let msg = if access_changed { json!({ "t": "reload" }) } else { json!({ "t": "board", "board": &board }) };
    state.hub.send(id, SERVER, msg.to_string());
    Ok(Json(json!(board)))
}

pub async fn delete_board(_: Admin, State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let files = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let files = unshared_files(&tx, id)?;
            if tx.execute("DELETE FROM boards WHERE id = ?1", [id])? == 0 {
                return Err(AppError::NotFound);
            }
            tx.commit()?;
            Ok(files)
        })
        .await?;
    let dir = state.images_dir.clone();
    let _ = tokio::task::spawn_blocking(move || {
        for (key, mime, display_mime) in files {
            images::remove(&dir, &key, &mime, &display_mime);
        }
    })
    .await;
    state.hub.send(id, SERVER, json!({ "t": "reload" }).to_string());
    Ok(Json(json!({ "ok": true })))
}

/// Copy a board with its items and images (not its comments or sharing).
/// Image files are shared between the copies, not duplicated on disk.
pub async fn duplicate_board(_: Admin, State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let board = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let source = board_meta(&tx, id)?;
            let title: String = format!("{} (copy)", source.title).chars().take(120).collect();
            let slug = free_slug(&tx, &format!("{}-copy", source.slug.chars().take(56).collect::<String>()))?;
            let t = now();
            tx.execute(
                "INSERT INTO boards (slug, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![slug, title, t],
            )?;
            let new_id = tx.last_insert_rowid();

            let mut asset_map = HashMap::new();
            let assets: Vec<i64> =
                tx.prepare("SELECT id FROM assets WHERE board_id = ?1")?.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for old in assets {
                tx.execute(
                    "INSERT INTO assets (board_id, file_key, original_name, mime, display_mime, px_width, px_height, created_at)
                     SELECT ?1, file_key, original_name, mime, display_mime, px_width, px_height, ?2 FROM assets WHERE id = ?3",
                    params![new_id, t, old],
                )?;
                asset_map.insert(old, tx.last_insert_rowid());
            }

            let items: Vec<(String, String)> = tx
                .prepare("SELECT id, data FROM items WHERE board_id = ?1")?
                .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            for (item_id, data) in items {
                let mut value: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                if let Some(asset) = value.get("asset").and_then(Value::as_i64)
                    && let Some(new_asset) = asset_map.get(&asset)
                {
                    value["asset"] = json!(new_asset);
                }
                tx.execute(
                    "INSERT INTO items (board_id, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![new_id, item_id, value.to_string(), t],
                )?;
            }
            let board = board_meta(&tx, new_id)?;
            tx.commit()?;
            Ok(board)
        })
        .await?;
    Ok(Json(json!(board)))
}

// ---- helpers ----

fn slug_taken(conn: &Connection, slug: &str) -> Result<bool, AppError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM boards WHERE slug = ?1", [slug], |r| r.get::<_, i64>(0))? > 0)
}

/// `base`, or `base-2`, `base-3`… whichever is free.
fn free_slug(conn: &Connection, base: &str) -> Result<String, AppError> {
    let base = if valid_slug(base) { base.to_string() } else { format!("board-{}", auth::random_token(3)) };
    if !slug_taken(conn, &base)? {
        return Ok(base);
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !slug_taken(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}-{}", auth::random_token(3)))
}

/// Image files used only by this board (copies made by "duplicate" share files).
fn unshared_files(conn: &Connection, board_id: i64) -> Result<Vec<(String, String, String)>, AppError> {
    Ok(conn
        .prepare(
            "SELECT DISTINCT a.file_key, a.mime, a.display_mime FROM assets a WHERE a.board_id = ?1
             AND NOT EXISTS (SELECT 1 FROM assets o WHERE o.file_key = a.file_key AND o.board_id != ?1)",
        )?
        .query_map([board_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?)
}

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
