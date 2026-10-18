use axum::{
    Json,
    extract::{Path, State},
};
use axum_extra::extract::CookieJar;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::clean_text;
use crate::{
    AppState,
    auth::{self, verify_password},
    db::{bump_rev, now},
    error::{ApiResult, AppError},
};

pub const STATUSES: &[&str] = &["pending", "approved", "changes_requested"];

#[derive(Serialize)]
pub struct BoardView {
    pub board: BoardInfo,
    pub is_admin: bool,
    pub images: Vec<ImageView>,
}

#[derive(Serialize)]
pub struct BoardInfo {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub has_passcode: bool,
    pub rev: i64,
}

#[derive(Serialize)]
pub struct ImageView {
    pub id: i64,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub z: i64,
    /// Oldest first; the last one is the current version.
    pub versions: Vec<VersionView>,
}

#[derive(Serialize)]
pub struct VersionView {
    pub id: i64,
    pub number: i64,
    pub original_name: String,
    pub px_width: i64,
    pub px_height: i64,
    pub status: String,
    pub status_by: Option<String>,
    pub status_at: Option<i64>,
    pub created_at: i64,
    pub comments: Vec<CommentView>,
}

#[derive(Serialize)]
pub struct CommentView {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub author: String,
    pub is_admin: bool,
    pub body: String,
    pub resolved_at: Option<i64>,
    pub created_at: i64,
}

