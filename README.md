# revo: Betch image review boards

A Miro-style board where clients review images. Each client gets a board at
`review.betch.ch/<link-name>`. They pan and zoom around the board, drop comment
pins on exact spots, reply in threads, and mark each image **Approved** or
**Changes requested**. No account is needed; a passcode is optional.

Built in Rust (Axum + SQLite). Images are stored on disk. The whole app is
**one binary**: HTML, CSS, JS and the Space Grotesk font are compiled in.

## Features

**Clients**
- Board link with an optional passcode. Entering it once keeps that browser signed in for 90 days.
- Infinite canvas: drag to pan, scroll or pinch to zoom. Works with touch.
- Comment pins tied to an exact spot on an image (`C`, or "Add a comment pin"). Threads with replies.
- Per-image decision: Approved / Changes requested, with who decided and when.
- The client gives their name once; it's remembered in that browser.
- Sees changes from others within a few seconds, without reloading.

**Admin (you)**, at `/admin`
- Create and delete boards; rename them and set, change or remove the passcode. A new passcode signs out old sessions.
- Upload images with the button or by dropping files on the board. JPEG, PNG, WebP and GIF are accepted, and camera rotation is respected.
- Arrange mode (`A`): drag to move, use the corner dot to resize.
- Upload a **new version** of an image. Comments and decisions stay on the version they were made on. Older versions stay viewable from the image panel, and the new version starts as pending.
- Resolve, reopen or delete comments. Download originals (clients only get the 2560 px web copy).
- Dashboard with a cover image, approval counts and open comments per board.

## Run it locally

```sh
cargo build
echo 'a-long-local-password' | ./target/debug/revo hash-password   # prints a hash
REVO_ADMIN_PASSWORD_HASH='<hash>' REVO_COOKIE_SECURE=false \
REVO_PUBLIC_URL=http://127.0.0.1:4000 ./target/debug/revo
```

Open http://127.0.0.1:4000/admin. `REVO_COOKIE_SECURE=false` is only for plain
`http://` testing; leave it unset in production.

```sh
cargo test                     # API tests: auth, passcodes, comments, versions, deletion
cargo clippy --all-targets
```

## Configuration

All settings are environment variables. See `deploy/revo.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `REVO_ADMIN_PASSWORD_HASH` | required | Argon2 hash from `revo hash-password` |
| `REVO_BIND` | `127.0.0.1:4000` | Listen address (`0.0.0.0:4000` on an Infomaniak Cloud Server) |
| `REVO_DATA_DIR` | `./data` | Holds `revo.db` and `images/` |
| `REVO_PUBLIC_URL` | `https://review.betch.ch` | Used for share links in the admin |
| `REVO_MAX_UPLOAD_MB` | `60` | Maximum size per uploaded file |
| `REVO_COOKIE_SECURE` | `true` | Set `false` only for local http testing |
| `RUST_LOG` | `info` | Log level |

Commands: `revo serve` (default), `revo hash-password`, `revo backup <file>`.

## How it's built

```
src/
  main.rs          CLI: serve, hash-password, backup
  lib.rs           router, security headers, CSRF guard
  config.rs        REVO_* settings
  db.rs            SQLite schema, shared connection
  auth.rs          admin sessions, board passcodes, brute-force throttle
  images.rs        validation, EXIF rotation, 2560 px + 480 px web copies
  routes/
    admin.rs       boards, uploads, versions, arranging, comment moderation
    board.rs       client API: board data, unlock, comments, decisions
    pages.rs       HTML pages, embedded assets, access-checked image files
static/            front end (vanilla JS, no build step), font
deploy/            systemd unit, env template, Caddyfile
```

Data model: **board** → **images** (position, size) → **versions** (file and
decision) → **comments** (pin position as a fraction of the image; replies point
to their thread).

Security:
- Passwords and passcodes are hashed with Argon2id.
- Session cookies are HttpOnly, Secure and SameSite=Lax.
- Every state-changing API call needs an `X-Revo` header, which blocks cross-site forgery.
- Strict Content-Security-Policy.
- Passcode and login guessing is throttled.
- Image files are only served to viewers of their board.

## Deploying

See [DEPLOY.md](DEPLOY.md).
