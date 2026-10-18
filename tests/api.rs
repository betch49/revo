use std::path::PathBuf;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use revo::{AppState, app, auth::hash_password, config::Config, db::Db};
use serde_json::{Value, json};
use tower::ServiceExt;

const ADMIN_PASSWORD: &str = "correct horse battery";

struct TestApp {
    router: Router,
    data_dir: PathBuf,
}

impl Drop for TestApp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

struct Res {
    status: StatusCode,
    cookie: Option<String>,
    json: Value,
    bytes: Vec<u8>,
}

fn setup() -> TestApp {
    let data_dir = std::env::temp_dir().join(format!("revo-test-{}", revo::auth::random_token(8)));
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        data_dir: data_dir.clone(),
        admin_password_hash: hash_password(ADMIN_PASSWORD).unwrap(),
        cookie_secure: true,
        max_upload_mb: 5,
        public_url: "https://review.example".into(),
    };
    let state = AppState::new(Db::open_in_memory().unwrap(), config).unwrap();
    TestApp { router: app(state), data_dir }
}

impl TestApp {
    async fn send(&self, req: Request<Body>) -> Res {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let cookie =
            res.headers().get(header::SET_COOKIE).map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Res { status, cookie, json, bytes }
    }

    async fn json(&self, method: &str, uri: &str, cookie: Option<&str>, body: Option<Value>) -> Res {
        let mut req = Request::builder().method(method).uri(uri).header("x-revo", "1");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let body = match body {
            Some(b) => {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        self.send(req.body(body).unwrap()).await
    }

    async fn upload(&self, uri: &str, cookie: &str, files: &[(&str, Vec<u8>)]) -> Res {
        let boundary = "revoTestBoundary";
        let mut body = Vec::new();
        for (name, bytes) in files {
            body.extend_from_slice(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            );
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("x-revo", "1")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .unwrap();
        self.send(req).await
    }

    async fn login(&self) -> String {
        let res = self.json("POST", "/api/admin/login", None, Some(json!({ "password": ADMIN_PASSWORD }))).await;
        assert_eq!(res.status, StatusCode::OK);
        res.cookie.expect("login sets a cookie")
    }
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[tokio::test]
async fn admin_routes_need_login_and_csrf_header() {
    let t = setup();
    assert_eq!(t.json("GET", "/api/admin/boards", None, None).await.status, StatusCode::UNAUTHORIZED);

    let res = t.json("POST", "/api/admin/login", None, Some(json!({ "password": "nope" }))).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.cookie.is_none());

    // Without the X-Revo header a state-changing call is refused, even when signed in.
    let cookie = t.login().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/admin/boards")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "slug": "csrf", "title": "x" }).to_string()))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::BAD_REQUEST);

    let res = t.json("GET", "/api/admin/session", Some(&cookie), None).await;
    assert_eq!(res.json["admin"], true);
    t.json("POST", "/api/admin/logout", Some(&cookie), None).await;
    assert_eq!(t.json("GET", "/api/admin/boards", Some(&cookie), None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn slugs_are_validated_and_unique() {
    let t = setup();
    let admin = t.login().await;
    for bad in ["ab", "admin", "files", "-dash", "with space", "x/y"] {
        let res = t.json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "slug": bad, "title": "T" }))).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let ok =
        t.json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "slug": "acme-co", "title": "Acme" }))).await;
    assert_eq!(ok.status, StatusCode::OK);
    let dup =
        t.json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "slug": "acme-co", "title": "Again" }))).await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn full_review_flow_with_versions() {
    let t = setup();
    let admin = t.login().await;

    let board = t
        .json(
            "POST",
            "/api/admin/boards",
            Some(&admin),
            Some(json!({ "slug": "lumen", "title": "Atelier Lumen", "passcode": "spring26" })),
        )
        .await;
    let board_id = board.json["id"].as_i64().unwrap();

    let up = t.upload(&format!("/api/admin/boards/{board_id}/images"), &admin, &[("hero_shot.png", png(64, 32))]).await;
    assert_eq!(up.status, StatusCode::OK, "{:?}", up.json);
    let image_id = up.json["ids"][0].as_i64().unwrap();

    // Not a real image.
    let bad = t.upload(&format!("/api/admin/boards/{board_id}/images"), &admin, &[("x.png", b"hello".to_vec())]).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // A client without the passcode sees nothing, files included.
    let locked = t.json("GET", "/api/b/lumen", None, None).await;
    assert_eq!(locked.status, StatusCode::UNAUTHORIZED);
    assert_eq!(locked.json["error"], "passcode_required");

    let wrong = t.json("POST", "/api/b/lumen/unlock", None, Some(json!({ "passcode": "nope" }))).await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    let unlocked = t.json("POST", "/api/b/lumen/unlock", None, Some(json!({ "passcode": "spring26" }))).await;
    let client = unlocked.cookie.expect("unlock sets a cookie");

    let view = t.json("GET", "/api/b/lumen", Some(&client), None).await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(view.json["is_admin"], false);
    let image = &view.json["images"][0];
    assert_eq!(image["title"], "hero shot");
    let v1 = image["versions"][0]["id"].as_i64().unwrap();
    assert_eq!(image["versions"][0]["px_width"], 64);

    // Display copy is visible to the client; the original is admin-only.
    let file = t.json("GET", &format!("/files/{v1}/display"), Some(&client), None).await;
    assert_eq!(file.status, StatusCode::OK);
    assert!(!file.bytes.is_empty());
    assert_eq!(t.json("GET", &format!("/files/{v1}/display"), None, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        t.json("GET", &format!("/files/{v1}/original"), Some(&client), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(t.json("GET", &format!("/files/{v1}/original"), Some(&admin), None).await.status, StatusCode::OK);

    // Comment pin, reply, decision.
    let no_pin = t
        .json(
            "POST",
            "/api/b/lumen/comments",
            Some(&client),
            Some(json!({ "version_id": v1, "author": "Anna", "body": "Hi" })),
        )
        .await;
    assert_eq!(no_pin.status, StatusCode::BAD_REQUEST);
    let root = t
        .json(
            "POST",
            "/api/b/lumen/comments",
            Some(&client),
            Some(json!({ "version_id": v1, "x": 0.25, "y": 0.5, "author": "Anna", "body": "Warmer skin tones here" })),
        )
        .await;
    assert_eq!(root.status, StatusCode::OK);
    let root_id = root.json["id"].as_i64().unwrap();
    let reply = t
        .json(
            "POST",
            "/api/b/lumen/comments",
            Some(&admin),
            Some(json!({ "version_id": v1, "parent_id": root_id, "body": "On it" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let status = t
        .json(
            "POST",
            &format!("/api/b/lumen/versions/{v1}/status"),
            Some(&client),
            Some(json!({ "status": "changes_requested", "author": "Anna" })),
        )
        .await;
    assert_eq!(status.status, StatusCode::OK);

    // Clients cannot resolve; the admin can.
    let res = t
        .json(
            "POST",
            &format!("/api/admin/comments/{root_id}/resolve"),
            Some(&client),
            Some(json!({ "resolved": true })),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = t
        .json(
            "POST",
            &format!("/api/admin/comments/{root_id}/resolve"),
            Some(&admin),
            Some(json!({ "resolved": true })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // A new version starts clean; the old one keeps its comments and decision.
    let v2 = t.upload(&format!("/api/admin/images/{image_id}/versions"), &admin, &[("hero_v2.png", png(80, 40))]).await;
    assert_eq!(v2.status, StatusCode::OK, "{:?}", v2.json);
    assert_eq!(v2.json["number"], 2);

    let view = t.json("GET", "/api/b/lumen", Some(&client), None).await;
    let versions = view.json["images"][0]["versions"].as_array().unwrap().clone();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0]["status"], "changes_requested");
    assert_eq!(versions[0]["status_by"], "Anna");
    assert_eq!(versions[0]["comments"].as_array().unwrap().len(), 2);
    assert!(versions[0]["comments"][0]["resolved_at"].is_i64());
    assert_eq!(versions[0]["comments"][1]["author"], "Betch");
    assert_eq!(versions[0]["comments"][1]["is_admin"], true);
    assert_eq!(versions[1]["status"], "pending");
    assert_eq!(versions[1]["comments"].as_array().unwrap().len(), 0);

    // Arrange.
    let res = t
        .json(
            "PATCH",
            &format!("/api/admin/images/{image_id}"),
            Some(&admin),
            Some(json!({ "x": 10.0, "y": 20.0, "width": 400.0 })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let view = t.json("GET", "/api/b/lumen", Some(&client), None).await;
    assert_eq!(view.json["images"][0]["width"], 400.0);

    // Changing the passcode signs the client out.
    t.json("PATCH", &format!("/api/admin/boards/{board_id}"), Some(&admin), Some(json!({ "passcode": "summer26" })))
        .await;
    assert_eq!(t.json("GET", "/api/b/lumen", Some(&client), None).await.status, StatusCode::UNAUTHORIZED);

    // Deleting the board removes it and its files.
    let images_dir = t.data_dir.join("images");
    assert!(std::fs::read_dir(&images_dir).unwrap().count() > 0);
    let res = t.json("DELETE", &format!("/api/admin/boards/{board_id}"), Some(&admin), None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(std::fs::read_dir(&images_dir).unwrap().count(), 0);
    assert_eq!(t.json("GET", "/api/b/lumen", Some(&admin), None).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn open_board_needs_no_passcode_and_comments_need_a_name() {
    let t = setup();
    let admin = t.login().await;
    let board =
        t.json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "slug": "open-board", "title": "Open" }))).await;
    let board_id = board.json["id"].as_i64().unwrap();
    t.upload(&format!("/api/admin/boards/{board_id}/images"), &admin, &[("a.png", png(10, 10))]).await;

    let view = t.json("GET", "/api/b/open-board", None, None).await;
    assert_eq!(view.status, StatusCode::OK);
    let v1 = view.json["images"][0]["versions"][0]["id"].as_i64().unwrap();
    let res = t
        .json(
            "POST",
            "/api/b/open-board/comments",
            None,
            Some(json!({ "version_id": v1, "x": 0.5, "y": 0.5, "body": "Hi" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // A version from another board is rejected.
    let other = t
        .json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "slug": "other-board", "title": "Other" })))
        .await;
    let other_id = other.json["id"].as_i64().unwrap();
    t.upload(&format!("/api/admin/boards/{other_id}/images"), &admin, &[("b.png", png(10, 10))]).await;
    let res = t
        .json(
            "POST",
            "/api/b/open-board/comments",
            None,
            Some(json!({ "version_id": v1 + 1, "x": 0.5, "y": 0.5, "body": "Hi", "author": "Eve" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn passcode_guessing_is_throttled() {
    let t = setup();
    let admin = t.login().await;
    t.json(
        "POST",
        "/api/admin/boards",
        Some(&admin),
        Some(json!({ "slug": "locked", "title": "L", "passcode": "secret" })),
    )
    .await;
    let mut last = StatusCode::OK;
    for _ in 0..9 {
        last = t.json("POST", "/api/b/locked/unlock", None, Some(json!({ "passcode": "guess" }))).await.status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
