// Board start-up: access check, name prompt, live connection.
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);
  const NAME_KEY = "revo:name";
  const COLOR_KEY = "revo:color";
  const PEER_COLORS = ["#63d9dd", "#f97316", "#a78bfa", "#f472b6", "#facc15", "#4ade80", "#60a5fa", "#fb7185", "#2dd4bf", "#e879f9"];

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (_) {
        /* private mode: fine, we just ask again next time */
      }
    },
  };

  B.slug = decodeURIComponent((B.pathOverride || location.pathname).replace(/^\/+|\/+$/g, ""));

  async function boot() {
    let meta;
    try {
      meta = await api("GET", `/b/${encodeURIComponent(B.slug)}`);
    } catch (e) {
      if (e.code === "passcode_required") return showGate();
      if (e.status === 404) return show("#missing");
      toast(e.message, "error");
      return;
    }
    B.board = meta.board;
    B.role = meta.role;
    B.publicUrl = meta.public_url;
    const name = await chooseName();
    let color = store.get(COLOR_KEY);
    if (!PEER_COLORS.includes(color)) {
      color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
      store.set(COLOR_KEY, color);
    }
    B.me = { id: 0, name, color, role: B.role };
    $("#gate").hidden = true;
    $("#app").hidden = false;
    document.body.classList.toggle("read-only", !B.canEdit());
    B.dom = {
      viewport: $("#viewport"),
      world: $("#world"),
      layer: $("#layer"),
      selLayer: $("#sel-layer"),
      draftLayer: $("#draft-layer"),
      pinLayer: $("#pin-layer"),
    };
    B.initTools();
    B.initUI();
    B.setTool("select");
    B.applyView();
    connect();
  }

  function show(sel) {
    $(sel).hidden = false;
  }

  function showGate() {
    show("#gate");
    $("#gate-passcode").focus();
  }

  $("#gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#gate-error").textContent = "";
    try {
      await api("POST", `/b/${encodeURIComponent(B.slug)}/unlock`, { passcode: $("#gate-passcode").value });
      $("#gate").hidden = true;
      boot();
    } catch (err) {
      $("#gate-error").textContent = err.message;
    }
  });

  async function chooseName() {
    const saved = store.get(NAME_KEY);
    if (saved) return saved;
    if (B.role === "owner") return "Betch";
    const name = await modal((close) => {
      const input = h("input#guest-name", { type: "text", maxlength: 40, autocomplete: "name", placeholder: "Your name" });
      const submit = (e) => {
        e.preventDefault();
        close(input.value.trim() || "Guest");
      };
      return h("form", { onsubmit: submit },
        h("h2", "What's your name?"),
        h("p", "Others on this board see it next to your cursor and comments."),
        h("div.field", input),
        h("div.modal-actions", h("button.primary", { type: "submit" }, "Join board")));
    });
    const final = (name || "Guest").slice(0, 40);
    if (name) store.set(NAME_KEY, final);
    return final;
  }

  // ---------------------------------------------------------------- live connection

  let ws = null;
  let retry = 0;
  let welcomed = false;
  let firstWelcome = true;
  const queue = [];

  B.net.send = (msg) => {
    if (ws && ws.readyState === 1 && welcomed) {
      ws.send(JSON.stringify(msg));
    } else if (msg.t === "ops" && !msg.live) {
      queue.push(msg);
    }
  };

  function socketUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/api/b/${encodeURIComponent(B.slug)}/ws`;
  }

  function connect() {
    welcomed = false;
    ws = B.openSocket ? B.openSocket(socketUrl()) : new WebSocket(socketUrl());
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: B.me.name, color: B.me.color }));
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      receive(msg);
    };
    ws.onclose = () => {
      ws = null;
      welcomed = false;
      $("#conn-banner").hidden = false;
      B.peers.clear();
      B.renderPeers();
      const delay = Math.min(15000, 1000 * 2 ** retry++);
      setTimeout(reconnect, delay);
    };
  }

  async function reconnect() {
    // Check access first: the passcode or sharing may have changed.
    try {
      const meta = await api("GET", `/b/${encodeURIComponent(B.slug)}`);
      if (meta.role !== B.role) return location.reload();
      B.setBoardMeta(meta.board);
    } catch (e) {
      if (e.code === "passcode_required" || e.status === 404) return location.reload();
    }
    connect();
  }

  function receive(msg) {
    switch (msg.t) {
      case "welcome": {
        welcomed = true;
        retry = 0;
        $("#conn-banner").hidden = true;
        B.me = { ...B.me, ...msg.you };
        B.items = new Map(msg.items.map((it) => [it.id, it]));
        B.comments = msg.comments;
        B.peers = new Map(msg.peers.map((p) => [p.id, { ...p, cursor: null, sel: [] }]));
        // Changes made while offline go out now (last write wins).
        for (const m of queue.splice(0)) {
          B.applyRemote(m.ops);
          ws.send(JSON.stringify(m));
        }
        B.invalidate();
        B.renderAll();
        B.renderComments();
        B.renderPeers();
        if (firstWelcome) {
          firstWelcome = false;
          B.fitAll(false);
          if (!B.items.size && B.canEdit()) toast("Empty board. Pick a tool on the left, or press ? for shortcuts.");
        }
        break;
      }
      case "ops":
        B.applyRemote(msg.ops || []);
        break;
      case "peer":
        B.peers.set(msg.peer.id, { ...msg.peer, cursor: null, sel: [] });
        B.renderPeers();
        break;
      case "peer_left":
        B.peers.delete(msg.id);
        B.renderPeers();
        B.invalidate(false);
        break;
      case "cursor":
        B.updateCursor(msg.id, msg.x, msg.y);
        break;
      case "sel": {
        const p = B.peers.get(msg.id);
        if (p) {
          p.sel = msg.ids || [];
          B.invalidate(false);
        }
        break;
      }
      case "comment":
        B.upsertComment(msg.comment);
        break;
      case "comment_deleted":
        B.removeComment(msg.id);
        break;
      case "board":
        B.setBoardMeta(msg.board);
        break;
      case "reload":
      case "resync":
        if (ws) ws.close();
        break;
      case "error":
        toast(msg.message, "error");
        break;
    }
  }

  setInterval(() => B.net.send({ t: "ping" }), 25000);
  window.addEventListener("resize", () => B.dom && B.applyView());

  boot();
})();
