use axum::{
    Json,
    extract::{Multipart, Path, State, multipart::MultipartError},
};
use axum_extra::extract::CookieJar;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{board_access_by_slug, clean_text};
use crate::{
    AppState,
    auth::{self, Role, verify_password},
    db::{now, touch_board},
    error::{ApiResult, AppError},
    hub::SERVER,
    images,
};

#[derive(Serialize)]
pub struct BoardMeta {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub access: String,
    pub has_passcode: bool,
}

#[derive(Serialize, Clone)]
pub struct CommentView {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub author: String,
    pub is_owner: bool,
    pub body: String,
    pub resolved_at: Option<i64>,
    pub created_at: i64,
}

pub fn board_meta(conn: &Connection, board_id: i64) -> Result<BoardMeta, AppError> {
    Ok(conn.query_row(
        "SELECT id, slug, title, access, passcode_hash IS NOT NULL FROM boards WHERE id = ?1",
        [board_id],
        |r| {
            Ok(BoardMeta {
                id: r.get(0)?,
                slug: r.get(1)?,
                title: r.get(2)?,
                access: r.get(3)?,
                has_passcode: r.get(4)?,
            })
        },
    )?)
}

const COMMENT_COLUMNS: &str = "id, parent_id, x, y, author, is_owner, body, resolved_at, created_at";

fn comment_row(r: &rusqlite::Row) -> rusqlite::Result<CommentView> {
    Ok(CommentView {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        x: r.get(2)?,
        y: r.get(3)?,
        author: r.get(4)?,
        is_owner: r.get(5)?,
        body: r.get(6)?,
        resolved_at: r.get(7)?,
        created_at: r.get(8)?,
    })
}

pub fn load_comments(conn: &Connection, board_id: i64) -> Result<Vec<CommentView>, AppError> {
    Ok(conn
        .prepare_cached(&format!("SELECT {COMMENT_COLUMNS} FROM comments WHERE board_id = ?1 ORDER BY id"))?
        .query_map([board_id], comment_row)?
        .collect::<Result<_, _>>()?)
}

fn load_comment(conn: &Connection, id: i64) -> Result<CommentView, AppError> {
    Ok(conn.query_row(&format!("SELECT {COMMENT_COLUMNS} FROM comments WHERE id = ?1"), [id], comment_row)?)
}

/// Resolve a slug to its board and this browser's role there.
pub async fn authorize(state: &AppState, jar: &CookieJar, slug: String) -> ApiResult<(i64, Role)> {
    let board = state.db.call(move |c| board_access_by_slug(c, &slug)).await?;
    let role = auth::role_for(state, jar, &board).await?;
    Ok((board.id, role))
}

fn require(role: Role, needed: Role) -> ApiResult<()> {
    if role >= needed {
        Ok(())
    } else {
        let what = match needed {
            Role::Comment => "comment on",
            Role::Edit => "edit",
            _ => "manage",
        };
        Err(AppError::Forbidden(format!("You don't have permission to {what} this board.")))
    }
}

pub async fn get_board(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    let board = state.db.call(move |c| board_meta(c, board_id)).await?;
    Ok(Json(json!({ "board": board, "role": role, "public_url": state.config.public_url })))
}

#[derive(Deserialize)]
pub struct UnlockBody {
    passcode: String,
}

