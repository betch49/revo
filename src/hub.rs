//! Live collaboration: one broadcast channel per open board.
//!
//! Every connected browser is a peer. Messages are JSON strings tagged with the
//! sender, so a peer never receives its own edits back.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;

/// Sender id used for messages that come from the server itself.
pub const SERVER: u64 = 0;
const CHANNEL_CAPACITY: usize = 512;

#[derive(Clone, Debug, Serialize)]
pub struct Peer {
    pub id: u64,
    pub name: String,
    pub color: String,
    pub role: crate::auth::Role,
}

#[derive(Clone, Debug)]
pub struct Msg {
    pub from: u64,
    pub text: Arc<str>,
}

struct Room {
    tx: broadcast::Sender<Msg>,
    peers: HashMap<u64, Peer>,
}

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<HashMap<i64, Room>>,
    next_peer: AtomicU64,
}

impl Hub {
    pub fn next_peer_id(&self) -> u64 {
        self.next_peer.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Join a board's room. Returns the receiver and the peers already there.
    pub fn join(&self, board_id: i64, peer: Peer) -> (broadcast::Receiver<Msg>, Vec<Peer>) {
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        let room = rooms
            .entry(board_id)
            .or_insert_with(|| Room { tx: broadcast::channel(CHANNEL_CAPACITY).0, peers: HashMap::new() });
        let rx = room.tx.subscribe();
        let others = room.peers.values().cloned().collect();
        let _ = room.tx.send(Msg { from: peer.id, text: json!({ "t": "peer", "peer": &peer }).to_string().into() });
        room.peers.insert(peer.id, peer);
        (rx, others)
    }

    pub fn leave(&self, board_id: i64, peer_id: u64) {
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(room) = rooms.get_mut(&board_id) {
            room.peers.remove(&peer_id);
            if room.peers.is_empty() {
                rooms.remove(&board_id);
            } else {
                let _ = room
                    .tx
                    .send(Msg { from: peer_id, text: json!({ "t": "peer_left", "id": peer_id }).to_string().into() });
            }
        }
    }

    /// Send a message to everyone on a board except `from`.
    pub fn send(&self, board_id: i64, from: u64, text: String) {
        let rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(room) = rooms.get(&board_id) {
            let _ = room.tx.send(Msg { from, text: text.into() });
        }
    }

    pub fn peer_count(&self, board_id: i64) -> usize {
        let rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        rooms.get(&board_id).map_or(0, |r| r.peers.len())
    }
}
