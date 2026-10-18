// In-browser stand-in for the Rust server, used only by the demo build
// (demo/build.py). It answers the same API calls and imitates the live
// connection, so the real board code runs unchanged. A simulated teammate
// shows what working together looks like.
"use strict";

(() => {
  const SLUG = "brand-workshop";
  const SAVE_KEY = "revo-demo:v1";
  const now = () => Math.floor(Date.now() / 1000);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let state;
  let socket = null;
  let nextComment = 100;
  let nextAsset = 1;

  function fail(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    throw e;
  }

  // ---------------------------------------------------------------- sample board

  function paint(w, hgt, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    draw(c.getContext("2d"), w, hgt);
    return c.toDataURL("image/jpeg", 0.85);
  }

  function photo() {
    return paint(900, 600, (g, w, hgt) => {
      const sky = g.createLinearGradient(0, 0, 0, hgt);
      sky.addColorStop(0, "#2b3560");
      sky.addColorStop(0.55, "#d9826a");
      sky.addColorStop(1, "#f6c48b");
      g.fillStyle = sky;
      g.fillRect(0, 0, w, hgt);
      g.fillStyle = "#fff1d0";
      g.beginPath();
      g.arc(w * 0.62, hgt * 0.52, 34, 0, Math.PI * 2);
      g.fill();
      ["#7a5a74", "#4f3d5c", "#2c2440"].forEach((col, n) => {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(0, hgt);
        for (let x = 0; x <= w; x += 30) g.lineTo(x, hgt * (0.55 + n * 0.1) + Math.sin(x / (70 + n * 25) + n) * 28);
        g.lineTo(w, hgt);
        g.fill();
      });
    });
  }

  function seed() {
    const t = now();
    const items = [];
    let z = 1;
    const add = (it) => items.push({ z: z++, ...it });
    add({ id: "frame1", type: "frame", x: -40, y: -60, w: 1480, h: 900, z: -10, title: "Café Mila · Brand workshop", fill: "#16161b" });
    add({ id: "title", type: "text", x: 20, y: 0, w: 640, h: 50, text: "What should Café Mila feel like?", fontSize: 36, bold: true, color: "#ececf1" });
    add({ id: "hl", type: "draw", x: 22, y: 58, w: 300, h: 2, points: [[0, 0], [300, 2]], color: "#63d9dd", width: 14, opacity: 0.4 });
    const notes = [
      ["Warm & local", "#fff59d"], ["Honest prices", "#ffcc80"], ["Slow mornings", "#b3e5fc"],
      ["Neighbourhood living room", "#c8e6c9"], ["Not another chain", "#f8bbd0"], ["Good light, plants", "#e1bee7"],
    ];
    notes.forEach(([text, color], i) => add({ id: "n" + i, type: "sticky", x: 20 + (i % 3) * 220, y: 110 + Math.floor(i / 3) * 220, w: 200, h: 200, color, text }));
    add({ id: "s1", type: "shape", shape: "round", x: 760, y: 120, w: 180, h: 100, fill: "#1f1f26", stroke: "#63d9dd", strokeWidth: 2, text: "Values", fontSize: 20 });
    add({ id: "s2", type: "shape", shape: "diamond", x: 1010, y: 110, w: 190, h: 120, fill: "#1f1f26", stroke: "#facc15", strokeWidth: 2, text: "Pick 3", fontSize: 20 });
    add({ id: "s3", type: "shape", shape: "ellipse", x: 1010, y: 330, w: 190, h: 110, fill: "#63d9dd", stroke: "#63d9dd", strokeWidth: 2, text: "Brand brief", fontSize: 20 });
    add({ id: "c1", type: "connector", from: { id: "s1", nx: 1, ny: 0.5 }, to: { id: "s2", nx: 0, ny: 0.5 }, style: "curve", stroke: "#ececf1", strokeWidth: 2, startCap: "none", endCap: "arrow" });
    add({ id: "c2", type: "connector", from: { id: "s2", nx: 0.5, ny: 1 }, to: { id: "s3", nx: 0.5, ny: 0 }, style: "elbow", stroke: "#ececf1", strokeWidth: 2, startCap: "none", endCap: "arrow" });
    add({ id: "img", type: "image", asset: "a0", x: 760, y: 500, w: 450, h: 300, name: "mood-sunrise.jpg" });
    add({ id: "cap", type: "text", x: 1230, y: 500, w: 190, h: 60, text: "Mood: early light over the lake", fontSize: 16, color: "#8d8d9b" });
    return {
      board: { id: 1, slug: SLUG, title: "Café Mila — Brand workshop", access: "edit", has_passcode: false },
      items,
      assets: { a0: photo() },
      comments: [
        { id: 1, parent_id: null, x: 440, y: 330, author: "Anna Keller", is_owner: false, body: "Can we merge “Slow mornings” and “Good light”? Feels like one idea.", resolved_at: null, created_at: t - 3600 * 5 },
        { id: 2, parent_id: 1, x: null, y: null, author: "Betch", is_owner: true, body: "Good call, let's vote on it Friday.", resolved_at: null, created_at: t - 3600 * 4 },
      ],
    };
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      if (saved && saved.items) return saved;
    } catch (_) {
      /* storage blocked: start fresh */
    }
    return seed();
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      } catch (_) {
        /* quota or blocked storage: the demo keeps working, just without saving */
      }
    }, 400);
  }

  state = load();
  for (const c of state.comments) nextComment = Math.max(nextComment, c.id + 1);
  for (const k of Object.keys(state.assets)) nextAsset = Math.max(nextAsset, Number(k.slice(1)) + 1);

  // ---------------------------------------------------------------- API

  function emit(msg) {
    if (socket && socket.onmessage) setTimeout(() => socket.onmessage({ data: JSON.stringify(msg) }), 0);
  }

  async function demoApi(method, path, body) {
    await new Promise((r) => setTimeout(r, 40));
    const base = `/b/${SLUG}`;
    if (method === "GET" && path === base) return { board: clone(state.board), role: "owner", public_url: "https://review.betch.ch" };
    if (method === "PATCH" && path === `/admin/boards/${state.board.id}`) {
      if (body.title !== undefined) {
        if (!body.title.trim()) fail(400, "bad_request", "Title is required");
        state.board.title = body.title.trim().slice(0, 120);
      }
      if (body.access) state.board.access = body.access;
      if (body.passcode !== undefined && body.passcode !== null) state.board.has_passcode = !!body.passcode.trim();
      save();
      return clone(state.board);
    }
    if (method === "POST" && path === `${base}/comments`) {
      if (!body.body || !body.body.trim()) fail(400, "bad_request", "Comment is required");
      const c = {
        id: nextComment++, parent_id: body.parent_id ?? null, x: body.parent_id ? null : body.x, y: body.parent_id ? null : body.y,
        author: body.author || "Betch", is_owner: true, body: body.body.trim().slice(0, 4000), resolved_at: null, created_at: now(),
      };
      state.comments.push(c);
      save();
      return clone(c);
    }
    let m = path.match(/^\/b\/[^/]+\/comments\/(\d+)\/resolve$/);
    if (method === "POST" && m) {
      const c = state.comments.find((x) => x.id === Number(m[1])) || fail(404, "not_found", "not found");
      c.resolved_at = body.resolved ? now() : null;
      save();
      return clone(c);
    }
    m = path.match(/^\/b\/[^/]+\/comments\/(\d+)$/);
    if (method === "DELETE" && m) {
      const id = Number(m[1]);
      state.comments = state.comments.filter((c) => c.id !== id && c.parent_id !== id);
      save();
      return { ok: true };
    }
    fail(404, "not_found", "not found");
  }

  async function demoUpload(path, form, onProgress) {
    const file = form.get("file");
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) fail(400, "bad_request", "Unsupported file. Upload JPEG, PNG, WebP or GIF images.");
    onProgress && onProgress(0.5);
    const bmp = await createImageBitmap(file).catch(() => fail(400, "bad_request", "Could not read this image"));
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const id = "a" + nextAsset++;
    state.assets[id] = c.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.86);
    onProgress && onProgress(1);
    save();
    return { id, w: bmp.width, h: bmp.height };
  }

  // ---------------------------------------------------------------- live connection

  const TEAMMATE = { id: 7, name: "Anna Keller", color: "#f472b6", role: "edit" };

  class DemoSocket {
    constructor() {
      this.readyState = 1;
      socket = this;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }

    send(text) {
      const msg = JSON.parse(text);
      if (msg.t === "hello") {
        emit({ t: "welcome", you: { id: 1, name: msg.name, color: msg.color, role: "owner" }, peers: Demo.teammate ? [TEAMMATE] : [], items: clone(state.items), comments: clone(state.comments) });
      } else if (msg.t === "ops" && !msg.live) {
        for (const op of msg.ops) {
          const i = op.put ? state.items.findIndex((it) => it.id === op.put.id) : state.items.findIndex((it) => it.id === op.del);
          if (op.put) {
            if (i >= 0) state.items[i] = op.put;
            else state.items.push(op.put);
          } else if (i >= 0) state.items.splice(i, 1);
        }
        save();
      }
    }

    close() {
      this.readyState = 3;
      setTimeout(() => this.onclose && this.onclose(), 0);
    }
  }

  // ---------------------------------------------------------------- simulated teammate

  let botTimer = null;
  let botStep = 0;
  let botPos = { x: 600, y: 300 };

  function botTick() {
    if (!Demo.teammate || !socket) return;
    botStep++;
    const targets = state.items.filter((it) => it.type !== "connector" && it.type !== "frame");
    if (botStep % 6 === 0 && targets.length) {
      const it = targets[Math.floor(Math.random() * targets.length)];
      emit({ t: "sel", id: TEAMMATE.id, ids: [it.id] });
    }
    if (botStep === 4 && !state.items.some((it) => it.id === "anna-note")) {
      const note = { id: "anna-note", type: "sticky", x: 460, y: 560, w: 200, h: 200, z: 50, color: "#f8bbd0", text: "Love the lake photo as the mood!" };
      state.items.push(note);
      save();
      emit({ t: "ops", from: TEAMMATE.id, ops: [{ put: note }] });
      botPos = { x: 560, y: 660 };
    }
    // Wander toward a random item.
    const goal = targets.length ? targets[botStep % targets.length] : { x: 0, y: 0, w: 0, h: 0 };
    const gx = (goal.x || 0) + (goal.w || 0) * 0.6;
    const gy = (goal.y || 0) + (goal.h || 0) * 0.5;
    const steps = 12;
    let k = 0;
    const from = { ...botPos };
    const move = () => {
      if (!Demo.teammate) return;
      k++;
      const e = k / steps;
      botPos = { x: from.x + (gx - from.x) * e, y: from.y + (gy - from.y) * e };
      emit({ t: "cursor", id: TEAMMATE.id, x: Math.round(botPos.x), y: Math.round(botPos.y) });
      if (k < steps) setTimeout(move, 90);
    };
    move();
  }

  function setTeammate(on) {
    Demo.teammate = on;
    clearInterval(botTimer);
    if (on) {
      emit({ t: "peer", peer: TEAMMATE });
      botTimer = setInterval(botTick, 2200);
    } else {
      emit({ t: "peer_left", id: TEAMMATE.id });
    }
  }

  // ---------------------------------------------------------------- wire into the board code

  window.Demo = {
    teammate: true,
    setTeammate,
    reset() {
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch (_) {
        /* nothing saved */
      }
      state = seed();
      emit({ t: "resync" });
    },
  };
  window.api = demoApi;
  window.uploadForm = demoUpload;
  B.pathOverride = "/" + SLUG;
  B.openSocket = () => new DemoSocket();
  B.fileUrl = (asset) => state.assets[asset] || "";
  setTimeout(() => setTeammate(true), 2500);
})();