pub async fn unlock(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<UnlockBody>,
) -> ApiResult<(CookieJar, Json<Value>)> {
    let (board_id, access, passcode_hash): (i64, String, Option<String>) = state
        .db
        .call(move |c| {
            Ok(c.query_row("SELECT id, access, passcode_hash FROM boards WHERE slug = ?1", [&slug], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?)
        })
        .await?;
    if Role::from_access(&access).is_none() {
        return Err(AppError::NotFound);
    }
    let Some(hash) = passcode_hash else {
        return Ok((jar, Json(json!({ "ok": true }))));
    };
    let key = format!("board:{board_id}");
    state.throttle.check(&key)?;
    let ok = tokio::task::spawn_blocking(move || verify_password(&body.passcode, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    if !ok {
        state.throttle.fail(&key);
        return Err(AppError::bad("Wrong passcode"));
    }
    let cookie = auth::create_board_access(&state, board_id).await?;
    Ok((jar.add(cookie), Json(json!({ "ok": true }))))
}

/// Upload an image for the board. The browser then places an image item that
/// points at the returned asset id.
pub async fn upload_asset(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    require(role, Role::Edit)?;
    let mut upload = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name() == Some("file") {
            let name: String = field.file_name().unwrap_or("image").chars().take(200).collect();
            let bytes = field.bytes().await.map_err(multipart_error)?;
            upload = Some((name, bytes));
            break;
        }
    }
    let Some((name, bytes)) = upload else {
        return Err(AppError::bad("No file uploaded"));
    };
    let dir = state.images_dir.clone();
    let img = tokio::task::spawn_blocking(move || images::store(&dir, &bytes))
        .await
        .map_err(|e| AppError::Internal(e.into()))??;
    let (key, mime, display_mime) = (img.file_key.clone(), img.mime, img.display_mime);
    let (w, h) = (img.px_width, img.px_height);
    let result = state
        .db
        .call(move |c| {
            c.execute(
                "INSERT INTO assets (board_id, file_key, original_name, mime, display_mime, px_width, px_height, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![board_id, img.file_key, name, img.mime, img.display_mime, img.px_width, img.px_height, now()],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await;
    match result {
        Ok(id) => Ok(Json(json!({ "id": id, "w": w, "h": h }))),
        Err(e) => {
            images::remove(&state.images_dir, &key, mime, display_mime);
            Err(e)
        }
    }
}

#[derive(Deserialize)]
pub struct NewComment {
    parent_id: Option<i64>,
    x: Option<f64>,
    y: Option<f64>,
    author: Option<String>,
    body: String,
}

pub async fn add_comment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(input): Json<NewComment>,
) -> ApiResult<Json<CommentView>> {
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    require(role, Role::Comment)?;
    let body = clean_text(&input.body, "Comment", 4000)?;
    let owner = role == Role::Owner;
    let author = match &input.author {
        Some(a) if !a.trim().is_empty() => clean_text(a, "Name", 60)?,
        _ if owner => "Betch".to_string(),
        _ => return Err(AppError::bad("Name is required")),
    };
    let pin = match input.parent_id {
        Some(_) => None,
        None => match (input.x, input.y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x.abs() < 1e8 && y.abs() < 1e8 => Some((x, y)),
            _ => return Err(AppError::bad("A new comment needs a position on the board")),
        },
    };
    let comment = state
        .db
        .call(move |c| {
            if let Some(parent) = input.parent_id {
                let ok = c
                    .query_row(
                        "SELECT 1 FROM comments WHERE id = ?1 AND board_id = ?2 AND parent_id IS NULL",
                        params![parent, board_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if ok.is_none() {
                    return Err(AppError::bad("Unknown thread"));
                }
            }
            c.execute(
                "INSERT INTO comments (board_id, parent_id, x, y, author, is_owner, body, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![board_id, input.parent_id, pin.map(|p| p.0), pin.map(|p| p.1), author, owner, body, now()],
            )?;
            let comment = load_comment(c, c.last_insert_rowid())?;
            touch_board(c, board_id)?;
            Ok(comment)
        })
        .await?;
    state.hub.send(board_id, SERVER, json!({ "t": "comment", "comment": &comment }).to_string());
    Ok(Json(comment))
}

#[derive(Deserialize)]
pub struct ResolveBody {
    resolved: bool,
}

pub async fn resolve_comment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((slug, id)): Path<(String, i64)>,
    Json(input): Json<ResolveBody>,
) -> ApiResult<Json<CommentView>> {
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    require(role, Role::Comment)?;
    let comment = state
        .db
        .call(move |c| {
            let n = c.execute(
                "UPDATE comments SET resolved_at = ?1 WHERE id = ?2 AND board_id = ?3 AND parent_id IS NULL",
                params![input.resolved.then(now), id, board_id],
            )?;
            if n == 0 {
                return Err(AppError::NotFound);
            }
            load_comment(c, id)
        })
        .await?;
    state.hub.send(board_id, SERVER, json!({ "t": "comment", "comment": &comment }).to_string());
    Ok(Json(comment))
}

pub async fn delete_comment(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((slug, id)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    require(role, Role::Owner)?;
    state
        .db
        .call(move |c| {
            let n = c.execute("DELETE FROM comments WHERE id = ?1 AND board_id = ?2", params![id, board_id])?;
            if n == 0 { Err(AppError::NotFound) } else { Ok(()) }
        })
        .await?;
    state.hub.send(board_id, SERVER, json!({ "t": "comment_deleted", "id": id }).to_string());
    Ok(Json(json!({ "ok": true })))
}

pub fn multipart_error(e: MultipartError) -> AppError {
    if e.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        AppError::TooLarge
    } else {
        AppError::bad(format!("Upload failed: {}", e.body_text()))
    }
}
