// Board editor core: state, geometry, edit transactions with undo/redo, and
// the link to the live connection. Other board-*.js files build on `B`.
"use strict";

const B = (window.B = {
  slug: "",
  board: null,
  role: "view",
  me: null,
  items: new Map(),       // id -> item (treated as immutable; edits replace the object)
  sel: new Set(),         // selected item ids
  comments: [],
  peers: new Map(),       // peer id -> { id, name, color, role, cursor, sel }
  view: { x: 0, y: 0, s: 1 },
  tool: "select",
  editingId: null,
  opts: {
    sticky: { color: "#fff59d" },
    shape: { shape: "rect" },
    pen: { color: "#ececf1", width: 3 },
    highlighter: { color: "#facc15", width: 18 },
    connector: { style: "curve" },
  },
  net: { send() {} },
});

B.ROLES = ["view", "comment", "edit", "owner"];
B.can = (role) => B.ROLES.indexOf(B.role) >= B.ROLES.indexOf(role);
B.canEdit = () => B.can("edit");

B.STICKY_COLORS = [
  "#fff59d", "#ffe082", "#ffcc80", "#ffab91", "#f8bbd0", "#e1bee7",
  "#c5cae9", "#b3e5fc", "#b2ebf2", "#c8e6c9", "#e6ee9c", "#eeeeee", "#ffffff", "#2b2b33",
];
B.COLORS = [
  "#0a0a0c", "#2b2b33", "#64748b", "#cbd5e1", "#ffffff", "#63d9dd",
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316", "#f59e0b",
  "#facc15", "#84cc16", "#22c55e", "#14b8a6",
];
B.SHAPES = ["rect", "round", "ellipse", "triangle", "diamond", "hexagon", "star", "parallelogram", "arrow", "speech"];

B.uid = () => {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
};

B.isDark = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.5;
};

// ---------------------------------------------------------------- geometry

/** Where a connector end sits: attached to an item side, or a free point. */
B.endPoint = (end) => {
  const it = end && end.id && B.items.get(end.id);
  if (it) {
    const b = B.bounds(it);
    const nx = end.nx ?? 0.5;
    const ny = end.ny ?? 0.5;
    let dir = null;
    if (ny === 0) dir = [0, -1];
    else if (ny === 1) dir = [0, 1];
    else if (nx === 0) dir = [-1, 0];
    else if (nx === 1) dir = [1, 0];
    return { x: b.x + nx * b.w, y: b.y + ny * b.h, dir, attached: true };
  }
  return { x: end ? end.x || 0 : 0, y: end ? end.y || 0 : 0, dir: null, attached: false };
};

B.bounds = (it) => {
  if (it.type === "connector") {
    const a = B.endPoint(it.from);
    const b = B.endPoint(it.to);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(1, Math.abs(a.x - b.x)), h: Math.max(1, Math.abs(a.y - b.y)) };
  }
  return { x: it.x, y: it.y, w: it.w, h: it.h };
};

B.unionBounds = (list) => {
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of list) {
    const b = B.bounds(it);
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

B.contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

B.intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Items fully inside a frame (they move with it). */
B.frameChildren = (frame) => {
  const fb = B.bounds(frame);
  return [...B.items.values()].filter((it) => it.id !== frame.id && it.type !== "frame" && B.contains(fb, B.bounds(it)));
};

let sortedCache = null;
/** Paint order: frames first (they sit behind everything), then by z. */
B.sorted = () => {
  if (!sortedCache) {
    sortedCache = [...B.items.values()].sort((a, b) => {
      const fa = a.type === "frame" ? 0 : 1;
      const fb = b.type === "frame" ? 0 : 1;
      return fa - fb || (a.z || 0) - (b.z || 0) || (a.id < b.id ? -1 : 1);
    });
  }
  return sortedCache;
};

B.topZ = () => {
  let z = 0;
  for (const it of B.items.values()) z = Math.max(z, it.z || 0);
  return z + 1;
};

B.bottomZ = () => {
  let z = 0;
  for (const it of B.items.values()) z = Math.min(z, it.z || 0);
  return z - 1;
};

B.selected = () => [...B.sel].map((id) => B.items.get(id)).filter(Boolean);

B.screenToBoard = (cx, cy) => {
  const r = B.dom.viewport.getBoundingClientRect();
  return { x: (cx - r.left - B.view.x) / B.view.s, y: (cy - r.top - B.view.y) / B.view.s };
};

B.boardToScreen = (x, y) => {
  const r = B.dom.viewport.getBoundingClientRect();
  return { x: r.left + B.view.x + x * B.view.s, y: r.top + B.view.y + y * B.view.s };
};

B.viewportCenter = () => {
  const r = B.dom.viewport.getBoundingClientRect();
  return B.screenToBoard(r.left + r.width / 2, r.top + r.height / 2);
};

// ---------------------------------------------------------------- change tracking

let frameRequested = false;
B.invalidate = (structural) => {
  if (structural !== false) sortedCache = null;
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    B.renderAll();
  });
};

B.setSelection = (ids) => {
  B.sel = new Set([...ids].filter((id) => B.items.has(id)));
  B.net.send({ t: "sel", ids: [...B.sel] });
  B.invalidate(false);
  B.onSelectionChange && B.onSelectionChange();
};

