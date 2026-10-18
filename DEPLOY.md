# Deploying to review.betch.ch

This guide has two routes. Pick the one that matches where you host:

- **A. Your existing Infomaniak managed Cloud Server** ("Betch", `od-579eb7`). No extra cost, and Infomaniak maintains the system.
- **B. An Infomaniak VPS** (VPS Lite or VPS Cloud), if you move everything there. You maintain the system.

Both routes share step 0 (get the binary), step 1 (DNS) and the update and backup steps at the end.

> Infomaniak changes Manager menu names from time to time. If a label below doesn't
> match exactly, the linked Infomaniak FAQ pages describe the current screens.

---

## 0. Get the binary

The app is a single Linux file, `revo`, about 6 MB. Nothing else (no Rust, no
database server) is needed on the server.

**Easiest: let GitHub build it.**
1. On GitHub, open **betch49/revo → Actions → Release binary → Run workflow**.
2. When it finishes, open the run and download **revo-x86_64-linux** under *Artifacts*.
3. Unzip it. Inside is `revo-x86_64-linux.tar.gz`; `tar xzf` it to get `revo`.

Alternatively, push a tag such as `v0.1.0`. The binary is then also attached to
a GitHub Release.

**Or build it yourself** (Linux):
```sh
rustup target add x86_64-unknown-linux-musl
sudo apt install musl-tools
cargo build --release --target x86_64-unknown-linux-musl
# → target/x86_64-unknown-linux-musl/release/revo
```

## 1. DNS: point review.betch.ch at the server

**First, find out where betch.ch's DNS is managed.** On your computer, run:
```sh
dig NS betch.ch +short
```
- If it shows `ns11.infomaniak.ch` / `ns12.infomaniak.ch`, edit the zone in the Infomaniak Manager under **Domains → betch.ch → DNS zone**.
- If it shows another provider (Cloudflare, for example), add the record there instead. The Infomaniak zone for betch.ch currently has no records for `betch.ch`, `www` or your other subdomains (only `assets2`), so the live DNS is probably elsewhere.

**Then add the record for `review`:**

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `review` | the server's IPv4 address | 300 |
| `AAAA` | `review` | the server's IPv6 address, if it has one | 300 |

- **Cloud Server (route A):** use the same IP addresses as your other sites on that server; the Manager shows them in the Cloud Server overview. `CNAME review → product.betch.ch` also works if that site is on the same Cloud Server.
- **VPS (route B):** use the VPS's public IP from the Manager.
- **Cloudflare only:** set the record to "DNS only" (grey cloud) until HTTPS works, so the certificate can be issued.

Check from your computer (it can take a few minutes):
```sh
dig review.betch.ch +short
```

---

## Route A: Infomaniak managed Cloud Server

