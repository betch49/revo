// Board interaction: tools, pointer gestures, text editing, keyboard
// shortcuts, clipboard and zoom.
"use strict";

(() => {
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 6;
  const DRAG_PX = 4;
  const SNAP_PX = 6;
  const CLIP_MARK = "revo-board-items:";
  const DOUBLE_CLICK_MS = 350;

  const pointers = new Map();
  let gesture = null;
  let spaceDown = false;
  let lastPointer = null;
  let lastClick = { t: 0, id: null, x: 0, y: 0 };
  let editing = null;

  const vp = () => B.dom.viewport;
  const textTypes = new Set(["sticky", "shape", "text"]);

  // ---------------------------------------------------------------- tools

  B.setTool = (tool) => {
    if (B.editingId) B.finishEditing();
    B.tool = tool;
    for (const t of ["select", "hand", "sticky", "text", "shape", "connector", "pen", "highlighter", "eraser", "frame", "comment"]) {
      vp().classList.toggle("tool-" + t, t === tool);
    }
    clearDraft();
    B.onToolChange && B.onToolChange();
  };

  function backToSelect() {
    B.setTool("select");
  }

  // ---------------------------------------------------------------- view

  let animation = null;

  function zoomAt(factor, cx, cy) {
    const r = vp().getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, B.view.s * factor));
    const k = s / B.view.s;
    B.view = { x: px - (px - B.view.x) * k, y: py - (py - B.view.y) * k, s };
    B.applyView();
  }

  function zoomCenter(factor) {
    const r = vp().getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  function animateTo(target, animate) {
    cancelAnimationFrame(animation);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      B.view = target;
      B.applyView();
      return;
    }
    const from = { ...B.view };
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 280);
      const e = 1 - Math.pow(1 - p, 3);
      B.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, s: from.s + (target.s - from.s) * e };
      B.applyView();
      if (p < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  }

  B.zoomTo = (b, animate = true, maxScale = 2) => {
    const r = vp().getBoundingClientRect();
    if (!b) {
      animateTo({ s: 1, x: r.width / 2, y: r.height / 2 }, animate);
      return;
    }
    const pad = Math.min(100, r.width * 0.08);
    const s = Math.min(maxScale, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1))));
    animateTo({ s, x: r.width / 2 - (b.x + b.w / 2) * s, y: r.height / 2 - (b.y + b.h / 2) * s }, animate);
  };

  B.fitAll = (animate = true) => B.zoomTo(B.unionBounds([...B.items.values()]), animate, 1);
  B.centerOn = (x, y) => {
    const r = vp().getBoundingClientRect();
    animateTo({ s: B.view.s, x: r.width / 2 - x * B.view.s, y: r.height / 2 - y * B.view.s }, true);
  };
  B.zoomIn = () => zoomCenter(1.25);
  B.zoomOut = () => zoomCenter(0.8);
  B.zoomReset = () => {
    const c = B.viewportCenter();
    const r = vp().getBoundingClientRect();
    animateTo({ s: 1, x: r.width / 2 - c.x, y: r.height / 2 - c.y }, true);
  };

  // ---------------------------------------------------------------- draft layer (previews)

  function clearDraft() {
    B.dom.draftLayer.replaceChildren();
  }

  function draftSvg() {
    let svg = B.dom.draftLayer.querySelector("svg");
    if (!svg) {
      svg = B.svg("svg", { class: "draft-svg", width: 1, height: 1 });
      B.dom.draftLayer.append(svg);
    }
    return svg;
  }

  function draftRect(x, y, w, hgt, cls) {
    let el = B.dom.draftLayer.querySelector("." + cls);
    if (!el) {
      el = h("div." + cls);
      B.dom.draftLayer.append(el);
    }
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.width = w + "px";
    el.style.height = hgt + "px";
    return el;
  }

  function guide(x1, y1, x2, y2) {
    const svg = draftSvg();
    svg.append(B.svg("line", { x1, y1, x2, y2, class: "guide" }));
  }

  function anchorsFor(it) {
    const svg = draftSvg();
    const b = B.bounds(it);
    for (const [nx, ny] of [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) {
      svg.append(B.svg("circle", { cx: b.x + nx * b.w, cy: b.y + ny * b.h, r: 5 / B.view.s, class: "anchor" }));
    }
  }

  // ---------------------------------------------------------------- hit testing

  function itemFromTarget(target) {
    const el = target.closest && target.closest(".it");
    if (!el) return null;
    if (el.classList.contains("frame") && !target.closest(".frame-title")) return null;
    return B.items.get(el.dataset.id) || null;
  }

  /** Where a connector end should go: snapped to an item side, or a free point. */
  function endAt(cx, cy, exclude, free) {
    const p = B.screenToBoard(cx, cy);
    if (!free) {
      for (const el of document.elementsFromPoint(cx, cy)) {
        const host = el.closest && el.closest(".it");
        if (!host || host.classList.contains("connector") || host.classList.contains("draw")) continue;
        const it = B.items.get(host.dataset.id);
        if (!it || it.id === exclude || it.type === "frame") continue;
        const b = B.bounds(it);
        const sides = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
        let best = sides[0];
        let bestD = Infinity;
        for (const s of sides) {
          const d = Math.hypot(b.x + s[0] * b.w - p.x, b.y + s[1] * b.h - p.y);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
        return { end: { id: it.id, nx: best[0], ny: best[1] }, item: it };
      }
    }
    return { end: { x: p.x, y: p.y }, item: null };
  }

  // ---------------------------------------------------------------- snapping

  function snapLines(excluded) {
    const r = vp().getBoundingClientRect();
    const a = B.screenToBoard(r.left, r.top);
    const b = B.screenToBoard(r.right, r.bottom);
    const view = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    const xs = [];
    const ys = [];
    for (const it of B.items.values()) {
      if (excluded.has(it.id) || it.type === "connector") continue;
      const bb = B.bounds(it);
      if (!B.intersects(bb, view)) continue;
      xs.push({ v: bb.x, b: bb }, { v: bb.x + bb.w / 2, b: bb }, { v: bb.x + bb.w, b: bb });
      ys.push({ v: bb.y, b: bb }, { v: bb.y + bb.h / 2, b: bb }, { v: bb.y + bb.h, b: bb });
    }
    return { xs, ys };
  }

  function snapAxis(edges, lines) {
    const limit = SNAP_PX / B.view.s;
    let best = null;
    for (const e of edges) {
      for (const l of lines) {
        const d = l.v - e;
        if (Math.abs(d) <= limit && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: l };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- pointer gestures

  function onDown(e) {
    if (e.target.closest(".no-canvas")) return;
    if (B.editingId) {
      if (e.target.closest(".txt[contenteditable]")) return;
      B.finishEditing();
    }
    B.closePopovers && B.closePopovers();
    cancelAnimationFrame(animation);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      vp().setPointerCapture(e.pointerId);
    } catch (_) {
      /* pointer already gone */
    }

    if (pointers.size === 2) {
      if (gesture && gesture.tx) gesture.tx.cancel();
      clearDraft();
      const [a, b] = [...pointers.values()];
      gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    if (pointers.size > 2) return;

    const start = { cx: e.clientX, cy: e.clientY, p: B.screenToBoard(e.clientX, e.clientY), view: { ...B.view } };
    const hit = itemFromTarget(e.target);
    const handleEl = e.target.closest(".handle");

    if (e.button === 1 || e.button === 2 || spaceDown || B.tool === "hand") {
      gesture = { type: "pan", start, right: e.button === 2, hit };
      return;
    }
    switch (B.tool) {
      case "select":
        if (handleEl && B.canEdit()) return startHandle(handleEl.dataset.handle, start);
        if (hit) return startPress(hit, start, e);
        if (e.pointerType === "touch") {
          gesture = { type: "pan", start, clickClears: true };
          return;
        }
        gesture = { type: "marquee", start, base: e.shiftKey ? new Set(B.sel) : new Set() };
        return;
      case "sticky":
      case "text":
      case "comment":
        gesture = { type: "place", start };
        return;
      case "shape":
      case "frame":
        gesture = { type: "box", start };
        return;
      case "connector": {
        const { end } = endAt(e.clientX, e.clientY, null, e.altKey);
        gesture = { type: "newConnector", start, from: end };
        return;
      }
      case "pen":
      case "highlighter":
        gesture = { type: "stroke", start, points: [[start.p.x, start.p.y]] };
        return;
      case "eraser":
        gesture = { type: "erase", start, ids: new Set() };
        eraseAt(e.clientX, e.clientY);
        return;
    }
  }

  function startPress(it, start, e) {
    if (e.shiftKey) {
      const next = new Set(B.sel);
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      B.setSelection(next);
      gesture = { type: "none", start };
      return;
    }
    const wasSelected = B.sel.has(it.id);
    if (!wasSelected) B.setSelection([it.id]);
    if (!B.canEdit()) {
      gesture = { type: "pan", start, pressed: it };
      return;
    }
    gesture = { type: "move", start, pressed: it, wasSelected, alt: e.altKey };
  }

  function startHandle(name, start) {
    const items = B.selected();
    if (name === "from" || name === "to") {
      const conn = items[0];
      gesture = { type: "endpoint", start, id: conn.id, end: name, tx: B.begin() };
      return;
    }
    const box = B.unionBounds(items);
    gesture = { type: "resize", start, handle: name, box, orig: new Map(items.map((it) => [it.id, it])), tx: B.begin() };
  }

  function beginMove(g, e) {
    let items = B.selected().filter((it) => !it.locked);
    g.tx = B.begin();
    if (g.alt) {
      // Alt-drag leaves a copy behind and moves the duplicate.
      const copies = B.cloneItems(items, 0, 0);
      for (const c of copies) g.tx.put(c);
      B.sel = new Set(copies.map((c) => c.id));
      items = copies;
    }
    const moving = new Map(items.map((it) => [it.id, it]));
    for (const it of items) {
      if (it.type === "frame") for (const child of B.frameChildren(it)) if (!child.locked) moving.set(child.id, child);
    }
    g.orig = moving;
    g.box = B.unionBounds([...moving.values()].filter((it) => it.type !== "connector")) || B.unionBounds([...moving.values()]);
    g.lines = snapLines(new Set(moving.keys()));
    void e;
  }

  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPointer = { x: e.clientX, y: e.clientY };
    B.sendCursor && B.sendCursor(e.clientX, e.clientY);

    if (!gesture) {
      if (B.tool === "connector") {
        clearDraft();
        const { item } = endAt(e.clientX, e.clientY, null, e.altKey);
        if (item) anchorsFor(item);
      }
      return;
    }
    if (gesture.type === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      B.view.x += mid.x - gesture.mid.x;
      B.view.y += mid.y - gesture.mid.y;
      zoomAt(dist / gesture.dist, mid.x, mid.y);
      gesture.dist = dist;
      gesture.mid = mid;
      return;
    }
    const g = gesture;
    const dxs = e.clientX - g.start.cx;
    const dys = e.clientY - g.start.cy;
    if (!g.moved && Math.hypot(dxs, dys) < DRAG_PX && g.type !== "stroke") return;
    const first = !g.moved;
    g.moved = true;
    const p = B.screenToBoard(e.clientX, e.clientY);
    const s = B.view.s;

    switch (g.type) {
      case "pan":
        vp().classList.add("panning");
        B.view = { ...B.view, x: g.start.view.x + dxs, y: g.start.view.y + dys };
        B.applyView();
        break;

      case "marquee": {
        const x = Math.min(g.start.p.x, p.x);
        const y = Math.min(g.start.p.y, p.y);
        const rect = { x, y, w: Math.abs(p.x - g.start.p.x), h: Math.abs(p.y - g.start.p.y) };
        draftRect(rect.x, rect.y, rect.w, rect.h, "marquee");
        const ids = new Set(g.base);
        for (const it of B.items.values()) {
          const b = B.bounds(it);
          if (it.type === "frame" ? B.contains(rect, b) : B.intersects(rect, b)) ids.add(it.id);
        }
        B.sel = ids;
        B.invalidate(false);
        break;
      }

      case "move": {
        if (first) beginMove(g, e);
        let dx = dxs / s;
        let dy = dys / s;
        clearDraft();
        if (!e.altKey && !e.metaKey && g.box) {
          const b = g.box;
          const sx = snapAxis([b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w], g.lines.xs);
          const sy = snapAxis([b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h], g.lines.ys);
          if (sx) dx += sx.d;
          if (sy) dy += sy.d;
          const nb = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
          if (sx) {
            const lb = sx.line.b;
            guide(sx.line.v, Math.min(nb.y, lb.y) - 20, sx.line.v, Math.max(nb.y + nb.h, lb.y + lb.h) + 20);
          }
          if (sy) {
            const lb = sy.line.b;
            guide(Math.min(nb.x, lb.x) - 20, sy.line.v, Math.max(nb.x + nb.w, lb.x + lb.w) + 20, sy.line.v);
          }
        }
        for (const [id, it] of g.orig) {
          if (it.type === "connector") {
            const shift = (end) => (end && end.id ? end : { x: (end.x || 0) + dx, y: (end.y || 0) + dy });
            g.tx.put({ ...it, from: shift(it.from), to: shift(it.to) });
          } else {
            g.tx.put({ ...it, x: it.x + dx, y: it.y + dy });
          }
          void id;
        }
        g.tx.live();
        break;
      }

      case "resize":
        resizeTo(g, p, e.shiftKey);
        break;

      case "endpoint": {
        clearDraft();
        const conn = B.items.get(g.id);
        if (!conn) break;
        const { end, item } = endAt(e.clientX, e.clientY, conn.id, e.altKey);
        if (item) anchorsFor(item);
        g.tx.put({ ...conn, [g.end]: end });
        g.tx.live();
        break;
      }

      case "box": {
        let w = p.x - g.start.p.x;
        let hh = p.y - g.start.p.y;
        if (e.shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(hh));
          w = Math.sign(w || 1) * m;
          hh = Math.sign(hh || 1) * m;
        }
        g.rect = { x: Math.min(g.start.p.x, g.start.p.x + w), y: Math.min(g.start.p.y, g.start.p.y + hh), w: Math.abs(w), h: Math.abs(hh) };
        if (B.tool === "frame") {
          draftRect(g.rect.x, g.rect.y, g.rect.w, g.rect.h, "draft-frame");
        } else {
          const svg = draftSvg();
          svg.replaceChildren();
          const path = B.svg("path", { d: B.shapePath(B.opts.shape.shape, g.rect.w, g.rect.h, 1), class: "draft-shape" });
          path.setAttribute("transform", `translate(${g.rect.x} ${g.rect.y})`);
          svg.append(path);
        }
        break;
      }

      case "newConnector": {
        clearDraft();
        const { end, item } = endAt(e.clientX, e.clientY, g.from.id, e.altKey);
        if (item) anchorsFor(item);
        g.to = end;
        const geo = B.connectorGeometry({ from: g.from, to: end, style: B.opts.connector.style });
        draftSvg().append(B.svg("path", { d: geo.d, class: "draft-line" }));
        break;
      }

      case "stroke": {
        const last = g.points[g.points.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * s < 1.5) break;
        g.points.push([p.x, p.y]);
        const svg = draftSvg();
        let path = svg.querySelector("path");
        if (!path) {
          path = B.svg("path", { class: "draft-stroke" });
          svg.append(path);
        }
        const o = B.opts[B.tool];
        path.setAttribute("d", B.strokeD(g.points));
        path.setAttribute("stroke", o.color);
        path.setAttribute("stroke-width", o.width);
        path.setAttribute("stroke-opacity", B.tool === "highlighter" ? 0.4 : 1);
        break;
      }

      case "erase":
        eraseAt(e.clientX, e.clientY);
        break;
    }
  }

  function resizeTo(g, p, shift) {
    const b = g.box;
    const hd = g.handle;
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (hd.includes("w")) x1 = Math.min(p.x, x2 - 8);
    if (hd.includes("e")) x2 = Math.max(p.x, x1 + 8);
    if (hd.includes("n")) y1 = Math.min(p.y, y2 - 8);
    if (hd.includes("s")) y2 = Math.max(p.y, y1 + 8);
    const items = [...g.orig.values()];
    const corner = hd.length === 2;
    const keepRatio = corner && (shift || items.length > 1 || ["image", "sticky"].includes(items[0].type));
    if (keepRatio) {
      const ratio = b.w / b.h;
      const w = x2 - x1;
      const hh = y2 - y1;
      if (w / hh > ratio) {
        const nw = hh * ratio;
        if (hd.includes("w")) x1 = x2 - nw;
        else x2 = x1 + nw;
      } else {
        const nh = w / ratio;
        if (hd.includes("n")) y1 = y2 - nh;
        else y2 = y1 + nh;
      }
    }
    const sx = (x2 - x1) / b.w;
    const sy = (y2 - y1) / b.h;
    const mapX = (x) => x1 + (x - b.x) * sx;
    const mapY = (y) => y1 + (y - b.y) * sy;
    for (const it of items) {
      if (it.type === "connector") {
        const shift2 = (end) => (end && end.id ? end : { x: mapX(end.x || 0), y: mapY(end.y || 0) });
        g.tx.put({ ...it, from: shift2(it.from), to: shift2(it.to) });
        continue;
      }
      const next = { ...it, x: mapX(it.x), y: mapY(it.y), w: Math.max(8, it.w * sx), h: Math.max(8, it.h * sy) };
      if (it.type === "text") next.h = it.h;
      if (it.type === "draw") next.points = it.points.map(([px, py]) => [px * sx, py * sy]);
      g.tx.put(next);
    }
    g.tx.live();
  }

  function eraseAt(cx, cy) {
    const g = gesture;
    for (const el of document.elementsFromPoint(cx, cy)) {
      const host = el.closest && el.closest(".it.draw");
      if (!host || g.ids.has(host.dataset.id)) continue;
      const it = B.items.get(host.dataset.id);
      if (!it || it.locked) continue;
      g.ids.add(it.id);
      host.classList.add("erasing");
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === "pinch") {
      if (pointers.size === 0) gesture = null;
      return;
    }
    const g = gesture;
    gesture = null;
    vp().classList.remove("panning");
    const cancelled = e.type === "pointercancel";
    const p = B.screenToBoard(e.clientX, e.clientY);

    switch (g.type) {
      case "pan":
        if (!g.moved && g.right) B.openContextMenu && B.openContextMenu(e.clientX, e.clientY, g.hit);
        else if (!g.moved && g.clickClears) B.setSelection([]);
        break;

      case "marquee":
        clearDraft();
        if (!g.moved) B.setSelection(g.base);
        else B.setSelection(B.sel);
        break;

      case "move":
        clearDraft();
        if (g.moved && g.tx) {
          if (cancelled) g.tx.cancel();
          else g.tx.commit();
          B.setSelection(B.sel);
        } else if (!cancelled) {
          if (g.wasSelected && B.sel.size > 1) B.setSelection([g.pressed.id]);
          handleClick(g.pressed, e);
        }
        break;

      case "none":
        break;

      case "resize":
      case "endpoint":
        clearDraft();
        if (cancelled) g.tx.cancel();
        else g.tx.commit();
        B.invalidate(false);
        break;

      case "place":
        if (cancelled || g.moved) break;
        if (B.tool === "sticky") placeSticky(p);
        else if (B.tool === "text") placeText(p);
        else if (B.tool === "comment") B.openCommentComposer && B.openCommentComposer(p);
        break;

      case "box": {
        clearDraft();
        if (cancelled) break;
        const isFrame = B.tool === "frame";
        let r = g.rect;
        if (!r || r.w < 8 || r.h < 8) {
          const [w, hh] = isFrame ? [1280, 720] : [160, 160];
          r = { x: p.x - w / 2, y: p.y - hh / 2, w, h: hh };
        }
        const id = B.uid();
        B.change((tx) =>
          tx.put(
            isFrame
              ? { id, type: "frame", x: r.x, y: r.y, w: r.w, h: r.h, z: B.bottomZ(), title: `Frame ${[...B.items.values()].filter((i) => i.type === "frame").length + 1}`, fill: "#16161b" }
              : { id, type: "shape", shape: B.opts.shape.shape, x: r.x, y: r.y, w: r.w, h: r.h, z: B.topZ(), fill: "#1f1f26", stroke: "#63d9dd", strokeWidth: 2, text: "", fontSize: 20 },
          ),
        );
        backToSelect();
        B.setSelection([id]);
        break;
      }

      case "newConnector": {
        clearDraft();
        if (cancelled || !g.to) break;
        const a = B.endPoint(g.from);
        const b = B.endPoint(g.to);
        if (Math.hypot(a.x - b.x, a.y - b.y) * B.view.s < 12) break;
        const id = B.uid();
        B.change((tx) =>
          tx.put({ id, type: "connector", from: g.from, to: g.to, style: B.opts.connector.style, stroke: "#ececf1", strokeWidth: 2, startCap: "none", endCap: "arrow", z: B.topZ() }),
        );
        backToSelect();
        B.setSelection([id]);
        break;
      }

      case "stroke": {
        clearDraft();
        if (cancelled) break;
        finishStroke(g.points);
        break;
      }

      case "erase":
        if (g.ids.size && !cancelled) B.deleteItems([...g.ids]);
        for (const el of document.querySelectorAll(".it.erasing")) el.classList.remove("erasing");
        break;
    }
  }

  function handleClick(it, e) {
    const now = performance.now();
    const isDouble = lastClick.id === it.id && now - lastClick.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
    lastClick = { t: isDouble ? 0 : now, id: it.id, x: e.clientX, y: e.clientY };
    if (!isDouble) return;
    if (textTypes.has(it.type)) B.startEditing(it.id);
    else if (it.type === "frame") B.renameFrame && B.renameFrame(it);
  }

  // ---------------------------------------------------------------- creating items

  function placeSticky(p) {
    const tx = B.begin();
    const id = B.uid();
    tx.put({ id, type: "sticky", x: p.x - 100, y: p.y - 100, w: 200, h: 200, z: B.topZ(), color: B.opts.sticky.color, text: "" });
    backToSelect();
    B.startEditing(id, { tx, isNew: true });
  }

  function placeText(p) {
    const tx = B.begin();
    const id = B.uid();
    tx.put({ id, type: "text", x: p.x, y: p.y - 18, w: 320, h: 36, z: B.topZ(), text: "", fontSize: 24, color: "#ececf1" });
    backToSelect();
    B.startEditing(id, { tx, isNew: true });
  }

  /** Ramer–Douglas–Peucker: drop points that don't change the shape. */
  function simplify(points, eps) {
    if (points.length < 3) return points;
    const [ax, ay] = points[0];
    const [bx, by] = points[points.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const [px, py] = points[i];
      const d = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD <= eps) return [points[0], points[points.length - 1]];
    return simplify(points.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(points.slice(idx), eps));
  }

  function finishStroke(raw) {
    const pts = simplify(raw, 0.6 / B.view.s);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const o = B.opts[B.tool];
    const round = (n) => Math.round(n * 10) / 10;
    B.change((tx) =>
      tx.put({
        id: B.uid(),
        type: "draw",
        x,
        y,
        w: Math.max(1, Math.max(...xs) - x),
        h: Math.max(1, Math.max(...ys) - y),
        z: B.topZ(),
        points: pts.map(([px, py]) => [round(px - x), round(py - y)]),
        color: o.color,
        width: o.width,
        opacity: B.tool === "highlighter" ? 0.4 : 1,
      }),
    );
  }

  /** Upload image files and place them, starting at a board point. */
  B.addImages = async (files, at) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    if (!B.canEdit()) return toast("You can't add images to this board.", "error");
    let x = at.x;
    for (const file of images) {
      const t = toast(`Uploading ${file.name}…`);
      const form = new FormData();
      form.append("file", file);
      try {
        const a = await uploadForm(`/b/${encodeURIComponent(B.slug)}/assets`, form, (q) => (t.textContent = `Uploading ${file.name}… ${Math.round(q * 100)}%`));
        const scale = Math.min(1, 640 / Math.max(a.w, a.h));
        const w = a.w * scale;
        const hh = a.h * scale;
        const id = B.uid();
        B.change((tx) => tx.put({ id, type: "image", asset: a.id, x: images.length === 1 ? x - w / 2 : x, y: at.y - hh / 2, w, h: hh, z: B.topZ(), name: file.name.slice(0, 200) }));
        B.setSelection([id]);
        x += (images.length === 1 ? w / 2 : w) + 40;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, "error");
      }
    }
  };

  // ---------------------------------------------------------------- text editing

  const plaintextOk = (() => {
    const d = document.createElement("div");
    d.contentEditable = "plaintext-only";
    return d.contentEditable === "plaintext-only";
  })();

  B.startEditing = (id, opts = {}) => {
    const it = B.items.get(id);
    if (!it || !textTypes.has(it.type) || !B.canEdit() || it.locked) {
      if (opts.tx) opts.tx.commit();
      return;
    }
    if (B.editingId) B.finishEditing();
    const tx = opts.tx || B.begin();
    B.sel = new Set([id]);
    B.editingId = id;
    B.renderAll();
    const rec = B.recordFor(id);
    const txt = rec.txt;
    txt.contentEditable = plaintextOk ? "plaintext-only" : "true";
    txt.spellcheck = true;
    txt.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(txt);
    if (!opts.selectAll) range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);

    const onInput = () => {
      const cur = B.items.get(id);
      if (cur) tx.put({ ...cur, text: readText(txt) });
      tx.live();
    };
    const onKey = (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        txt.blur();
      }
      e.stopPropagation();
    };
    const finish = () => {
      txt.removeEventListener("input", onInput);
      txt.removeEventListener("keydown", onKey);
      txt.contentEditable = "false";
      editing = null;
      B.editingId = null;
      const cur = B.items.get(id);
      const text = readText(txt).replace(/\s+$/, "");
      if (!cur) {
        tx.commit();
      } else if (cur.type === "text" && !text.trim()) {
        if (opts.isNew) tx.cancel();
        else {
          tx.del(id);
          tx.commit();
        }
        B.setSelection([]);
      } else {
        tx.put({ ...cur, text });
        tx.commit();
        B.setSelection([id]);
      }
      rec.fitKey = null;
      B.invalidate();
    };
    txt.addEventListener("input", onInput);
    txt.addEventListener("keydown", onKey);
    txt.addEventListener("blur", finish, { once: true });
    editing = { id, txt };
  };

  function readText(txt) {
    return (txt.innerText || "").replace(/ /g, " ").replace(/\n$/, "");
  }

  B.finishEditing = () => {
    if (editing) editing.txt.blur();
  };

  // ---------------------------------------------------------------- actions

  B.actions = {
    delete() {
      const ids = B.selected().filter((it) => !it.locked).map((it) => it.id);
      if (ids.length && B.canEdit()) B.deleteItems(ids);
    },
    duplicate() {
      const items = B.selected();
      if (!items.length || !B.canEdit()) return;
      const copies = B.cloneItems(items, 32, 32);
      B.change((tx) => copies.forEach((c) => tx.put(c)));
      B.setSelection(copies.map((c) => c.id));
    },
    front() {
      let z = B.topZ();
      B.change((tx) => B.selected().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((it) => tx.put({ ...it, z: z++ })));
    },
    back() {
      let z = B.bottomZ() - B.sel.size;
      B.change((tx) => B.selected().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((it) => tx.put({ ...it, z: z++ })));
    },
    lock() {
      const items = B.selected();
      const lock = items.some((it) => !it.locked);
      B.change((tx) => items.forEach((it) => tx.put({ ...it, locked: lock })));
      B.invalidate(false);
    },
    selectAll() {
      B.setSelection([...B.items.keys()]);
    },
    copy() {
      const items = selectionWithConnectors();
      if (!items.length) return null;
      B.clipboard = structuredClone(items);
      return CLIP_MARK + JSON.stringify(items);
    },
    paste(items, at) {
      if (!B.canEdit() || !items || !items.length) return;
      const b = B.unionBounds(items);
      const target = at || pastePoint();
      const copies = B.cloneItems(items, target.x - (b.x + b.w / 2), target.y - (b.y + b.h / 2));
      B.change((tx) => copies.forEach((c) => tx.put(c)));
      B.setSelection(copies.map((c) => c.id));
    },
    zoomToSelection() {
      const b = B.unionBounds(B.selected());
      if (b) B.zoomTo(b);
    },
    edit() {
      const [it] = B.selected();
      if (B.sel.size === 1 && it && textTypes.has(it.type)) B.startEditing(it.id, { selectAll: true });
    },
  };

  /** Selected items plus connectors running between them. */
  function selectionWithConnectors() {
    const items = B.selected();
    const ids = new Set(items.map((i) => i.id));
    for (const it of B.items.values()) {
      if (it.type === "connector" && !ids.has(it.id) && it.from?.id && it.to?.id && ids.has(it.from.id) && ids.has(it.to.id)) items.push(it);
    }
    return items;
  }

  function pastePoint() {
    if (lastPointer) {
      const r = vp().getBoundingClientRect();
      if (lastPointer.x > r.left && lastPointer.x < r.right && lastPointer.y > r.top && lastPointer.y < r.bottom) {
        return B.screenToBoard(lastPointer.x, lastPointer.y);
      }
    }
    return B.viewportCenter();
  }

  function nudge(dx, dy) {
    const items = B.selected().filter((it) => !it.locked);
    if (!items.length || !B.canEdit()) return;
    B.change((tx) =>
      items.forEach((it) => {
        if (it.type === "connector") {
          const sh = (end) => (end && end.id ? end : { x: (end.x || 0) + dx, y: (end.y || 0) + dy });
          tx.put({ ...it, from: sh(it.from), to: sh(it.to) });
        } else tx.put({ ...it, x: it.x + dx, y: it.y + dy });
      }),
    );
  }

  // ---------------------------------------------------------------- keyboard

  const isTyping = () => {
    const a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
  };

  const TOOL_KEYS = { v: "select", h: "hand", n: "sticky", t: "text", s: "shape", r: "shape", l: "connector", p: "pen", m: "highlighter", e: "eraser", f: "frame", c: "comment" };

  function onKeyDown(e) {
    if (isTyping() || document.querySelector(".modal-backdrop")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === "Space" && !mod) {
      if (!spaceDown) {
        spaceDown = true;
        vp().classList.add("space");
      }
      e.preventDefault();
      return;
    }
    if (mod) {
      if (k === "z" && !e.shiftKey) B.undo();
      else if ((k === "z" && e.shiftKey) || k === "y") B.redo();
      else if (k === "d") B.actions.duplicate();
      else if (k === "a") B.actions.selectAll();
      else if (k === "=" || k === "+") zoomCenter(1.25);
      else if (k === "-") zoomCenter(0.8);
      else if (k === "0") B.zoomReset();
      else if (k === "]") B.actions.front();
      else if (k === "[") B.actions.back();
      else if (k === "l" && e.shiftKey) B.actions.lock();
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") B.actions.delete();
    else if (e.key === "Escape") {
      if (B.closePopovers && B.closePopovers()) return;
      if (B.tool !== "select") backToSelect();
      else B.setSelection([]);
    } else if (e.key === "Enter") B.actions.edit();
    else if (e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      nudge(...d);
    } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) B.fitAll();
    else if (e.key === "@" || (e.shiftKey && e.code === "Digit2")) B.actions.zoomToSelection();
    else if (e.key === "?") B.showHelp && B.showHelp();
    else if (TOOL_KEYS[k] && !e.shiftKey) {
      const tool = TOOL_KEYS[k];
      if (!B.toolAllowed || B.toolAllowed(tool)) {
        if (k === "r") B.opts.shape.shape = "rect";
        B.setTool(tool);
      }
    } else return;
    e.preventDefault();
  }

  function onKeyUp(e) {
    if (e.code === "Space") {
      spaceDown = false;
      vp().classList.remove("space");
    }
  }

  // ---------------------------------------------------------------- clipboard & drop

  function onCopy(e, cut) {
    if (isTyping() || !B.sel.size) return;
    const text = B.actions.copy();
    if (!text) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    if (cut) B.actions.delete();
  }

  function onPaste(e) {
    if (isTyping() || !B.canEdit()) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      B.addImages(files, pastePoint());
      return;
    }
    const text = e.clipboardData?.getData("text/plain") || "";
    e.preventDefault();
    if (text.startsWith(CLIP_MARK)) {
      try {
        B.actions.paste(JSON.parse(text.slice(CLIP_MARK.length)));
      } catch (_) {
        toast("Couldn't paste those items", "error");
      }
    } else if (text.trim()) {
      const p = pastePoint();
      const id = B.uid();
      B.change((tx) => tx.put({ id, type: "text", x: p.x - 160, y: p.y - 18, w: 320, h: 36, z: B.topZ(), text: text.slice(0, 5000), fontSize: 24, color: "#ececf1" }));
      B.setSelection([id]);
    } else if (B.clipboard) {
      B.actions.paste(B.clipboard);
    }
  }

  // ---------------------------------------------------------------- wiring

  B.initTools = () => {
    const v = vp();
    v.addEventListener("pointerdown", onDown);
    v.addEventListener("pointermove", onMove);
    v.addEventListener("pointerup", onUp);
    v.addEventListener("pointercancel", onUp);
    v.addEventListener("pointerleave", () => B.sendCursor && B.sendCursor(null));
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener(
      "wheel",
      (e) => {
        if (e.target.closest(".no-canvas")) return;
        e.preventDefault();
        cancelAnimationFrame(animation);
        const isMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
        if (e.ctrlKey || e.metaKey || isMouseWheel) {
          const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
          zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
        } else {
          B.view = { ...B.view, x: B.view.x - e.deltaX, y: B.view.y - e.deltaY };
          B.applyView();
        }
      },
      { passive: false },
    );
    v.addEventListener("dragover", (e) => {
      if (!B.canEdit() || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      v.classList.add("drop-target");
    });
    v.addEventListener("dragleave", () => v.classList.remove("drop-target"));
    v.addEventListener("drop", (e) => {
      v.classList.remove("drop-target");
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      B.addImages(e.dataTransfer.files, B.screenToBoard(e.clientX, e.clientY));
    });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", (e) => onCopy(e, false));
    document.addEventListener("cut", (e) => B.canEdit() && onCopy(e, true));
    document.addEventListener("paste", onPaste);
    window.addEventListener("blur", () => {
      spaceDown = false;
      vp().classList.remove("space");
    });
  };
})();
