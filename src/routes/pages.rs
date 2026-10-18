use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use axum_extra::extract::CookieJar;

use super::{board_access_by_id, valid_slug};
use crate::{
    AppState,
    auth::{self, Role},
    error::{ApiResult, AppError},
    images::{self, Variant},
};

const HOME_HTML: &str = include_str!("../../static/home.html");
const ADMIN_HTML: &str = include_str!("../../static/admin.html");
const BOARD_HTML: &str = include_str!("../../static/board.html");

/// Front-end files compiled into the binary, so deploying is one file.
const ASSETS: &[(&str, &str, &[u8])] = &[
    ("app.css", "text/css; charset=utf-8", include_bytes!("../../static/app.css")),
    ("common.js", "text/javascript; charset=utf-8", include_bytes!("../../static/common.js")),
    ("board.css", "text/css; charset=utf-8", include_bytes!("../../static/board.css")),
    ("board-core.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board-core.js")),
    ("board-render.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board-render.js")),
    ("board-tools.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board-tools.js")),
    ("board-ui.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board-ui.js")),
    ("board-main.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board-main.js")),
    ("admin.js", "text/javascript; charset=utf-8", include_bytes!("../../static/admin.js")),
    ("favicon.svg", "image/svg+xml", include_bytes!("../../static/favicon.svg")),
    ("space-grotesk.woff2", "font/woff2", include_bytes!("../../static/fonts/space-grotesk-latin-wght-normal.woff2")),
    (
        "space-grotesk-ext.woff2",
        "font/woff2",
        include_bytes!("../../static/fonts/space-grotesk-latin-ext-wght-normal.woff2"),
    ),
];

pub async fn home() -> Html<&'static str> {
    Html(HOME_HTML)
}

pub async fn admin() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Html(ADMIN_HTML))
}

pub async fn board(Path(slug): Path<String>) -> Response {
    let status = if valid_slug(&slug) { StatusCode::OK } else { StatusCode::NOT_FOUND };
    (status, [(header::CACHE_CONTROL, "no-store")], Html(BOARD_HTML)).into_response()
}

pub async fn asset(Path(file): Path<String>) -> Response {
    match ASSETS.iter().find(|(name, _, _)| *name == file) {
        Some((_, mime, bytes)) => (
            [
                (header::CONTENT_TYPE, *mime),
                // Short cache: a redeploy should reach clients quickly.
                (header::CACHE_CONTROL, "public, max-age=300"),
            ],
            *bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serve an uploaded image, after checking the viewer may see its board.
pub async fn file(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((asset_id, variant)): Path<(i64, String)>,
) -> ApiResult<Response> {
    let variant = Variant::parse(&variant).ok_or(AppError::NotFound)?;
    let (board, key, mime, display_mime, original_name) = state
        .db
        .call(move |c| {
            let (board_id, key, mime, display_mime, name): (i64, String, String, String, String) = c.query_row(
                "SELECT board_id, file_key, mime, display_mime, original_name FROM assets WHERE id = ?1",
                [asset_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;
            Ok((board_access_by_id(c, board_id)?, key, mime, display_mime, name))
        })
        .await?;
    let role = match auth::role_for(&state, &jar, &board).await {
        Ok(role) => role,
        Err(AppError::PasscodeRequired) => return Err(AppError::NotFound),
        Err(e) => return Err(e),
    };
    // Full-resolution originals are for people who can edit.
    if variant == Variant::Original && role < Role::Edit {
        return Err(AppError::NotFound);
    }

    let served_mime = if variant == Variant::Original { mime } else { display_mime };
    let path = images::path_for(&state.images_dir, &key, variant, &served_mime);
    let bytes = tokio::fs::read(&path).await.map_err(|_| AppError::NotFound)?;

    let mut res = Response::new(Body::from(bytes));
    let headers = res.headers_mut();
    headers
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(&served_mime).map_err(|e| AppError::Internal(e.into()))?);
    // File keys are random and files never change, so browsers may keep them.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    if variant == Variant::Original {
        let safe: String = original_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' })
            .collect();
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{safe}\"")) {
            headers.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(res)
}
