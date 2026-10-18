use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use axum_extra::extract::CookieJar;

use super::valid_slug;
use crate::{
    AppState, auth,
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
    ("board.js", "text/javascript; charset=utf-8", include_bytes!("../../static/board.js")),
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

/// Serve an image file, after checking the viewer may see its board.
pub async fn file(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((version_id, variant)): Path<(i64, String)>,
) -> ApiResult<Response> {
    let variant = Variant::parse(&variant).ok_or(AppError::NotFound)?;
    let (board_id, has_passcode, key, mime, display_mime, original_name): (i64, bool, String, String, String, String) =
        state
            .db
            .call(move |c| {
                Ok(c.query_row(
                    "SELECT b.id, b.passcode_hash IS NOT NULL, v.file_key, v.mime, v.display_mime, v.original_name
                     FROM image_versions v JOIN images i ON i.id = v.image_id JOIN boards b ON b.id = i.board_id
                     WHERE v.id = ?1",
                    [version_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )?)
            })
            .await?;
    let admin = auth::is_admin(&state, &jar).await?;
    if !auth::can_view(&state, &jar, board_id, has_passcode, admin).await? {
        return Err(AppError::NotFound);
    }
    // Full-resolution originals are for the admin; clients review the web copy.
    if variant == Variant::Original && !admin {
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
