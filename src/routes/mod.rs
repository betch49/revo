mod admin;
mod board;
mod pages;

use axum::{
    Router,
    routing::{delete, get, patch, post},
};

use crate::AppState;

pub fn api_router() -> Router<AppState> {
    Router::new()
        // Admin session
        .route("/admin/session", get(admin::session))
        .route("/admin/login", post(admin::login))
        .route("/admin/logout", post(admin::logout))
        // Boards
        .route("/admin/boards", get(admin::list_boards).post(admin::create_board))
        .route("/admin/boards/{id}", patch(admin::update_board).delete(admin::delete_board))
        .route("/admin/boards/{id}/images", post(admin::upload_images))
        // Images and versions
        .route("/admin/images/{id}", patch(admin::update_image).delete(admin::delete_image))
        .route("/admin/images/{id}/versions", post(admin::upload_version))
        // Comments
        .route("/admin/comments/{id}/resolve", post(admin::resolve_comment))
        .route("/admin/comments/{id}", delete(admin::delete_comment))
        // Client side of a board
        .route("/b/{slug}", get(board::get_board))
        .route("/b/{slug}/rev", get(board::get_rev))
        .route("/b/{slug}/unlock", post(board::unlock))
        .route("/b/{slug}/comments", post(board::add_comment))
        .route("/b/{slug}/versions/{vid}/status", post(board::set_status))
}

pub fn page_router() -> Router<AppState> {
    Router::new()
        .route("/", get(pages::home))
        .route("/healthz", get(|| async { "ok" }))
        .route("/admin", get(pages::admin))
        .route("/static/{file}", get(pages::asset))
        .route("/files/{vid}/{variant}", get(pages::file))
        .route("/{slug}", get(pages::board))
}

/// Board URLs are `review.betch.ch/<slug>`: lowercase letters, digits and
/// dashes, without clashing with the app's own paths.
pub fn valid_slug(slug: &str) -> bool {
    const RESERVED: &[&str] = &["admin", "api", "static", "files", "healthz", "robots.txt"];
    (3..=64).contains(&slug.len())
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !RESERVED.contains(&slug)
}

/// Trim and length-check a text field.
pub fn clean_text(value: &str, field: &str, max: usize) -> Result<String, crate::error::AppError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(crate::error::AppError::bad(format!("{field} is required")));
    }
    if v.chars().count() > max {
        return Err(crate::error::AppError::bad(format!("{field} is too long (max {max} characters)")));
    }
    Ok(v.to_string())
}
