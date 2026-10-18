// In-browser stand-in for the Rust server, used only by the demo build
// (demo/build.py). It mirrors the real API so the real front-end code runs
// unchanged. Two simulated browsers ("You" and "Client") share one backend.
"use strict";

(() => {
  const ADMIN_PASSWORD = "betch-demo";
  const PUBLIC_URL = "https://review.betch.ch";
  const MAX_UPLOAD_MB = 60;
  const RESERVED = ["admin", "api", "static", "files", "healthz", "robots.txt"];
  const now = () => Math.floor(Date.now() / 1000);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let db;
  let browsers;
  let role = "admin";

  // ------------------------------------------------------------ errors & helpers

  function fail(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    throw e;
  }
  const bad = (m) => fail(400, "bad_request", m);
  const notFound = () => fail(404, "not_found", "not found");
  const me = () => browsers[role];
  const requireAdmin = () => { if (!me().admin) fail(401, "unauthorized", "not signed in"); };

  function cleanText(v, field, max) {
    const t = (v || "").trim();
    if (!t) bad(`${field} is required`);
    if ([...t].length > max) bad(`${field} is too long (max ${max} characters)`);
    return t;
  }

  function validSlug(s) {
    return s.length >= 3 && s.length <= 64 && /^[a-z0-9-]+$/.test(s) && !s.startsWith("-") && !s.endsWith("-") && !RESERVED.includes(s);
  }

  const id = () => db.seq++;
  const board = (bid) => db.boards.find((b) => b.id === bid) || notFound();
  const image = (iid) => db.images.find((i) => i.id === iid) || notFound();
  const versionsOf = (iid) => db.versions.filter((v) => v.image_id === iid).sort((a, b) => a.number - b.number);
  const current = (iid) => versionsOf(iid).at(-1);
  const bump = (bid) => { board(bid).rev++; };

  function boardView(b) {
    return {
      board: { id: b.id, slug: b.slug, title: b.title, has_passcode: !!b.passcode, rev: b.rev },
      is_admin: me().admin,
      images: db.images
        .filter((i) => i.board_id === b.id)
        .sort((a, b2) => a.z - b2.z || a.id - b2.id)
        .map((i) => ({
          id: i.id, title: i.title, x: i.x, y: i.y, width: i.width, z: i.z,
          versions: versionsOf(i.id).map((v) => ({
            id: v.id, number: v.number, original_name: v.original_name, px_width: v.px_width, px_height: v.px_height,
            status: v.status, status_by: v.status_by, status_at: v.status_at, created_at: v.created_at,
            comments: db.comments.filter((c) => c.version_id === v.id).sort((a, b2) => a.id - b2.id).map(clone),
          })),
        })),
    };
  }

  function authorize(slug) {
    const b = db.boards.find((x) => x.slug === slug) || notFound();
    if (b.passcode && !me().admin && !me().unlocked.has(b.id)) fail(401, "passcode_required", "passcode required");
    return b;
  }

  function versionOnBoard(vid, bid) {
    const v = db.versions.find((x) => x.id === vid);
    if (!v || image(v.image_id).board_id !== bid) notFound();
    return v;
  }

  function deleteImageData(iid) {
    for (const v of versionsOf(iid)) {
      db.comments = db.comments.filter((c) => c.version_id !== v.id);
      if (v.files.original && v.files.original.startsWith("blob:")) URL.revokeObjectURL(v.files.original);
    }
    db.versions = db.versions.filter((v) => v.image_id !== iid);
    db.images = db.images.filter((i) => i.id !== iid);
  }

  function defaultSize(px_width, px_height) {
    const s = 800 / Math.max(px_width, px_height);
    return [px_width * s, px_height * s];
  }

  function titleFromFilename(name) {
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    return stem.replace(/[_-]/g, " ").trim().slice(0, 200) || "Image";
  }

  // ------------------------------------------------------------ image processing

  function resized(source, w, h, max, type) {
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.88);
  }

  async function processUpload(file) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) bad("Unsupported file. Upload JPEG, PNG, WebP or GIF images.");
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) fail(413, "too_large", "file too large");
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (_) {
      bad("Could not read this image");
    }
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const out = {
      original_name: file.name.slice(0, 200),
      px_width: bmp.width,
      px_height: bmp.height,
      files: {
        display: resized(bmp, bmp.width, bmp.height, 2560, type),
        thumb: resized(bmp, bmp.width, bmp.height, 480, type),
        original: URL.createObjectURL(file),
      },
    };
    bmp.close && bmp.close();
    return out;
  }

  function addVersion(iid, number, up) {
    const v = {
      id: id(), image_id: iid, number, original_name: up.original_name, px_width: up.px_width, px_height: up.px_height,
      status: "pending", status_by: null, status_at: null, created_at: up.created_at || now(), files: up.files,
    };
    db.versions.push(v);
    return v;
  }

  // ------------------------------------------------------------ API

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern + "$"), fn });

  route("GET", "/admin/session", () => ({ admin: me().admin, public_url: PUBLIC_URL }));
  route("POST", "/admin/login", (_, body) => {
    if (body.password !== ADMIN_PASSWORD) bad("Wrong password");
    me().admin = true;
    return { ok: true };
  });
  route("POST", "/admin/logout", () => { me().admin = false; return { ok: true }; });

  route("GET", "/admin/boards", () => {
    requireAdmin();
    return [...db.boards].sort((a, b) => b.created_at - a.created_at || b.id - a.id).map((b) => {
      const imgs = db.images.filter((i) => i.board_id === b.id);
      const cur = imgs.map((i) => current(i.id));
      const cover = [...imgs].sort((a, c) => c.z - a.z || a.id - c.id)[0];
      return {
        id: b.id, slug: b.slug, title: b.title, has_passcode: !!b.passcode, created_at: b.created_at,
        images: imgs.length,
        approved: cur.filter((v) => v.status === "approved").length,
        changes_requested: cur.filter((v) => v.status === "changes_requested").length,
        open_comments: db.comments.filter((c) => cur.some((v) => v.id === c.version_id) && c.parent_id === null && !c.resolved_at).length,
        cover_version_id: cover ? current(cover.id).id : null,
      };
    });
  });

  route("POST", "/admin/boards", (_, body) => {
    requireAdmin();
    const slug = (body.slug || "").trim().toLowerCase();
    if (!validSlug(slug)) bad("The link name must be 3–64 characters: lowercase letters, digits and dashes.");
    const title = cleanText(body.title, "Title", 120);
    if (db.boards.some((b) => b.slug === slug)) fail(409, "conflict", "A board with this link already exists");
    const b = { id: id(), slug, title, passcode: (body.passcode || "").trim() || null, rev: 1, created_at: now() };
    db.boards.push(b);
    return { id: b.id };
  });

  route("PATCH", "/admin/boards/(\\d+)", ([bid], body) => {
    requireAdmin();
    const b = board(+bid);
    if (body.title !== undefined) b.title = cleanText(body.title, "Title", 120);
    if (body.passcode !== undefined && body.passcode !== null) {
      b.passcode = body.passcode.trim() || null;
      for (const br of Object.values(browsers)) br.unlocked.delete(b.id);
    }
    bump(b.id);
    return { ok: true };
  });

  route("DELETE", "/admin/boards/(\\d+)", ([bid]) => {
    requireAdmin();
    board(+bid);
    for (const i of db.images.filter((x) => x.board_id === +bid)) deleteImageData(i.id);
    db.boards = db.boards.filter((b) => b.id !== +bid);
    return { ok: true };
  });

  route("POST", "/admin/boards/(\\d+)/images", async ([bid], form) => {
    requireAdmin();
    const b = board(+bid);
    const files = form.getAll("file");
    if (!files.length) bad("No file uploaded");
    const ups = [];
    for (const f of files) ups.push(await processUpload(f));
    const sizes = ups.map((u) => defaultSize(u.px_width, u.px_height));
    const rowWidth = sizes.reduce((s, [w]) => s + w, 0) + 60 * (ups.length - 1);
    const onBoard = db.images.filter((i) => i.board_id === b.id);
    const topZ = Math.max(0, ...onBoard.map((i) => i.z));
    const cx = parseFloat(form.get("x"));
    const cy = parseFloat(form.get("y"));
    let x;
    let y;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      x = form.get("anchor") === "left" ? cx : cx - rowWidth / 2;
      y = cy;
    } else {
      x = onBoard.length ? Math.max(...onBoard.map((i) => i.x + i.width)) + 60 : 0;
      y = 400;
    }
    const ids = ups.map((u, n) => {
      const [w, h] = sizes[n];
      const img = { id: id(), board_id: b.id, title: titleFromFilename(u.original_name), x, y: y - h / 2, width: w, z: topZ + 1 + n };
      db.images.push(img);
      addVersion(img.id, 1, u);
      x += w + 60;
      return img.id;
    });
    bump(b.id);
    return { ids };
  });

  route("POST", "/admin/images/(\\d+)/versions", async ([iid], form) => {
    requireAdmin();
    const img = image(+iid);
    const file = form.get("file");
    if (!file) bad("No file uploaded");
    const up = await processUpload(file);
    const v = addVersion(img.id, current(img.id).number + 1, up);
    bump(img.board_id);
    return { id: v.id, number: v.number };
  });

  route("PATCH", "/admin/images/(\\d+)", ([iid], body) => {
    requireAdmin();
    const img = image(+iid);
    if (body.title !== undefined) img.title = cleanText(body.title, "Title", 200);
    for (const k of ["x", "y", "width", "z"]) if (typeof body[k] === "number" && Number.isFinite(body[k])) img[k] = body[k];
    if (img.width < 20) img.width = 20;
    bump(img.board_id);
    return { ok: true };
  });

  route("DELETE", "/admin/images/(\\d+)", ([iid]) => {
    requireAdmin();
    const img = image(+iid);
    deleteImageData(img.id);
    bump(img.board_id);
    return { ok: true };
  });

  const commentBoard = (cid) => {
    const c = db.comments.find((x) => x.id === cid) || notFound();
    return [c, image(db.versions.find((v) => v.id === c.version_id).image_id).board_id];
  };

  route("POST", "/admin/comments/(\\d+)/resolve", ([cid], body) => {
    requireAdmin();
    const [c, bid] = commentBoard(+cid);
    c.resolved_at = body.resolved ? now() : null;
    bump(bid);
    return { ok: true };
  });

  route("DELETE", "/admin/comments/(\\d+)", ([cid]) => {
    requireAdmin();
    const [c, bid] = commentBoard(+cid);
    db.comments = db.comments.filter((x) => x.id !== c.id && x.parent_id !== c.id);
    bump(bid);
    return { ok: true };
  });

  route("GET", "/b/([^/]+)", ([slug]) => boardView(authorize(decodeURIComponent(slug))));
  route("GET", "/b/([^/]+)/rev", ([slug]) => ({ rev: authorize(decodeURIComponent(slug)).rev }));

  route("POST", "/b/([^/]+)/unlock", ([slug], body) => {
    const b = db.boards.find((x) => x.slug === decodeURIComponent(slug)) || notFound();
    if (b.passcode && body.passcode !== b.passcode) bad("Wrong passcode");
    me().unlocked.add(b.id);
    return { ok: true };
  });

  route("POST", "/b/([^/]+)/comments", ([slug], body) => {
    const b = authorize(decodeURIComponent(slug));
    const text = cleanText(body.body, "Comment", 4000);
    let author;
    if (body.author && body.author.trim()) author = cleanText(body.author, "Name", 60);
    else if (me().admin) author = "Betch";
    else bad("Name is required");
    let x = null;
    let y = null;
    if (body.parent_id == null) {
      if (!(body.x >= 0 && body.x <= 1 && body.y >= 0 && body.y <= 1)) bad("A new comment needs a pin position on the image");
      x = body.x;
      y = body.y;
    }
    versionOnBoard(body.version_id, b.id);
    if (body.parent_id != null && !db.comments.some((c) => c.id === body.parent_id && c.version_id === body.version_id && c.parent_id === null)) {
      bad("Unknown thread");
    }
    const c = {
      id: id(), version_id: body.version_id, parent_id: body.parent_id ?? null, x, y, author,
      is_admin: me().admin, body: text, resolved_at: null, created_at: now(),
    };
    db.comments.push(c);
    bump(b.id);
    return { id: c.id };
  });

  route("POST", "/b/([^/]+)/versions/(\\d+)/status", ([slug, vid], body) => {
    const b = authorize(decodeURIComponent(slug));
    if (!["pending", "approved", "changes_requested"].includes(body.status)) bad("Unknown status");
    let by = null;
    if (body.author && body.author.trim()) by = cleanText(body.author, "Name", 60);
    else if (me().admin) by = "Betch";
    else bad("Name is required");
    const v = versionOnBoard(+vid, b.id);
    v.status = body.status;
    v.status_by = body.status === "pending" ? null : by;
    v.status_at = body.status === "pending" ? null : now();
    bump(b.id);
    return { ok: true };
  });

  async function api(method, path, body) {
    await new Promise((r) => setTimeout(r, 60));
    for (const r of routes) {
      const m = r.method === method && path.match(r.re);
      if (m) return clone(await r.fn(m.slice(1), body || {}));
    }
    notFound();
  }

  async function uploadForm(path, form, onProgress) {
    for (let p = 0.2; p < 1; p += 0.2) {
      onProgress && onProgress(p);
      await new Promise((r) => setTimeout(r, 70));
    }
    return api("POST", path, form);
  }

  function file(vid, variant) {
    const v = db.versions.find((x) => x.id === vid);
    return v ? v.files[variant] || v.files.display : "";
  }

  // ------------------------------------------------------------ sample content

  function rng(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function paint(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"), w, h);
    const display = c.toDataURL("image/jpeg", 0.86);
    return { px_width: w, px_height: h, files: { display, thumb: resized(c, w, h, 480, "image/jpeg"), original: display } };
  }

  function lake(warm) {
    return paint(1800, 1200, (g, w, h) => {
      const r = rng(7);
      const horizon = h * 0.6;
      const sky = g.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, warm ? "#2b3560" : "#14243f");
      sky.addColorStop(0.6, warm ? "#d9826a" : "#5b7fa6");
      sky.addColorStop(1, warm ? "#f6c48b" : "#c9d6e3");
      g.fillStyle = sky;
      g.fillRect(0, 0, w, horizon);
      const sx = w * 0.62;
      const sy = horizon - 70;
      const glow = g.createRadialGradient(sx, sy, 10, sx, sy, 420);
      glow.addColorStop(0, warm ? "rgba(255,226,170,0.95)" : "rgba(255,255,240,0.8)");
      glow.addColorStop(1, "rgba(255,220,180,0)");
      g.fillStyle = glow;
      g.fillRect(0, 0, w, horizon);
      g.fillStyle = warm ? "#fff1d0" : "#fbfbf2";
      g.beginPath();
      g.arc(sx, sy, 46, 0, Math.PI * 2);
      g.fill();
      const layers = warm ? ["#7a5a74", "#4f3d5c", "#2c2440"] : ["#5d6f8a", "#3c4b66", "#222c42"];
      layers.forEach((col, n) => {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(0, horizon);
        let y = horizon - 120 + n * 40;
        for (let x = 0; x <= w; x += 60) {
          y += (r() - 0.5) * 90;
          y = Math.min(horizon - 10, Math.max(horizon - 330 + n * 70, y));
          g.lineTo(x, y);
        }
        g.lineTo(w, horizon);
        g.fill();
      });
      const water = g.createLinearGradient(0, horizon, 0, h);
      water.addColorStop(0, warm ? "#c98a73" : "#7d97b5");
      water.addColorStop(1, warm ? "#2a2236" : "#101a2c");
      g.fillStyle = water;
      g.fillRect(0, horizon, w, h - horizon);
      for (let i = 0; i < 140; i++) {
        const y = horizon + 6 + r() * (h - horizon);
        const len = 30 + r() * 220;
        const x = sx - len / 2 + (r() - 0.5) * 300 * ((y - horizon) / (h - horizon) + 0.3);
        g.strokeStyle = `rgba(255,${warm ? 225 : 250},${warm ? 180 : 235},${0.08 + r() * 0.3})`;
        g.lineWidth = 2 + r() * 3;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + len, y);
        g.stroke();
      }
    });
  }

  function portrait() {
    return paint(1200, 1600, (g, w, h) => {
      const bg = g.createRadialGradient(w * 0.35, h * 0.3, 50, w * 0.5, h * 0.5, h * 0.8);
      bg.addColorStop(0, "#3b3540");
      bg.addColorStop(1, "#0d0c10");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#16141a";
      g.beginPath();
      g.ellipse(w * 0.5, h * 0.36, 190, 240, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(w * 0.5 - 110, h * 0.5);
      g.bezierCurveTo(w * 0.1, h * 0.62, w * 0.02, h * 0.8, 0, h);
      g.lineTo(w, h);
      g.bezierCurveTo(w * 0.98, h * 0.8, w * 0.9, h * 0.62, w * 0.5 + 110, h * 0.5);
      g.fill();
      g.strokeStyle = "rgba(99,217,221,0.55)";
      g.lineWidth = 6;
      g.shadowColor = "rgba(99,217,221,0.8)";
      g.shadowBlur = 30;
      g.beginPath();
      g.ellipse(w * 0.5, h * 0.36, 190, 240, 0, -Math.PI * 0.45, Math.PI * 0.35);
      g.stroke();
      g.shadowBlur = 0;
      const key = g.createRadialGradient(w * 0.38, h * 0.32, 10, w * 0.38, h * 0.32, 260);
      key.addColorStop(0, "rgba(255,214,186,0.35)");
      key.addColorStop(1, "rgba(255,214,186,0)");
      g.fillStyle = key;
      g.fillRect(0, 0, w, h);
    });
  }

  function bottle() {
    return paint(1200, 1500, (g, w, h) => {
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#efd9d2");
      bg.addColorStop(1, "#d9b9ae");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(80,40,30,0.18)";
      g.beginPath();
      g.ellipse(w / 2, h * 0.86, 300, 46, 0, 0, Math.PI * 2);
      g.fill();
      const glass = g.createLinearGradient(w / 2 - 230, 0, w / 2 + 230, 0);
      glass.addColorStop(0, "rgba(255,255,255,0.55)");
      glass.addColorStop(0.3, "rgba(244,222,205,0.35)");
      glass.addColorStop(1, "rgba(160,110,95,0.45)");
      g.fillStyle = glass;
      g.beginPath();
      g.roundRect(w / 2 - 230, h * 0.36, 460, h * 0.5, 50);
      g.fill();
      g.fillStyle = "#c79a5b";
      g.fillRect(w / 2 - 60, h * 0.27, 120, h * 0.1);
      g.fillStyle = "#1c1a1f";
      g.beginPath();
      g.roundRect(w / 2 - 90, h * 0.16, 180, h * 0.12, 18);
      g.fill();
      g.fillStyle = "#faf6f2";
      g.fillRect(w / 2 - 150, h * 0.52, 300, 170);
      g.fillStyle = "#1c1a1f";
      g.textAlign = "center";
      g.font = "600 46px Georgia, serif";
      g.fillText("LUMEN", w / 2, h * 0.52 + 75);
      g.font = "22px Georgia, serif";
      g.fillText("N°3 · EAU DE PARFUM", w / 2, h * 0.52 + 125);
    });
  }

  function swatches() {
    return paint(1400, 1400, (g, w, h) => {
      const r = rng(21);
      const cols = ["#c2a68c", "#8a6e5a", "#e7dccf", "#5b5f55", "#b7826a", "#d8c3a5", "#40383a", "#9fa58f", "#efe6da"];
      g.fillStyle = "#f3eee7";
      g.fillRect(0, 0, w, h);
      const n = 3;
      const pad = 70;
      const s = (w - pad * (n + 1)) / n;
      for (let i = 0; i < n * n; i++) {
        const x = pad + (i % n) * (s + pad);
        const y = pad + Math.floor(i / n) * (s + pad);
        g.fillStyle = cols[i];
        g.fillRect(x, y, s, s);
        for (let k = 0; k < 90; k++) {
          g.strokeStyle = `rgba(${r() > 0.5 ? "255,255,255" : "0,0,0"},${0.04 + r() * 0.06})`;
          g.lineWidth = 1 + r() * 2;
          const yy = y + r() * s;
          g.beginPath();
          g.moveTo(x, yy);
          g.lineTo(x + s, yy + (r() - 0.5) * 8);
          g.stroke();
        }
      }
    });
  }

  function logoSheet() {
    return paint(1600, 1000, (g, w, h) => {
      g.fillStyle = "#f4f4f1";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#14202b";
      g.beginPath();
      g.moveTo(w * 0.32, h * 0.7);
      g.lineTo(w * 0.32, h * 0.3);
      g.lineTo(w * 0.4, h * 0.3);
      g.lineTo(w * 0.52, h * 0.55);
      g.lineTo(w * 0.52, h * 0.3);
      g.lineTo(w * 0.6, h * 0.3);
      g.lineTo(w * 0.6, h * 0.7);
      g.lineTo(w * 0.52, h * 0.7);
      g.lineTo(w * 0.4, h * 0.45);
      g.lineTo(w * 0.4, h * 0.7);
      g.closePath();
      g.fill();
      g.fillStyle = "#3d8fb8";
      g.beginPath();
      g.arc(w * 0.66, h * 0.33, 26, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#14202b";
      g.font = "500 54px Helvetica, Arial, sans-serif";
      g.textAlign = "center";
      g.fillText("STUDIO NORD", w / 2, h * 0.86);
    });
  }

  function webHero() {
    return paint(1920, 1080, (g, w, h) => {
      const bg = g.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, "#0f1d29");
      bg.addColorStop(1, "#1f4256");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(0, 0, w, 90);
      g.fillStyle = "#e8f1f5";
      g.font = "600 30px Helvetica, Arial, sans-serif";
      g.fillText("STUDIO NORD", 80, 56);
      g.font = "700 104px Helvetica, Arial, sans-serif";
      g.fillText("Design that", 80, 420);
      g.fillText("travels north.", 80, 540);
      g.fillStyle = "#3d8fb8";
      g.fillRect(80, 640, 300, 84);
      g.fillStyle = "#fff";
      g.font = "600 32px Helvetica, Arial, sans-serif";
      g.fillText("See our work", 120, 694);
      g.fillStyle = "rgba(61,143,184,0.35)";
      g.beginPath();
      g.arc(w * 0.78, h * 0.55, 300, 0, Math.PI * 2);
      g.fill();
    });
  }

  function seed() {
    db = { seq: 1, boards: [], images: [], versions: [], comments: [] };
    browsers = {
      admin: { admin: true, unlocked: new Set(), store: new Map() },
      client: { admin: false, unlocked: new Set(), store: new Map() },
    };
    const t = now();
    const h = 3600;
    const d = 86400;

    const lumen = { id: id(), slug: "atelier-lumen", title: "Atelier Lumen — Spring lookbook", passcode: "lumen2026", rev: 1, created_at: t - 4 * d };
    const nord = { id: id(), slug: "studio-nord", title: "Studio Nord — Brand refresh", passcode: null, rev: 1, created_at: t - 9 * d };
    db.boards.push(lumen, nord);

    const place = (b, title, x, y, width, z, ...versions) => {
      const img = { id: id(), board_id: b.id, title, x, y, width, z };
      db.images.push(img);
      return versions.map((v, n) => addVersion(img.id, n + 1, v));
    };
    const comment = (v, fields) => {
      const c = { id: id(), version_id: v.id, parent_id: null, x: null, y: null, is_admin: false, resolved_at: null, ...fields };
      db.comments.push(c);
      return c;
    };
    const decide = (v, status, by, at) => Object.assign(v, { status, status_by: by, status_at: at });

    const [hero1, hero2] = place(lumen, "Lake at dawn", 0, 0, 960, 1,
      { ...lake(false), original_name: "lumen-lake-dawn.jpg", created_at: t - 3 * d },
      { ...lake(true), original_name: "lumen-lake-dawn-v2.jpg", created_at: t - 5 * h });
    const [port] = place(lumen, "Studio portrait", 1020, 0, 480, 2,
      { ...portrait(), original_name: "lumen-portrait-03.jpg", created_at: t - 3 * d });
    const [prod] = place(lumen, "Perfume N°3", 1560, 0, 512, 3,
      { ...bottle(), original_name: "lumen-n3-packshot.jpg", created_at: t - 3 * d });
    place(lumen, "Fabric swatches", 0, 720, 560, 4,
      { ...swatches(), original_name: "lumen-swatches.jpg", created_at: t - 2 * d });

    const sky = comment(hero1, { x: 0.58, y: 0.22, author: "Anna Keller", body: "The sky feels a bit cold. Can we warm up the sunrise?", created_at: t - 2 * d - 3 * h, resolved_at: t - 5 * h });
    comment(hero1, { parent_id: sky.id, author: "Betch", is_admin: true, body: "Yes, I'll push the warmth and lift the highlights a touch. New version coming.", created_at: t - 2 * d });
    decide(hero1, "changes_requested", "Anna Keller", t - 2 * d - 3 * h);
    void hero2;

    comment(port, { x: 0.36, y: 0.24, author: "Anna Keller", body: "Love the rim light on this one.", created_at: t - 1 * d - 2 * h });
    decide(port, "approved", "Anna Keller", t - 1 * d - 2 * h);

    comment(prod, { x: 0.5, y: 0.58, author: "Anna Keller", body: "Can the label be a little larger? It's hard to read on phones.", created_at: t - 20 * h });
    const pink = comment(prod, { x: 0.82, y: 0.14, author: "Marc Roux", body: "Background is a touch too pink for us.", created_at: t - 18 * h });
    comment(prod, { parent_id: pink.id, author: "Anna Keller", body: "Agreed, closer to sand would match the lookbook.", created_at: t - 17 * h });

    const [logo] = place(nord, "Logo, primary", 0, 0, 800, 1, { ...logoSheet(), original_name: "nord-logo-primary.png", created_at: t - 8 * d });
    place(nord, "Homepage hero", 860, 0, 800, 2, { ...webHero(), original_name: "nord-home-hero.png", created_at: t - 8 * d });
    decide(logo, "approved", "Jonas Berg", t - 6 * d);
  }

  window.Demo = {
    api,
    uploadForm,
    file,
    seed,
    get role() { return role; },
    set role(r) { role = r; },
    store: () => {
      const s = me().store;
      return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) };
    },
    boards: () => db.boards.map((b) => ({ slug: b.slug, title: b.title })),
    ADMIN_PASSWORD,
  };
  seed();
})();
