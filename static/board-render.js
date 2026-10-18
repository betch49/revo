// Board rendering: one DOM element per item, kept in paint order, plus the
// selection overlay. Positions are in board units inside #world, which is
// translated and scaled for pan and zoom.
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
function S(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}
B.svg = S;

B.fileUrl = (asset, variant) => `/files/${asset}/${variant || "display"}`;

const records = new Map(); // id -> { el, type, item, ...parts }

// ---------------------------------------------------------------- view

B.applyView = () => {
  const { x, y, s } = B.view;
  B.dom.world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  B.dom.world.style.setProperty("--inv", String(1 / s));
  // Dot grid follows the board.
  const g = 24 * s;
  const vp = B.dom.viewport.style;
  vp.backgroundSize = s < 0.25 ? "0 0" : `${g}px ${g}px`;
  vp.backgroundPosition = `${x}px ${y}px`;
  B.onViewChange && B.onViewChange();
};

// ---------------------------------------------------------------- shapes

B.shapePath = (kind, w, h, i) => {
  const x1 = i, y1 = i, x2 = w - i, y2 = h - i;
  const W = x2 - x1, H = y2 - y1;
  const poly = (pts) => "M" + pts.map(([px, py]) => `${x1 + px * W},${y1 + py * H}`).join("L") + "Z";
  switch (kind) {
    case "round": {
      const r = Math.min(W, H) * 0.18;
      return `M${x1 + r},${y1}H${x2 - r}Q${x2},${y1} ${x2},${y1 + r}V${y2 - r}Q${x2},${y2} ${x2 - r},${y2}H${x1 + r}Q${x1},${y2} ${x1},${y2 - r}V${y1 + r}Q${x1},${y1} ${x1 + r},${y1}Z`;
    }
    case "ellipse":
      return `M${x1},${y1 + H / 2}A${W / 2},${H / 2} 0 1 0 ${x2},${y1 + H / 2}A${W / 2},${H / 2} 0 1 0 ${x1},${y1 + H / 2}Z`;
    case "triangle":
      return poly([[0.5, 0], [1, 1], [0, 1]]);
    case "diamond":
      return poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case "hexagon":
      return poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case "parallelogram":
      return poly([[0.22, 0], [1, 0], [0.78, 1], [0, 1]]);
    case "arrow":
      return poly([[0, 0.28], [0.62, 0.28], [0.62, 0], [1, 0.5], [0.62, 1], [0.62, 0.72], [0, 0.72]]);
    case "star": {
      const pts = [];
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 0.2 : 0.5;
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        pts.push([0.5 + r * Math.cos(a) * 1.05, 0.55 + r * Math.sin(a) * 1.1]);
      }
      return poly(pts);
    }
    case "speech":
      return poly([[0, 0], [1, 0], [1, 0.75], [0.42, 0.75], [0.2, 1], [0.24, 0.75], [0, 0.75]]);
    default:
      return poly([[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
};

/** Area inside a shape where its text goes, as fractions of the box. */
function textArea(kind) {
  switch (kind) {
    case "triangle": return [0.2, 0.4, 0.6, 0.55];
    case "diamond": return [0.2, 0.2, 0.6, 0.6];
    case "star": return [0.3, 0.35, 0.4, 0.4];
    case "ellipse": return [0.12, 0.12, 0.76, 0.76];
    case "speech": return [0.04, 0.04, 0.92, 0.68];
    case "arrow": return [0.04, 0.3, 0.7, 0.4];
    case "parallelogram": return [0.2, 0.06, 0.6, 0.88];
    default: return [0.06, 0.06, 0.88, 0.88];
  }
}

// ---------------------------------------------------------------- connectors

/** Points and SVG path for a connector. */
B.connectorGeometry = (it) => {
  const a = B.endPoint(it.from);
  const b = B.endPoint(it.to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const style = it.style || "curve";
  let d;
  let pts;
  let tanA;
  let tanB;
  if (style === "straight") {
    d = `M${a.x},${a.y}L${b.x},${b.y}`;
    pts = [a, b];
    tanA = [a.x - b.x, a.y - b.y];
    tanB = [dx, dy];
  } else if (style === "elbow") {
    const off = 24;
    const da = a.dir || (Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1]);
    const db = b.dir || (Math.abs(dx) >= Math.abs(dy) ? [-(Math.sign(dx) || 1), 0] : [0, -(Math.sign(dy) || 1)]);
    const pa = { x: a.x + da[0] * (a.dir ? off : 0), y: a.y + da[1] * (a.dir ? off : 0) };
    const pb = { x: b.x + db[0] * (b.dir ? off : 0), y: b.y + db[1] * (b.dir ? off : 0) };
    pts = [a, pa];
    if (da[0] !== 0) {
      const mx = db[0] !== 0 ? (pa.x + pb.x) / 2 : pb.x;
      pts.push({ x: mx, y: pa.y }, { x: mx, y: pb.y });
    } else {
      const my = db[1] !== 0 ? (pa.y + pb.y) / 2 : pb.y;
      pts.push({ x: pa.x, y: my }, { x: pb.x, y: my });
    }
    pts.push(pb, b);
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
    d = "M" + pts.map((p) => `${p.x},${p.y}`).join("L");
    const n = pts.length;
    tanA = n > 1 ? [pts[0].x - pts[1].x, pts[0].y - pts[1].y] : [-1, 0];
    tanB = n > 1 ? [pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y] : [1, 0];
  } else {
    const k = Math.max(40, dist * 0.4);
    const da = a.dir || [dx / dist, dy / dist];
    const db = b.dir || [-dx / dist, -dy / dist];
    const c1 = { x: a.x + da[0] * k, y: a.y + da[1] * k };
    const c2 = { x: b.x + db[0] * k, y: b.y + db[1] * k };
    d = `M${a.x},${a.y}C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
    pts = [a, c1, c2, b];
    tanA = [a.x - c1.x, a.y - c1.y];
    tanB = [b.x - c2.x, b.y - c2.y];
  }
  return { a, b, d, pts, tanA, tanB };
};

function capPath(kind, p, tan, w) {
  if (!kind || kind === "none") return "";
  const len = Math.hypot(tan[0], tan[1]) || 1;
  const ux = tan[0] / len;
  const uy = tan[1] / len;
  const size = 8 + w * 2.5;
  if (kind === "dot") {
    const r = 3 + w;
    return `M${p.x - r},${p.y}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0Z`;
  }
  const bx = p.x - ux * size;
  const by = p.y - uy * size;
  const px = -uy * size * 0.55;
  const py = ux * size * 0.55;
  return `M${p.x},${p.y}L${bx + px},${by + py}L${bx - px},${by - py}Z`;
}

/** Smooth path through freehand points (relative to the item). */
function strokeD(points) {
  if (!points || !points.length) return "";
  if (points.length < 3) {
    const [p0] = points;
    const p1 = points[points.length - 1];
    return `M${p0[0]},${p0[1]}L${p1[0] + 0.01},${p1[1]}`;
  }
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
  }
  const last = points[points.length - 1];
  return d + `L${last[0]},${last[1]}`;
}
B.strokeD = strokeD;

// ---------------------------------------------------------------- items

const AUTO_SIZES = [64, 48, 40, 32, 28, 24, 20, 18, 16, 14, 12, 10, 8];
const STICKY_SIZES = { s: 14, m: 20, l: 28, xl: 40 };

/** Largest size where the text fits without splitting words. */
function fitText(txt, maxH) {
  txt.style.overflowWrap = "normal";
  txt.style.wordBreak = "normal";
  let fitted = false;
  for (const size of AUTO_SIZES) {
    txt.style.fontSize = size + "px";
    if (txt.scrollHeight <= maxH + 1 && txt.scrollWidth <= txt.clientWidth + 1) {
      fitted = true;
      break;
    }
  }
  // Very long words: allow breaking them at the smallest size.
  txt.style.overflowWrap = fitted ? "" : "anywhere";
  txt.style.wordBreak = "";
}

function create(it) {
  let rec;
  if (it.type === "connector") {
    const el = S("svg", { class: "it connector" });
    rec = { el, hit: S("path", { class: "hit" }), path: S("path", { class: "line" }), capA: S("path", { class: "cap" }), capB: S("path", { class: "cap" }) };
    el.append(rec.hit, rec.path, rec.capA, rec.capB);
  } else if (it.type === "draw") {
    const el = S("svg", { class: "it draw" });
    rec = { el, hit: S("path", { class: "hit" }), path: S("path", { class: "line" }) };
    el.append(rec.hit, rec.path);
  } else {
    const el = h("div.it." + it.type);
    rec = { el };
    if (it.type === "shape") {
      rec.svg = S("svg", { class: "shape-svg" });
      rec.path = S("path");
      rec.svg.append(rec.path);
      el.append(rec.svg);
    }
    if (it.type === "image") {
      rec.img = h("img", { alt: "", draggable: "false", decoding: "async" });
      el.append(rec.img);
    }
    if (it.type === "frame") {
      rec.title = h("div.frame-title");
      el.append(rec.title);
    }
    if (it.type === "sticky" || it.type === "shape" || it.type === "text") {
      rec.txt = h("div.txt");
      el.append(rec.txt);
    }
  }
  rec.el.dataset.id = it.id;
  rec.type = it.type;
  return rec;
}

function place(el, x, y, w, h) {
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
}

function setText(rec, it) {
  if (B.editingId === it.id) return;
  if (rec.txt.textContent !== (it.text || "")) rec.txt.textContent = it.text || "";
}

function update(rec, it) {
  const el = rec.el;
  el.classList.toggle("locked", !!it.locked);
  switch (it.type) {
    case "sticky": {
      place(el, it.x, it.y, it.w, it.h);
      el.style.background = it.color || "#fff59d";
      el.classList.toggle("on-dark", B.isDark(it.color));
      rec.txt.style.textAlign = it.align || "center";
      setText(rec, it);
      const key = `${it.text}|${it.w}|${it.h}|${it.fontSize}`;
      if (rec.fitKey !== key || B.editingId === it.id) {
        rec.fitKey = key;
        if (STICKY_SIZES[it.fontSize]) rec.txt.style.fontSize = STICKY_SIZES[it.fontSize] + "px";
        else fitText(rec.txt, it.h - 24);
      }
      break;
    }
    case "text": {
      el.style.left = it.x + "px";
      el.style.top = it.y + "px";
      el.style.width = it.w + "px";
      el.style.height = "";
      const t = rec.txt.style;
      t.fontSize = (it.fontSize || 24) + "px";
      t.color = it.color || "#ececf1";
      t.fontWeight = it.bold ? "700" : "400";
      t.fontStyle = it.italic ? "italic" : "normal";
      t.textAlign = it.align || "left";
      setText(rec, it);
      el.classList.toggle("empty", !it.text && B.editingId !== it.id);
      const measured = el.offsetHeight;
      if (measured && Math.abs(measured - it.h) > 0.5) {
        // Height follows the text; keep it locally so selection fits.
        const next = { ...it, h: measured };
        B.items.set(it.id, next);
        rec.item = next;
      }
      break;
    }
    case "shape": {
      place(el, it.x, it.y, it.w, it.h);
      const sw = it.strokeWidth ?? 2;
      rec.svg.setAttribute("width", it.w);
      rec.svg.setAttribute("height", it.h);
      rec.svg.setAttribute("viewBox", `0 0 ${it.w} ${it.h}`);
      rec.path.setAttribute("d", B.shapePath(it.shape, it.w, it.h, Math.max(0.5, sw / 2)));
      rec.path.setAttribute("fill", it.fill || "transparent");
      rec.path.setAttribute("stroke", sw > 0 ? it.stroke || "#63d9dd" : "none");
      rec.path.setAttribute("stroke-width", sw);
      const [ax, ay, aw, ah] = textArea(it.shape);
      const t = rec.txt.style;
      t.left = ax * 100 + "%";
      t.top = ay * 100 + "%";
      t.width = aw * 100 + "%";
      t.height = ah * 100 + "%";
      t.color = it.textColor || (B.isDark(it.fill) || !it.fill || it.fill === "transparent" ? "#ececf1" : "#0a0a0c");
      t.fontSize = (it.fontSize || 20) + "px";
      t.fontWeight = it.bold ? "700" : "500";
      t.textAlign = it.align || "center";
      setText(rec, it);
      break;
    }
    case "image": {
      place(el, it.x, it.y, it.w, it.h);
      const src = B.fileUrl(it.asset, "display");
      if (rec.src !== src) {
        rec.src = src;
        rec.img.src = src;
      }
      break;
    }
    case "frame": {
      place(el, it.x, it.y, it.w, it.h);
      el.style.background = it.fill || "#16161b";
      if (rec.title.textContent !== (it.title || "Frame")) rec.title.textContent = it.title || "Frame";
      break;
    }
    case "draw": {
      const pad = (it.width || 3) + 4;
      el.setAttribute("width", it.w + pad * 2);
      el.setAttribute("height", it.h + pad * 2);
      el.setAttribute("viewBox", `${-pad} ${-pad} ${it.w + pad * 2} ${it.h + pad * 2}`);
      el.style.left = it.x - pad + "px";
      el.style.top = it.y - pad + "px";
      const d = strokeD(it.points);
      rec.path.setAttribute("d", d);
      rec.path.setAttribute("stroke", it.color || "#ececf1");
      rec.path.setAttribute("stroke-width", it.width || 3);
      rec.path.setAttribute("stroke-opacity", it.opacity ?? 1);
      rec.hit.setAttribute("d", d);
      rec.hit.setAttribute("stroke-width", Math.max(12, (it.width || 3) + 8));
      break;
    }
    case "connector": {
      const g = B.connectorGeometry(it);
      const w = it.strokeWidth || 2;
      const pad = 20 + w * 3;
      const xs = g.pts.map((p) => p.x);
      const ys = g.pts.map((p) => p.y);
      const x1 = Math.min(...xs) - pad;
      const y1 = Math.min(...ys) - pad;
      const bw = Math.max(...xs) - x1 + pad;
      const bh = Math.max(...ys) - y1 + pad;
      el.style.left = x1 + "px";
      el.style.top = y1 + "px";
      el.setAttribute("width", bw);
      el.setAttribute("height", bh);
      el.setAttribute("viewBox", `${x1} ${y1} ${bw} ${bh}`);
      const color = it.stroke || "#ececf1";
      for (const p of [rec.hit, rec.path]) p.setAttribute("d", g.d);
      rec.path.setAttribute("stroke", color);
      rec.path.setAttribute("stroke-width", w);
      rec.path.setAttribute("stroke-dasharray", it.dash ? `${w * 4} ${w * 3}` : "none");
      rec.hit.setAttribute("stroke-width", Math.max(14, w + 10));
      rec.capA.setAttribute("d", capPath(it.startCap, g.a, g.tanA, w));
      rec.capB.setAttribute("d", capPath(it.endCap ?? "arrow", g.b, g.tanB, w));
      rec.capA.setAttribute("fill", color);
      rec.capB.setAttribute("fill", color);
      break;
    }
  }
}

B.recordFor = (id) => records.get(id);

B.renderAll = () => {
  const layer = B.dom.layer;
  const present = new Set();
  let prev = null;
  for (const it of B.sorted()) {
    present.add(it.id);
    let rec = records.get(it.id);
    if (!rec || rec.type !== it.type) {
      if (rec) rec.el.remove();
      rec = create(it);
      records.set(it.id, rec);
    }
    // Insert before updating: text fitting needs the element on the page.
    const expected = prev ? prev.nextSibling : layer.firstChild;
    if (expected !== rec.el) layer.insertBefore(rec.el, expected);
    prev = rec.el;
    // Connectors follow the items they're attached to, so always refresh them.
    if (rec.item !== it || it.type === "connector") {
      rec.item = it;
      update(rec, it);
    }
  }
  for (const [id, rec] of records) {
    if (!present.has(id)) {
      rec.el.remove();
      records.delete(id);
    }
  }
  renderSelection();
  B.afterRender && B.afterRender();
};

// ---------------------------------------------------------------- selection overlay

function outline(b, cls, color) {
  const el = h("div." + cls);
  place(el, b.x, b.y, b.w, b.h);
  if (color) el.style.setProperty("--peer", color);
  return el;
}

function handle(name, x, y) {
  const el = h("div.handle", { dataset: { handle: name } });
  el.style.left = x + "px";
  el.style.top = y + "px";
  return el;
}

/** Which resize handles the current selection gets. */
B.handlesFor = (items) => {
  if (!B.canEdit() || !items.length || items.some((it) => it.locked)) return [];
  if (items.length === 1) {
    const t = items[0].type;
    if (t === "connector") return [];
    if (t === "text") return ["w", "e"];
    return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  }
  return ["nw", "ne", "se", "sw"];
};

function renderSelection() {
  const layer = B.dom.selLayer;
  layer.replaceChildren();
  for (const p of B.peers.values()) {
    for (const id of p.sel || []) {
      const it = B.items.get(id);
      if (it && !B.sel.has(id)) layer.append(outline(B.bounds(it), "peer-outline", p.color));
    }
  }
  const items = B.selected();
  if (!items.length || B.editingId) return;
  for (const it of items) {
    if (it.type === "connector") {
      const g = B.connectorGeometry(it);
      if (B.canEdit() && items.length === 1 && !it.locked) {
        for (const [name, p] of [["from", g.a], ["to", g.b]]) {
          const el = handle(name, p.x, p.y);
          el.classList.add("end");
          if (p.attached) el.classList.add("attached");
          layer.append(el);
        }
      }
      continue;
    }
    layer.append(outline(B.bounds(it), "sel-outline"));
  }
  const box = B.unionBounds(items);
  if (items.length > 1) layer.append(outline(box, "group-outline"));
  const pos = {
    nw: [box.x, box.y], n: [box.x + box.w / 2, box.y], ne: [box.x + box.w, box.y],
    e: [box.x + box.w, box.y + box.h / 2], se: [box.x + box.w, box.y + box.h],
    s: [box.x + box.w / 2, box.y + box.h], sw: [box.x, box.y + box.h], w: [box.x, box.y + box.h / 2],
  };
  for (const name of B.handlesFor(items)) layer.append(handle(name, ...pos[name]));
  if (items.length === 1 && items[0].locked) {
    const lock = h("div.lock-badge", "Locked");
    lock.style.left = box.x + "px";
    lock.style.top = box.y + "px";
    layer.append(lock);
  }
}
B.renderSelection = renderSelection;

// Text was fitted with the fallback font; refit once Space Grotesk has loaded.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    for (const rec of records.values()) {
      rec.fitKey = null;
      rec.item = null;
    }
    if (B.dom) B.invalidate();
  });
}