On a Cloud Server, web traffic goes through Infomaniak's front end (Apache, with
HAProxy as an option). To send a site to your own program, Infomaniak uses
**HAProxy**. Your program must listen on **all interfaces (0.0.0.0)** on a port
**between 4000 and 4009**
([Infomaniak FAQ: redirect web traffic to a specific port](https://www.infomaniak.com/en/support/faq/2171/redirect-web-traffic-to-a-specific-port)).
HTTPS is handled by Infomaniak with the site's free Let's Encrypt certificate.

### A1. Create the site
1. Manager → **Cloud Server "Betch"** → open the web hosting you want to use. **Apps** suits this; it already holds `projects.betch.ch`.
2. **Add a website** → domain `review.betch.ch` → an empty site (no CMS).
3. Once DNS (step 1) points at the server, enable the free **SSL certificate (Let's Encrypt)** for the site.

### A2. Upload the binary
1. Manager → the hosting → **FTP / SSH** → note or create the **SSH user**.
2. Connect with SFTP (FileZilla, Cyberduck or `scp`). Create these folders in the user's home directory:
   ```
   ~/revo/bin/
   ~/revo/data/
   ```
3. Upload `revo` to `~/revo/bin/revo`. Then over SSH:
   ```sh
   chmod +x ~/revo/bin/revo
   ~/revo/bin/revo --version
   ```

### A3. Configure
```sh
~/revo/bin/revo hash-password      # type your admin password (10+ characters)
```
Copy the printed hash. Create `~/revo/revo.env` (template: `deploy/revo.env.example`):
```sh
cat > ~/revo/revo.env <<'EOF'
REVO_ADMIN_PASSWORD_HASH='PASTE-THE-HASH-HERE'
REVO_BIND=0.0.0.0:4000
REVO_PUBLIC_URL=https://review.betch.ch
REVO_MAX_UPLOAD_MB=60
RUST_LOG=info
EOF
chmod 600 ~/revo/revo.env
```
If port 4000 is already used by another app on the server, use another port from 4001 to 4009 here and in A5.

### A4. Run it as a service
Infomaniak recommends a **systemd user service** for long-running programs on a
Cloud Server
([FAQ: install and configure systemd on a Cloud Server](https://www.infomaniak.com/en/support/faq/2571/install-and-configure-systemd-on-a-cloud-server)).
If that FAQ says to activate systemd first in the Manager, do that before continuing.

```sh
mkdir -p ~/.config/systemd/user
# Copy deploy/revo.service from this repo to ~/.config/systemd/user/revo.service
chmod 644 ~/.config/systemd/user/revo.service
systemctl --user daemon-reload
systemctl --user enable --now revo
systemctl --user status revo          # should be "active (running)"
curl -s http://127.0.0.1:4000/healthz # → ok
```
Logs: `journalctl --user -u revo -f`

### A5. Send review.betch.ch to the app (HAProxy)
1. Manager → **Cloud Server "Betch"** → **Fast Installer** (left menu).
2. Install **HAProxy** if it isn't installed yet.
3. Open the **⋮** menu next to HAProxy → **Configure**. Select the site **review.betch.ch** and port **4000**, then save.

Infomaniak notes that this applies to the site's primary domain. Keep
`review.betch.ch` as the site's main domain, not an alias.

### A6. Check it
- https://review.betch.ch/healthz shows `ok`
- https://review.betch.ch/admin shows the sign-in page
- **Live editing:** open a board in two browsers (one in a private window via a shared link). A sticky added in one should appear in the other within a second. This needs WebSockets to pass through Infomaniak's HAProxy. If the board shows "Reconnecting…" all the time, ask Infomaniak support to allow WebSocket upgrades (`Connection: Upgrade`) for `review.betch.ch`, or use route B.
- Optional, from your own computer: `curl -m 5 http://SERVER-IP:4000/healthz` should **fail or time out**. Port 4000 shouldn't be reachable from outside; if it answers, ask Infomaniak support to block it.

**Upload size:** if large uploads fail behind HAProxy or Apache but small ones
work, lower `REVO_MAX_UPLOAD_MB`, or ask Infomaniak support about the request
size limit for the site.

---

## Route B: Infomaniak VPS (Debian or Ubuntu)

Here you manage the server yourself. **Caddy** handles HTTPS: it gets and renews
the certificate automatically.

### B1. Prepare the server (as root, once)
```sh
apt update && apt upgrade -y
apt install -y unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https curl ufw
dpkg-reconfigure -plow unattended-upgrades          # automatic security updates

# Firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable

# Caddy (official repository)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# A dedicated user for the app
adduser --system --group --home /home/revo revo
mkdir -p /home/revo/revo/bin /home/revo/revo/data
```
In the Infomaniak Manager, open ports 80 and 443 in the VPS's **firewall /
security group** if it has one.

### B2. Install the app
Copy `revo` to the server (`scp revo root@SERVER:/home/revo/revo/bin/`), then:
```sh
chmod +x /home/revo/revo/bin/revo
/home/revo/revo/bin/revo hash-password            # copy the hash
cat > /home/revo/revo/revo.env <<'EOF'
REVO_ADMIN_PASSWORD_HASH='PASTE-THE-HASH-HERE'
REVO_BIND=127.0.0.1:4000
REVO_PUBLIC_URL=https://review.betch.ch
REVO_MAX_UPLOAD_MB=60
RUST_LOG=info
EOF
chmod 600 /home/revo/revo/revo.env
chown -R revo:revo /home/revo/revo
```

### B3. Service
Copy `deploy/revo.service` to `/etc/systemd/system/revo.service` and edit it:
under `[Service]` add `User=revo`, and under `[Install]` use `WantedBy=multi-user.target`. Then:
```sh
systemctl daemon-reload
systemctl enable --now revo
curl -s http://127.0.0.1:4000/healthz   # → ok
```

### B4. HTTPS with Caddy
Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` (merge it with any existing
sites), then:
```sh
systemctl reload caddy
```
Once DNS points at the VPS, https://review.betch.ch works within a minute.
Caddy passes WebSockets through automatically, so live editing needs no extra setup.

---

## First use
1. Open https://review.betch.ch/admin and sign in.
2. Create a board. It opens right away and starts **private**.
3. Build on it: press `?` on the board for all tools and shortcuts.
4. Click **Share**: choose who can open the link (view, comment or edit), optionally set a passcode, and copy the link.

## Updating the app
Download the new binary (step 0), then:
```sh
# Route A
mv ~/revo/bin/revo ~/revo/bin/revo.old && cp revo ~/revo/bin/revo && chmod +x ~/revo/bin/revo
systemctl --user restart revo
# Route B
install -o revo -g revo -m 755 revo /home/revo/revo/bin/revo && systemctl restart revo
```
The database schema is created and updated automatically on start. Boards,
comments and images are kept.

## Backups
Everything lives in the data folder (`~/revo/data`): `revo.db` (boards, items, comments) and `images/`.
A daily copy, for example with `crontab -e` (Route A paths shown):
```cron
15 3 * * * cd ~/revo && mkdir -p backups && rm -f backups/revo-$(date +\%u).db && REVO_DATA_DIR=data bin/revo backup backups/revo-$(date +\%u).db
```
This keeps one database snapshot per weekday. `revo backup` is safe while the app runs.
Also copy `~/revo/data/images/` off the server now and then, for example to kDrive with rsync or SFTP.

## Troubleshooting
| Symptom | Check |
|---|---|
| `REVO_ADMIN_PASSWORD_HASH is not set` | `revo.env` path in the service, and the single quotes around the hash |
| Service won't start | `journalctl --user -u revo -n 50` (Route A) or `journalctl -u revo -n 50` (Route B) |
| 502 / 503 on the site | App not running, or the HAProxy port (Route A) or Caddy port (Route B) doesn't match `REVO_BIND` |
| Can't sign in on http:// | Cookies are HTTPS-only by design; use the https:// address |
| Board says "Reconnecting…" | WebSockets are blocked by the proxy: see A6 (Infomaniak) or check that Caddy is the one in front (VPS) |
| Upload fails with "too large" | Raise `REVO_MAX_UPLOAD_MB` (and `max_size` in the Caddyfile on route B), then restart |
