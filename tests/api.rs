use std::{path::PathBuf, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use revo::{AppState, app, auth::hash_password, config::Config, db::Db};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;

const ADMIN_PASSWORD: &str = "correct horse battery";

struct TestApp {
    state: AppState,
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
        public_url: "https://boards.example".into(),
    };
    let state = AppState::new(Db::open_in_memory().unwrap(), config).unwrap();
    TestApp { router: app(state.clone()), state, data_dir }
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

    async fn upload(&self, uri: &str, cookie: Option<&str>, name: &str, bytes: Vec<u8>) -> Res {
        let boundary = "revoTestBoundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(&bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("x-revo", "1")
            .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"));
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        self.send(req.body(Body::from(body)).unwrap()).await
    }

    async fn login(&self) -> String {
        let res = self.json("POST", "/api/admin/login", None, Some(json!({ "password": ADMIN_PASSWORD }))).await;
        assert_eq!(res.status, StatusCode::OK);
        res.cookie.expect("login sets a cookie")
    }

    async fn board(&self, admin: &str, title: &str) -> (i64, String) {
        let res = self.json("POST", "/api/admin/boards", Some(admin), Some(json!({ "title": title }))).await;
        assert_eq!(res.status, StatusCode::OK, "{:?}", res.json);
        (res.json["id"].as_i64().unwrap(), res.json["slug"].as_str().unwrap().to_string())
    }

    async fn share(&self, admin: &str, id: i64, patch: Value) {
        let res = self.json("PATCH", &format!("/api/admin/boards/{id}"), Some(admin), Some(patch)).await;
        assert_eq!(res.status, StatusCode::OK, "{:?}", res.json);
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

    let cookie = t.login().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/admin/boards")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "title": "x" }).to_string()))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::BAD_REQUEST, "missing X-Revo header");

    t.json("POST", "/api/admin/logout", Some(&cookie), None).await;
    assert_eq!(t.json("GET", "/api/admin/boards", Some(&cookie), None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn board_links_come_from_titles_and_stay_unique() {
    let t = setup();
    let admin = t.login().await;
    assert_eq!(t.board(&admin, "Café Mila — Menu").await.1, "cafe-mila-menu");
    assert_eq!(t.board(&admin, "Café Mila — Menu").await.1, "cafe-mila-menu-2");
    let bad = t.json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "title": "T", "slug": "admin" }))).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let dup = t
        .json("POST", "/api/admin/boards", Some(&admin), Some(json!({ "title": "T", "slug": "cafe-mila-menu" })))
        .await;
    assert_eq!(dup.status, StatusCode::CONFLICT);
    let list = t.json("GET", "/api/admin/boards", Some(&admin), None).await;
    assert_eq!(list.json.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn sharing_controls_who_gets_in_and_what_they_can_do() {
    let t = setup();
    let admin = t.login().await;
    let (id, slug) = t.board(&admin, "Workshop").await;
    let url = format!("/api/b/{slug}");

    // New boards are private.
    assert_eq!(t.json("GET", &url, None, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.json("GET", &url, Some(&admin), None).await.json["role"], "owner");

    t.share(&admin, id, json!({ "access": "view" })).await;
    assert_eq!(t.json("GET", &url, None, None).await.json["role"], "view");
    let comment = json!({ "x": 10.0, "y": 20.0, "author": "Anna", "body": "Nice" });
    assert_eq!(
        t.json("POST", &format!("{url}/comments"), None, Some(comment.clone())).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(t.upload(&format!("{url}/assets"), None, "a.png", png(8, 8)).await.status, StatusCode::FORBIDDEN);

    t.share(&admin, id, json!({ "access": "comment" })).await;
    let c = t.json("POST", &format!("{url}/comments"), None, Some(comment)).await;
    assert_eq!(c.status, StatusCode::OK, "{:?}", c.json);
    let root = c.json["id"].as_i64().unwrap();
    let reply = t
        .json(
            "POST",
            &format!("{url}/comments"),
            None,
            Some(json!({ "parent_id": root, "author": "Marc", "body": "Agreed" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let resolved =
        t.json("POST", &format!("{url}/comments/{root}/resolve"), None, Some(json!({ "resolved": true }))).await;
    assert!(resolved.json["resolved_at"].is_i64());
    assert_eq!(t.json("DELETE", &format!("{url}/comments/{root}"), None, None).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.json("DELETE", &format!("{url}/comments/{root}"), Some(&admin), None).await.status, StatusCode::OK);

    // A passcode gates the link; changing it signs people out.
    t.share(&admin, id, json!({ "access": "edit", "passcode": "mila" })).await;
    let locked = t.json("GET", &url, None, None).await;
    assert_eq!(locked.json["error"], "passcode_required");
    assert_eq!(
        t.json("POST", &format!("{url}/unlock"), None, Some(json!({ "passcode": "nope" }))).await.status,
        StatusCode::BAD_REQUEST
    );
    let guest =
        t.json("POST", &format!("{url}/unlock"), None, Some(json!({ "passcode": "mila" }))).await.cookie.unwrap();
    assert_eq!(t.json("GET", &url, Some(&guest), None).await.json["role"], "edit");
    t.share(&admin, id, json!({ "passcode": "new-one" })).await;
    assert_eq!(t.json("GET", &url, Some(&guest), None).await.status, StatusCode::UNAUTHORIZED);

    // Back to private: the link stops working, even with a passcode.
    t.share(&admin, id, json!({ "access": "private" })).await;
    assert_eq!(
        t.json("POST", &format!("{url}/unlock"), None, Some(json!({ "passcode": "new-one" }))).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn images_upload_duplicate_and_delete() {
    let t = setup();
    let admin = t.login().await;
    let (id, slug) = t.board(&admin, "Moodboard").await;

    let up = t.upload(&format!("/api/b/{slug}/assets"), Some(&admin), "photo.png", png(64, 32)).await;
    assert_eq!(up.status, StatusCode::OK, "{:?}", up.json);
    assert_eq!(up.json["w"], 64);
    let asset = up.json["id"].as_i64().unwrap();
    let bad = t.upload(&format!("/api/b/{slug}/assets"), Some(&admin), "x.png", b"hello".to_vec()).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // Files follow the board's sharing.
    assert_eq!(t.json("GET", &format!("/files/{asset}/display"), None, None).await.status, StatusCode::NOT_FOUND);
    t.share(&admin, id, json!({ "access": "view" })).await;
    let file = t.json("GET", &format!("/files/{asset}/display"), None, None).await;
    assert_eq!(file.status, StatusCode::OK);
    assert!(!file.bytes.is_empty());
    assert_eq!(t.json("GET", &format!("/files/{asset}/original"), None, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.json("GET", &format!("/files/{asset}/original"), Some(&admin), None).await.status, StatusCode::OK);

    // Put an image item on the board through the same code the live connection uses.
    let ops = revo::items::parse_ops(&json!([
        { "put": { "id": "img1", "type": "image", "asset": asset, "x": 0, "y": 0, "w": 64, "h": 32 } },
        { "put": { "id": "note1", "type": "sticky", "x": 100, "y": 0, "w": 200, "h": 200, "text": "Hi" } }
    ]))
    .unwrap();
    t.state.db.call(move |c| revo::items::apply(c, id, &ops)).await.unwrap();

    let copy = t.json("POST", &format!("/api/admin/boards/{id}/duplicate"), Some(&admin), None).await;
    assert_eq!(copy.status, StatusCode::OK);
    assert_eq!(copy.json["slug"], "moodboard-copy");
    assert_eq!(copy.json["access"], "private");
    let copy_id = copy.json["id"].as_i64().unwrap();
    let items = t.state.db.call(move |c| revo::items::load(c, copy_id)).await.unwrap();
    assert_eq!(items.len(), 2);
    let copied_asset = items.iter().find(|i| i["type"] == "image").unwrap()["asset"].as_i64().unwrap();
    assert_ne!(copied_asset, asset, "the copy gets its own asset row");

    // Deleting the original keeps the files the copy still uses.
    let images_dir = t.data_dir.join("images");
    let files_before = std::fs::read_dir(&images_dir).unwrap().count();
    assert_eq!(t.json("DELETE", &format!("/api/admin/boards/{id}"), Some(&admin), None).await.status, StatusCode::OK);
    assert_eq!(std::fs::read_dir(&images_dir).unwrap().count(), files_before);
    assert_eq!(
        t.json("GET", &format!("/files/{copied_asset}/display"), Some(&admin), None).await.status,
        StatusCode::OK
    );
    assert_eq!(
        t.json("DELETE", &format!("/api/admin/boards/{copy_id}"), Some(&admin), None).await.status,
        StatusCode::OK
    );
    assert_eq!(std::fs::read_dir(&images_dir).unwrap().count(), 0);
}

#[tokio::test]
async fn passcode_guessing_is_throttled() {
    let t = setup();
    let admin = t.login().await;
    let (id, slug) = t.board(&admin, "Locked").await;
    t.share(&admin, id, json!({ "access": "view", "passcode": "secret" })).await;
    let mut last = StatusCode::OK;
    for _ in 0..9 {
        last =
            t.json("POST", &format!("/api/b/{slug}/unlock"), None, Some(json!({ "passcode": "guess" }))).await.status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

// ---------------------------------------------------------------- live collaboration

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn serve(t: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(t.state.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr.to_string()
}

async fn ws_connect(addr: &str, slug: &str, cookie: Option<&str>, origin: &str) -> Result<Socket, tungstenite::Error> {
    let mut req = format!("ws://{addr}/api/b/{slug}/ws").into_client_request().unwrap();
    req.headers_mut().insert("origin", origin.parse().unwrap());
    if let Some(c) = cookie {
        req.headers_mut().insert("cookie", c.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s)
}

async fn send(ws: &mut Socket, v: Value) {
    ws.send(tungstenite::Message::Text(v.to_string().into())).await.unwrap();
}

/// Next JSON message, skipping types we don't care about.
async fn next(ws: &mut Socket, skip: &[&str]) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out").unwrap().unwrap();
        if let tungstenite::Message::Text(t) = msg {
            let v: Value = serde_json::from_str(t.as_str()).unwrap();
            if !skip.contains(&v["t"].as_str().unwrap_or("")) {
                return v;
            }
        }
    }
}

#[tokio::test]
async fn live_edits_reach_others_and_are_saved() {
    let t = setup();
    let admin = t.login().await;
    let (id, slug) = t.board(&admin, "Live").await;
    let addr = serve(&t).await;
    let origin = format!("http://{addr}");

    // Private board: a guest can't connect; another site can't connect either.
    assert!(ws_connect(&addr, &slug, None, &origin).await.is_err());
    assert!(ws_connect(&addr, &slug, Some(&admin), "https://evil.example").await.is_err());

    let mut owner = ws_connect(&addr, &slug, Some(&admin), &origin).await.unwrap();
    send(&mut owner, json!({ "t": "hello", "name": "Betch", "color": "#63d9dd" })).await;
    let welcome = next(&mut owner, &[]).await;
    assert_eq!(welcome["t"], "welcome");
    assert_eq!(welcome["you"]["role"], "owner");
    assert_eq!(welcome["items"].as_array().unwrap().len(), 0);

    t.share(&admin, id, json!({ "access": "edit" })).await;
    assert_eq!(next(&mut owner, &[]).await["t"], "reload");

    let mut guest = ws_connect(&addr, &slug, None, &origin).await.unwrap();
    send(&mut guest, json!({ "t": "hello", "name": "Anna", "color": "#f97316" })).await;
    let gw = next(&mut guest, &[]).await;
    assert_eq!(gw["you"]["role"], "edit");
    assert_eq!(gw["peers"][0]["name"], "Betch");
    let joined = next(&mut owner, &[]).await;
    assert_eq!(joined["t"], "peer");
    assert_eq!(joined["peer"]["name"], "Anna");

    // A live (dragging) change is relayed but not saved; the final one is saved.
    let note = json!({ "id": "n1", "type": "sticky", "x": 0, "y": 0, "w": 200, "h": 200, "text": "Hi" });
    send(&mut guest, json!({ "t": "ops", "live": true, "ops": [{ "put": note }] })).await;
    let live = next(&mut owner, &["cursor"]).await;
    assert_eq!(live["live"], true);
    assert!(t.state.db.call(move |c| revo::items::load(c, id)).await.unwrap().is_empty());
    send(&mut guest, json!({ "t": "ops", "ops": [{ "put": note }] })).await;
    let saved = next(&mut owner, &["cursor"]).await;
    assert_eq!(saved["ops"][0]["put"]["text"], "Hi");
    assert_eq!(t.state.db.call(move |c| revo::items::load(c, id)).await.unwrap().len(), 1);

    // Cursors are relayed with the sender's id.
    send(&mut guest, json!({ "t": "cursor", "x": 12.5, "y": 40.0 })).await;
    let cur = next(&mut owner, &[]).await;
    assert_eq!(cur["t"], "cursor");
    assert_eq!(cur["x"], 12.5);

    // Invalid items are refused and the sender is told to resync.
    send(&mut guest, json!({ "t": "ops", "ops": [{ "put": { "id": "bad id", "type": "sticky" } }] })).await;
    assert_eq!(next(&mut guest, &[]).await["t"], "error");
    assert_eq!(next(&mut guest, &[]).await["t"], "resync");

    // Comments made over HTTP show up live.
    let c = t
        .json(
            "POST",
            &format!("/api/b/{slug}/comments"),
            None,
            Some(json!({ "x": 1.0, "y": 2.0, "author": "Anna", "body": "Hello" })),
        )
        .await;
    assert_eq!(c.status, StatusCode::OK);
    assert_eq!(next(&mut owner, &[]).await["comment"]["body"], "Hello");

    // A viewer can watch but not edit.
    t.share(&admin, id, json!({ "access": "view" })).await;
    let mut viewer = ws_connect(&addr, &slug, None, &origin).await.unwrap();
    send(&mut viewer, json!({ "t": "hello", "name": "Marc" })).await;
    let vw = next(&mut viewer, &[]).await;
    assert_eq!(vw["items"][0]["id"], "n1");
    send(&mut viewer, json!({ "t": "ops", "ops": [{ "del": "n1" }] })).await;
    assert_eq!(next(&mut viewer, &["peer"]).await["t"], "error");
    assert_eq!(t.state.db.call(move |c| revo::items::load(c, id)).await.unwrap().len(), 1);
    drop(guest);
}
