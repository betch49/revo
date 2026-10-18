pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod images;
mod routes;

use std::{path::PathBuf, sync::Arc};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    http::{HeaderName, HeaderValue, Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::{auth::Throttle, config::Config, db::Db, error::AppError};

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub images_dir: PathBuf,
    pub throttle: Arc<Throttle>,
}

impl AppState {
    pub fn new(db: Db, config: Config) -> anyhow::Result<Self> {
        let images_dir = config.data_dir.join("images");
        std::fs::create_dir_all(&images_dir)?;
        Ok(Self { db, config: Arc::new(config), images_dir, throttle: Arc::default() })
    }
}

const CSP: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; \
    font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; \
    frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

pub fn app(state: AppState) -> Router {
    // One upload per request; leave a little room for multipart framing.
    let body_limit = (state.config.max_upload_mb + 1) * 1024 * 1024;
    let api =
        routes::api_router().layer(middleware::from_fn(require_api_header)).layer(DefaultBodyLimit::max(body_limit));

    Router::new()
        .nest("/api", api)
        .merge(routes::page_router())
        .with_state(state)
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
}

/// CSRF guard: state-changing API calls must carry `X-Revo: 1`. Browsers only
/// let other sites send custom headers after a CORS preflight, which this
/// server never approves, so forged cross-site requests are rejected.
async fn require_api_header(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && req.headers().get("x-revo").is_none_or(|v| v != "1") {
        return AppError::bad("Missing X-Revo header").into_response();
    }
    next.run(req).await
}