const LIVE_INTERVAL = 50;

/**
 * An edit transaction. Changes apply locally at once; `live()` streams them
 * to others while dragging; `commit()` saves them and records one undo step.
 */
class Tx {
  constructor() {
    this.before = new Map();
    this.lastLive = 0;
    this.liveTimer = null;
  }

  remember(id) {
    if (!this.before.has(id)) this.before.set(id, B.items.get(id) || null);
  }

  put(item) {
    this.remember(item.id);
    B.items.set(item.id, item);
    B.invalidate();
    return item;
  }

  update(id, patch) {
    const it = B.items.get(id);
    return it ? this.put({ ...it, ...patch }) : null;
  }

  del(id) {
    if (!B.items.has(id)) return;
    this.remember(id);
    B.items.delete(id);
    B.sel.delete(id);
    B.invalidate();
  }

  ops() {
    return [...this.before.keys()].map((id) => (B.items.has(id) ? { put: B.items.get(id) } : { del: id }));
  }

  /** Send current state to other viewers without saving (throttled). */
  live() {
    const now = performance.now();
    clearTimeout(this.liveTimer);
    if (now - this.lastLive >= LIVE_INTERVAL) {
      this.lastLive = now;
      B.net.send({ t: "ops", live: true, ops: this.ops() });
    } else {
      this.liveTimer = setTimeout(() => this.live(), LIVE_INTERVAL);
    }
  }

  commit() {
    clearTimeout(this.liveTimer);
    const before = new Map();
    const after = new Map();
    for (const [id, old] of this.before) {
      const cur = B.items.get(id) || null;
      if (JSON.stringify(old) === JSON.stringify(cur)) continue;
      before.set(id, old);
      after.set(id, cur);
    }
    if (!after.size) return false;
    B.history.undo.push({ before, after });
    if (B.history.undo.length > 200) B.history.undo.shift();
    B.history.redo = [];
    B.net.send({ t: "ops", ops: [...after].map(([id, it]) => (it ? { put: it } : { del: id })) });
    B.onHistoryChange && B.onHistoryChange();
    return true;
  }

  /** Throw the changes away. */
  cancel() {
    clearTimeout(this.liveTimer);
    for (const [id, old] of this.before) {
      if (old) B.items.set(id, old);
      else B.items.delete(id);
    }
    B.net.send({ t: "ops", live: true, ops: this.ops() });
    B.invalidate();
  }
}

B.begin = () => new Tx();

/** One-shot change: `B.change(tx => { tx.put(...) })`. */
B.change = (fn) => {
  const tx = B.begin();
  fn(tx);
  return tx.commit();
};

B.history = { undo: [], redo: [] };

function applyStates(states) {
  const ops = [];
  for (const [id, it] of states) {
    if (it) B.items.set(id, it);
    else {
      B.items.delete(id);
      B.sel.delete(id);
    }
    ops.push(it ? { put: it } : { del: id });
  }
  B.net.send({ t: "ops", ops });
  B.setSelection([...states].filter(([, it]) => it && it.type !== "frame").map(([id]) => id));
  B.invalidate();
  B.onHistoryChange && B.onHistoryChange();
}

B.undo = () => {
  const step = B.history.undo.pop();
  if (!step) return;
  B.history.redo.push(step);
  applyStates(step.before);
};

B.redo = () => {
  const step = B.history.redo.pop();
  if (!step) return;
  B.history.undo.push(step);
  applyStates(step.after);
};

/** Changes from other people: no undo entry, no echo. */
B.applyRemote = (ops) => {
  for (const op of ops) {
    if (op.put && op.put.id) {
      if (op.put.id === B.editingId) continue;
      B.items.set(op.put.id, op.put);
    } else if (op.del) {
      B.items.delete(op.del);
      if (B.sel.delete(op.del)) B.onSelectionChange && B.onSelectionChange();
    }
  }
  B.invalidate();
};

/** Delete items, plus connectors attached to them. */
B.deleteItems = (ids) => {
  const gone = new Set(ids);
  B.change((tx) => {
    for (const it of B.items.values()) {
      if (it.type === "connector" && ((it.from && gone.has(it.from.id)) || (it.to && gone.has(it.to.id)))) gone.add(it.id);
    }
    for (const id of gone) tx.del(id);
  });
  B.setSelection([]);
};

/** Copies of items with fresh ids, offset by (dx, dy); connectors between copied items stay linked. */
B.cloneItems = (items, dx, dy) => {
  const ids = new Map(items.map((it) => [it.id, B.uid()]));
  let z = B.topZ();
  const relink = (end) => {
    if (!end) return end;
    if (end.id && ids.has(end.id)) return { ...end, id: ids.get(end.id) };
    if (end.id) {
      const p = B.endPoint(end);
      return { x: p.x + dx, y: p.y + dy };
    }
    return { ...end, x: (end.x || 0) + dx, y: (end.y || 0) + dy };
  };
  return items
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((it) => {
      const copy = { ...structuredClone(it), id: ids.get(it.id), z: it.type === "frame" ? it.z : z++ };
      if (it.type === "connector") {
        copy.from = relink(it.from);
        copy.to = relink(it.to);
      } else {
        copy.x = it.x + dx;
        copy.y = it.y + dy;
      }
      return copy;
    });
};