/// Board row needed for access checks: (id, has_passcode).
pub fn find_board(conn: &Connection, slug: &str) -> Result<(i64, Option<String>), AppError> {
    Ok(conn.query_row("SELECT id, passcode_hash FROM boards WHERE slug = ?1", [slug], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

pub fn load_board(conn: &Connection, board_id: i64, is_admin: bool) -> Result<BoardView, AppError> {
    let board = conn.query_row(
        "SELECT id, slug, title, passcode_hash IS NOT NULL, rev FROM boards WHERE id = ?1",
        [board_id],
        |r| Ok(BoardInfo { id: r.get(0)?, slug: r.get(1)?, title: r.get(2)?, has_passcode: r.get(3)?, rev: r.get(4)? }),
    )?;

    let mut images: Vec<ImageView> = conn
        .prepare("SELECT id, title, x, y, width, z FROM images WHERE board_id = ?1 ORDER BY z, id")?
        .query_map([board_id], |r| {
            Ok(ImageView {
                id: r.get(0)?,
                title: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                width: r.get(4)?,
                z: r.get(5)?,
                versions: Vec::new(),
            })
        })?
        .collect::<Result<_, _>>()?;

    let mut versions = conn.prepare(
        "SELECT id, number, original_name, px_width, px_height, status, status_by, status_at, created_at
         FROM image_versions WHERE image_id = ?1 ORDER BY number",
    )?;
    let mut comments = conn.prepare(
        "SELECT id, parent_id, x, y, author, is_admin, body, resolved_at, created_at
         FROM comments WHERE version_id = ?1 ORDER BY id",
    )?;
    for image in &mut images {
        image.versions = versions
            .query_map([image.id], |r| {
                Ok(VersionView {
                    id: r.get(0)?,
                    number: r.get(1)?,
                    original_name: r.get(2)?,
                    px_width: r.get(3)?,
                    px_height: r.get(4)?,
                    status: r.get(5)?,
                    status_by: r.get(6)?,
                    status_at: r.get(7)?,
                    created_at: r.get(8)?,
                    comments: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;
        for version in &mut image.versions {
            version.comments = comments
                .query_map([version.id], |r| {
                    Ok(CommentView {
                        id: r.get(0)?,
                        parent_id: r.get(1)?,
                        x: r.get(2)?,
                        y: r.get(3)?,
                        author: r.get(4)?,
                        is_admin: r.get(5)?,
                        body: r.get(6)?,
                        resolved_at: r.get(7)?,
                        created_at: r.get(8)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
        }
    }
    Ok(BoardView { board, is_admin, images })
}

/// Resolve a slug to a board id, failing unless this browser may view it.
async fn authorize(state: &AppState, jar: &CookieJar, slug: String) -> ApiResult<(i64, bool)> {
    let (board_id, passcode) = state.db.call(move |c| find_board(c, &slug)).await?;
    let admin = auth::is_admin(state, jar).await?;
    if !auth::can_view(state, jar, board_id, passcode.is_some(), admin).await? {
        return Err(AppError::PasscodeRequired);
    }
    Ok((board_id, admin))
}

pub async fn get_board(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
) -> ApiResult<Json<BoardView>> {
    let (board_id, admin) = authorize(&state, &jar, slug).await?;
    Ok(Json(state.db.call(move |c| load_board(c, board_id, admin)).await?))
}

pub async fn get_rev(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
) -> ApiResult<Json<Value>> {
    let (board_id, _) = authorize(&state, &jar, slug).await?;
    let rev: i64 = state
        .db
        .call(move |c| Ok(c.query_row("SELECT rev FROM boards WHERE id = ?1", [board_id], |r| r.get(0))?))
        .await?;
    Ok(Json(json!({ "rev": rev })))
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
    let (board_id, passcode_hash) = state.db.call(move |c| find_board(c, &slug)).await?;
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

#[derive(Deserialize)]
pub struct NewComment {
    version_id: i64,
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
) -> ApiResult<Json<Value>> {
    let (board_id, admin) = authorize(&state, &jar, slug).await?;
    let body = clean_text(&input.body, "Comment", 4000)?;
    let author = match (&input.author, admin) {
        (Some(a), _) if !a.trim().is_empty() => clean_text(a, "Name", 60)?,
        (_, true) => "Betch".to_string(),
        _ => return Err(AppError::bad("Name is required")),
    };
    let pin = match input.parent_id {
        Some(_) => None,
        None => match (input.x, input.y) {
            (Some(x), Some(y)) if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) => Some((x, y)),
            _ => return Err(AppError::bad("A new comment needs a pin position on the image")),
        },
    };

    let id = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            version_on_board(&tx, input.version_id, board_id)?;
            if let Some(parent) = input.parent_id {
                let parent_ok = tx
                    .query_row(
                        "SELECT 1 FROM comments WHERE id = ?1 AND version_id = ?2 AND parent_id IS NULL",
                        params![parent, input.version_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if parent_ok.is_none() {
                    return Err(AppError::bad("Unknown thread"));
                }
            }
            tx.execute(
                "INSERT INTO comments (version_id, parent_id, x, y, author, is_admin, body, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    input.version_id,
                    input.parent_id,
                    pin.map(|p| p.0),
                    pin.map(|p| p.1),
                    author,
                    admin,
                    body,
                    now()
                ],
            )?;
            let id = tx.last_insert_rowid();
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(id)
        })
        .await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
pub struct StatusBody {
    status: String,
    author: Option<String>,
}

pub async fn set_status(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((slug, version_id)): Path<(String, i64)>,
    Json(input): Json<StatusBody>,
) -> ApiResult<Json<Value>> {
    let (board_id, admin) = authorize(&state, &jar, slug).await?;
    if !STATUSES.contains(&input.status.as_str()) {
        return Err(AppError::bad("Unknown status"));
    }
    let by = match &input.author {
        Some(a) if !a.trim().is_empty() => Some(clean_text(a, "Name", 60)?),
        _ if admin => Some("Betch".to_string()),
        _ => return Err(AppError::bad("Name is required")),
    };
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            version_on_board(&tx, version_id, board_id)?;
            let (by, at) = if input.status == "pending" { (None, None) } else { (by, Some(now())) };
            tx.execute(
                "UPDATE image_versions SET status = ?1, status_by = ?2, status_at = ?3 WHERE id = ?4",
                params![input.status, by, at, version_id],
            )?;
            bump_rev(&tx, board_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

fn version_on_board(conn: &Connection, version_id: i64, board_id: i64) -> Result<(), AppError> {
    conn.query_row(
        "SELECT 1 FROM image_versions v JOIN images i ON i.id = v.image_id
         WHERE v.id = ?1 AND i.board_id = ?2",
        params![version_id, board_id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(AppError::NotFound)
}
