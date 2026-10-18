//! Board items: validation and storage of edit operations.
//!
//! The front end defines what an item looks like. The server only checks that
//! each item is a reasonably sized JSON object with a valid id and known type,
//! and stores it as-is (last write wins).

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::{db::now, error::AppError};

pub const KINDS: &[&str] = &["sticky", "text", "shape", "connector", "draw", "image", "frame"];
const MAX_ITEM_BYTES: usize = 256 * 1024;
const MAX_OPS_PER_MESSAGE: usize = 5000;
pub const MAX_ITEMS_PER_BOARD: i64 = 20_000;

#[derive(Debug, Clone)]
pub enum Op {
    Put { id: String, data: String },
    Del { id: String },
}

pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parse `[{"put": {...item}}, {"del": "id"}, ...]`.
pub fn parse_ops(value: &Value) -> Result<Vec<Op>, String> {
    let list = value.as_array().ok_or("ops must be a list")?;
    if list.len() > MAX_OPS_PER_MESSAGE {
        return Err("too many changes at once".into());
    }
    list.iter()
        .map(|op| {
            let op = op.as_object().ok_or("each op must be an object")?;
            if let Some(item) = op.get("put") {
                let obj = item.as_object().ok_or("put needs an item object")?;
                let id = check_item(obj)?;
                let data = item.to_string();
                if data.len() > MAX_ITEM_BYTES {
                    return Err("item is too large".into());
                }
                Ok(Op::Put { id, data })
            } else if let Some(id) = op.get("del").and_then(Value::as_str) {
                if valid_id(id) { Ok(Op::Del { id: id.to_string() }) } else { Err("invalid item id".into()) }
            } else {
                Err("unknown op".into())
            }
        })
        .collect()
}

fn check_item(obj: &Map<String, Value>) -> Result<String, String> {
    let id = obj.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("item needs a valid id")?;
    let kind = obj.get("type").and_then(Value::as_str).ok_or("item needs a type")?;
    if !KINDS.contains(&kind) {
        return Err(format!("unknown item type {kind}"));
    }
    Ok(id.to_string())
}

/// Apply ops in one transaction.
pub fn apply(conn: &mut Connection, board_id: i64, ops: &[Op]) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    let t = now();
    {
        let mut put = tx.prepare_cached(
            "INSERT INTO items (board_id, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (board_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        )?;
        let mut del = tx.prepare_cached("DELETE FROM items WHERE board_id = ?1 AND id = ?2")?;
        for op in ops {
            match op {
                Op::Put { id, data } => {
                    put.execute(params![board_id, id, data, t])?;
                }
                Op::Del { id } => {
                    del.execute(params![board_id, id])?;
                }
            }
        }
    }
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM items WHERE board_id = ?1", [board_id], |r| r.get(0))?;
    if count > MAX_ITEMS_PER_BOARD {
        return Err(AppError::bad("This board is full"));
    }
    crate::db::touch_board(&tx, board_id)?;
    tx.commit()?;
    Ok(())
}

/// All items of a board as JSON values.
pub fn load(conn: &Connection, board_id: i64) -> Result<Vec<Value>, AppError> {
    let mut stmt = conn.prepare_cached("SELECT data FROM items WHERE board_id = ?1")?;
    let rows = stmt.query_map([board_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        if let Ok(v) = serde_json::from_str(&row?) {
            out.push(v);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_validates_ops() {
        let ops = parse_ops(&json!([
            { "put": { "id": "a1", "type": "sticky", "x": 0, "text": "hi" } },
            { "del": "b2" }
        ]))
        .unwrap();
        assert_eq!(ops.len(), 2);
        assert!(parse_ops(&json!([{ "put": { "id": "a b", "type": "sticky" } }])).is_err());
        assert!(parse_ops(&json!([{ "put": { "id": "a", "type": "virus" } }])).is_err());
        assert!(parse_ops(&json!([{ "del": "../x" }])).is_err());
        assert!(parse_ops(&json!({ "put": {} })).is_err());
        let big = "x".repeat(MAX_ITEM_BYTES);
        assert!(parse_ops(&json!([{ "put": { "id": "a", "type": "text", "text": big } }])).is_err());
    }
}
