//! WebSocket session for live editing.
//!
//! Protocol (JSON text frames):
//! - client → server: `hello {name, color}` (first), `ops {ops, live?}`,
//!   `cursor {x, y}`, `sel {ids}`, `ping`
//! - server → client: `welcome {you, peers, items, comments}`, `ops {from, ops, live}`,
//!   `peer`, `peer_left`, `cursor`, `sel`, `comment`, `comment_deleted`, `board`,
//!   `reload`, `resync`, `error`, `pong`
//!
//! Ops with `live: true` are relayed but not stored (dragging, drawing); the
//! final state is sent again without the flag and saved.

use std::time::Duration;

use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use axum_extra::extract::CookieJar;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast::error::RecvError, mpsc};

use super::board::{authorize, load_comments};
use crate::{
    AppState,
    auth::Role,
    error::{ApiResult, AppError},
    hub::Peer,
    items,
};

const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

pub async fn connect(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Path(slug): Path<String>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    if !same_origin(&headers) {
        return Err(AppError::Forbidden("Cross-site connections are not allowed.".into()));
    }
    let (board_id, role) = authorize(&state, &jar, slug).await?;
    Ok(ws.max_message_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| session(state, board_id, role, socket)))
}

/// Browsers always send Origin on WebSocket requests; refuse other sites so a
/// malicious page can't drive a visitor's session.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    origin.split_once("://").map(|(_, rest)| rest) == Some(host)
}

#[derive(Deserialize)]
struct Hello {
    name: Option<String>,
    color: Option<String>,
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

async fn session(state: AppState, board_id: i64, role: Role, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // The first message introduces the visitor.
    let hello = match tokio::time::timeout(Duration::from_secs(10), stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Hello>(t.as_str()).ok(),
        _ => None,
    };
    let Some(hello) = hello else { return };
    let name: String = hello.name.unwrap_or_default().trim().chars().filter(|c| !c.is_control()).take(40).collect();
    let color = hello
        .color
        .filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or_else(|| "#63d9dd".into());
    let peer =
        Peer { id: state.hub.next_peer_id(), name: if name.is_empty() { "Guest".into() } else { name }, color, role };
    let me = peer.id;
    let (mut rx, peers) = state.hub.join(board_id, peer.clone());

    let snapshot = state.db.call(move |c| Ok((items::load(c, board_id)?, load_comments(c, board_id)?))).await;
    let Ok((items, comments)) = snapshot else {
        state.hub.leave(board_id, me);
        return;
    };
    let welcome = json!({ "t": "welcome", "you": peer, "peers": peers, "items": items, "comments": comments });
    if sink.send(text(welcome)).await.is_err() {
        state.hub.leave(board_id, me);
        return;
    }

    // Everything going out to this browser goes through one task.
    let (direct_tx, mut direct_rx) = mpsc::channel::<Value>(32);
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(m) if m.from == me => {}
                    Ok(m) => {
                        if sink.send(Message::Text(m.text.as_ref().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        // Too far behind to catch up message by message.
                        let _ = sink.send(text(json!({ "t": "resync" }))).await;
                        break;
                    }
                    Err(RecvError::Closed) => break,
                },
                direct = direct_rx.recv() => match direct {
                    Some(v) => {
                        if sink.send(text(v)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
        let _ = sink.close().await;
    });

    let recv = async {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(t) = msg else {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
            handle(&state, board_id, role, me, v, &direct_tx).await;
        }
    };
    tokio::select! {
        _ = &mut send_task => {}
        _ = recv => {}
    }
    send_task.abort();
    state.hub.leave(board_id, me);
}

async fn handle(state: &AppState, board_id: i64, role: Role, me: u64, v: Value, direct: &mpsc::Sender<Value>) {
    match v.get("t").and_then(Value::as_str) {
        Some("cursor") => {
            let (x, y) = (v.get("x").and_then(Value::as_f64), v.get("y").and_then(Value::as_f64));
            state.hub.send(board_id, me, json!({ "t": "cursor", "id": me, "x": x, "y": y }).to_string());
        }
        Some("sel") => {
            let ids: Vec<&str> = v
                .get("ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter(|id| items::valid_id(id)).take(500).collect())
                .unwrap_or_default();
            state.hub.send(board_id, me, json!({ "t": "sel", "id": me, "ids": ids }).to_string());
        }
        Some("ops") => {
            if role < Role::Edit {
                let _ = direct.send(json!({ "t": "error", "message": "This board is view-only for you." })).await;
                return;
            }
            let raw = v.get("ops").cloned().unwrap_or(Value::Null);
            let ops = match items::parse_ops(&raw) {
                Ok(ops) => ops,
                Err(e) => {
                    let _ = direct.send(json!({ "t": "error", "message": e })).await;
                    let _ = direct.send(json!({ "t": "resync" })).await;
                    return;
                }
            };
            let live = v.get("live").and_then(Value::as_bool).unwrap_or(false);
            if !live && let Err(e) = state.db.call(move |c| items::apply(c, board_id, &ops)).await {
                let _ = direct.send(json!({ "t": "error", "message": e.to_string() })).await;
                let _ = direct.send(json!({ "t": "resync" })).await;
                return;
            }
            state.hub.send(board_id, me, json!({ "t": "ops", "from": me, "ops": raw, "live": live }).to_string());
        }
        Some("ping") => {
            let _ = direct.send(json!({ "t": "pong" })).await;
        }
        _ => {}
    }
}
