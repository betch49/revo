# revo: Betch whiteboard

A Miro-style collaborative whiteboard for Betch. Each board lives at
`review.betch.ch/<board-link>` (the domain is configurable). People you share
it with work on it together in real time. No account is needed: you choose per
board whether the link lets people view, comment or edit, and can add a
passcode.

Built in Rust (Axum + SQLite, WebSockets for live editing). Images are stored on
disk. The whole app is **one binary**: HTML, CSS, JS and the Space Grotesk font
are compiled in.

## What's on the board

| Tool | Key | Notes |
|---|---|---|
| Select | V | Click, Shift+click, drag a box; move with alignment guides; resize handles; Alt+drag to duplicate |
| Hand | H | Or Space+drag, right/middle-drag, two-finger scroll |
| Sticky note | N | 14 colors, text auto-sizes to fit |
| Text | T | Size, color, bold, italic, alignment |
| Shape | S | Rectangle, rounded, ellipse, triangle, diamond, hexagon, star, parallelogram, arrow, speech bubble; fill, border, text |
| Connection line | L | Curved, elbow or straight; snaps to item sides and follows them; arrow/dot ends, dashed |
| Pen / highlighter / eraser | P / M / E | Freehand strokes, smoothed |
| Frame | F | Groups an area; moving the frame moves what's inside |
| Image | – | Upload button, drag and drop, or paste |
| Comment | C | Pinned threads anywhere on the board, replies, resolve |

Also: undo/redo, copy/cut/paste (across boards too), duplicate, bring to front /
send to back, lock, right-click menu, zoom to fit / selection, and a shortcut
sheet (`?`).

**Live collaboration:** everyone's edits, cursors (with names), selections and
comments appear instantly. Edits are saved as they happen, and the last write
wins. While someone drags or draws, others see it move.

**Sharing** (per board, set by you):
- Private: only you, signed in.
- Link: can view, can comment, or can edit.
- Optional passcode on top. Changing it signs out everyone who used the old one.

**Dashboard** at `/admin`: create, rename, share, duplicate and delete boards,
and see item counts, open comments and who's online.

## Try it without a server

`python3 demo/build.py demo/revo-demo.html` builds a single HTML file with the
real editor running on an in-browser mock of the server, plus a simulated
teammate.

## Run it locally

```sh
cargo build
echo 'a-long-local-password' | ./target/debug/revo hash-password   # prints a hash
REVO_ADMIN_PASSWORD_HASH='<hash>' REVO_COOKIE_SECURE=false \
REVO_PUBLIC_URL=http://127.0.0.1:4000 ./target/debug/revo
```

Open http://127.0.0.1:4000/admin. `REVO_COOKIE_SECURE=false` is only for plain
`http://` testing.

```sh
cargo test                     # sharing rules, uploads, duplication, a live two-client session
cargo clippy --all-targets
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `REVO_ADMIN_PASSWORD_HASH` | required | Argon2 hash from `revo hash-password` |
| `REVO_BIND` | `127.0.0.1:4000` | Listen address (`0.0.0.0:4000` on an Infomaniak Cloud Server) |
| `REVO_DATA_DIR` | `./data` | Holds `revo.db` and `images/` |
| `REVO_PUBLIC_URL` | `https://review.betch.ch` | Used for share links |
| `REVO_MAX_UPLOAD_MB` | `60` | Maximum size per uploaded image |
| `REVO_COOKIE_SECURE` | `true` | Set `false` only for local http testing |
| `RUST_LOG` | `info` | Log level |

Commands: `revo serve` (default), `revo hash-password`, `revo backup <file>`.

## How it's built

```
src/
  main.rs            CLI: serve, hash-password, backup
  lib.rs             router, security headers, CSRF guard
  hub.rs             live rooms: one broadcast channel per open board
  items.rs           validating and storing board items (JSON, last write wins)
  auth.rs            owner sessions, roles, passcodes, brute-force throttle
  images.rs          upload validation, EXIF rotation, web-sized copies
  routes/
    ws.rs            WebSocket protocol (hello, ops, cursor, sel, …)
    board.rs         board info, unlock, image uploads, comments
    admin.rs         dashboard: boards, sharing, duplicate, delete
    pages.rs         HTML pages, embedded assets, access-checked image files
static/
  board-core.js      state, geometry, transactions, undo/redo
  board-render.js    drawing items and the selection
  board-tools.js     tools, gestures, text editing, shortcuts, clipboard
  board-ui.js        tool bar, context toolbar, menus, sharing, comments, cursors
  board-main.js      start-up and the live connection
  admin.js           dashboard
demo/                single-file demo build (mock server)
deploy/              systemd unit, env template, Caddyfile
```

**Items** are JSON objects the browser defines, for example
`{"id": "k3…", "type": "sticky", "x": 0, "y": 0, "w": 200, "h": 200, "color": "#fff59d", "text": "…"}`.
The server checks the id, type and size, then stores and relays them. To add a
new kind of item, extend `KINDS` in `src/items.rs` and teach `board-render.js`
to draw it.

**Security:**
- Passwords and passcodes are hashed with Argon2id.
- Cookies are HttpOnly, Secure and SameSite=Lax.
- State-changing HTTP calls need an `X-Revo` header (CSRF guard).
- WebSockets check the Origin header.
- Strict Content-Security-Policy.
- Login and passcode guessing is throttled.
- Image files are only served to people allowed on their board.

## Deploying

See [DEPLOY.md](DEPLOY.md).
