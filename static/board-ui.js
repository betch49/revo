// Board interface: tool bar, context toolbar, menus, sharing, comments,
// presence and help.
"use strict";

(() => {
  const ICONS = {
    select: "M6 3l12 8-5.5 1.5L9.5 18z",
    hand: "M8 13V6a1.5 1.5 0 0 1 3 0v5m0-6.5a1.5 1.5 0 0 1 3 0V11m0-4.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-2.5 0-4-1.2-5.3-3.2L3.6 14a1.5 1.5 0 0 1 2.5-1.7L8 14.5",
    sticky: "M4 4h16v10l-6 6H4zM14 20v-6h6",
    text: "M5 7V4h14v3M12 4v16M9 20h6",
    shape: "M3 3h10v10H3zM17.5 10.5a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5z",
    connector: "M5 19L19 5M12 5h7v7",
    pen: "M4 20l4.5-1L20 7.5 16.5 4 5 15.5zM14 6.5l3.5 3.5",
    highlighter: "M8.5 15.5L4 20h5l2-2M8.5 15.5l7-11 4 2.5-6 11.5zM14 18h7",
    eraser: "M8 20h12M4.5 15.5l9-9 6 6-7.5 7.5H8.5z",
    frame: "M7 3v18M17 3v18M3 7h18M3 17h18",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 8.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5z",
    comment: "M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.6A8.4 8.4 0 1 1 21 11.5z",
    undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
    redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    duplicate: "M8 8h12v12H8zM16 8V4H4v12h4",
    lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
    unlock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2",
    front: "M9 9h11v11H9zM15 9V4H4v11h5",
    back: "M4 4h11v11H4zM20 9v11H9v-5",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    minus: "M5 12h14",
    plus: "M12 5v14M5 12h14",
    fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    alignLeft: "M4 6h16M4 10h10M4 14h16M4 18h10",
    alignCenter: "M4 6h16M7 10h10M4 14h16M7 18h10",
    alignRight: "M4 6h16M10 10h10M4 14h16M10 18h10",
    dash: "M3 12h4M10 12h4M17 12h4",
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "M6 6l12 12M18 6L6 18",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5",
  };

  function icon(name, size = 18) {
    const svg = B.svg("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
    svg.append(B.svg("path", { d: ICONS[name] || "" }));
    return svg;
  }
  B.icon = icon;

  function shapeIcon(kind) {
    const svg = B.svg("svg", { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round", "aria-hidden": "true" });
    svg.append(B.svg("path", { d: B.shapePath(kind, 22, 18, 1), transform: "translate(1 3)" }));
    return svg;
  }

  // ---------------------------------------------------------------- popovers

  let openPopovers = [];

  /** Close floating menus. Returns true if any were open. */
  B.closePopovers = () => {
    const had = openPopovers.length > 0;
    openPopovers.forEach((p) => p.remove());
    openPopovers = [];
    return had;
  };

  function popover(anchor, content, placement = "below") {
    B.closePopovers();
    const pop = h("div.popover.ui", content);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const pr = pop.getBoundingClientRect();
    let x = placement === "right" ? r.right + 10 : r.left + r.width / 2 - pr.width / 2;
    let y = placement === "right" ? r.top : placement === "above" ? r.top - pr.height - 8 : r.bottom + 8;
    x = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - pr.height - 8, y));
    pop.style.left = x + "px";
    pop.style.top = y + "px";
    openPopovers.push(pop);
    return pop;
  }

  document.addEventListener("pointerdown", (e) => {
    if (openPopovers.length && !e.target.closest(".popover, [data-popover-anchor]")) B.closePopovers();
  }, true);

  function swatches(colors, current, onPick, opts = {}) {
    return h("div.swatches", colors.map((c) => {
      const b = h("button.swatch", { type: "button", title: c === "transparent" ? "None" : c, "aria-label": c === "transparent" ? "No color" : `Color ${c}`, onclick: () => { onPick(c); B.closePopovers(); } });
      if (c === "transparent") b.classList.add("none");
      else b.style.background = c;
      if ((current || "").toLowerCase() === c.toLowerCase()) b.classList.add("current");
      if (opts.round) b.classList.add("round");
      return b;
    }));
  }

  // ---------------------------------------------------------------- left tool bar

  const TOOLS = [
    { id: "select", label: "Select", key: "V", role: "view" },
    { id: "hand", label: "Hand (pan)", key: "H", role: "view" },
    { sep: true },
    { id: "sticky", label: "Sticky note", key: "N", role: "edit", flyout: stickyFlyout },
    { id: "text", label: "Text", key: "T", role: "edit" },
    { id: "shape", label: "Shape", key: "S", role: "edit", flyout: shapeFlyout },
    { id: "connector", label: "Connection line", key: "L", role: "edit", flyout: connectorFlyout },
    { id: "pen", label: "Pen", key: "P", role: "edit", flyout: () => penFlyout("pen") },
    { id: "highlighter", label: "Highlighter", key: "M", role: "edit", flyout: () => penFlyout("highlighter") },
    { id: "eraser", label: "Eraser (pen strokes)", key: "E", role: "edit" },
    { id: "frame", label: "Frame", key: "F", role: "edit" },
    { id: "image", label: "Upload image", role: "edit", action: () => $("#image-input").click() },
    { sep: true },
    { id: "comment", label: "Comment", key: "C", role: "comment" },
  ];

  const $ = (sel) => document.querySelector(sel);

  B.toolAllowed = (tool) => {
    const t = TOOLS.find((x) => x.id === tool);
    return !t || B.can(t.role);
  };

  function buildToolbar() {
    const bar = $("#toolbar");
    bar.replaceChildren();
    for (const t of TOOLS) {
      if (t.sep) {
        bar.append(h("div.tb-sep"));
        continue;
      }
      if (!B.can(t.role)) continue;
      const btn = h("button.tb-btn", {
        type: "button",
        title: t.key ? `${t.label} (${t.key})` : t.label,
        "aria-label": t.label,
        dataset: { tool: t.id, popoverAnchor: "" },
        onclick: () => {
          if (t.action) return t.action();
          const reopen = B.tool === t.id && t.flyout;
          B.setTool(t.id);
          if (reopen || t.flyout) openFlyout(t, btn);
        },
      }, icon(t.id === "image" ? "image" : t.id, 20));
      bar.append(btn);
    }
    if (B.canEdit()) {
      bar.append(h("div.tb-sep"));
      bar.append(
        h("button.tb-btn#undo-btn", { type: "button", title: "Undo (Ctrl+Z)", "aria-label": "Undo", onclick: () => B.undo() }, icon("undo", 20)),
        h("button.tb-btn#redo-btn", { type: "button", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo", onclick: () => B.redo() }, icon("redo", 20)),
      );
    }
    syncToolbar();
  }

  function openFlyout(t, btn) {
    popover(btn, t.flyout(), "right");
  }

  function syncToolbar() {
    for (const b of document.querySelectorAll(".tb-btn[data-tool]")) b.classList.toggle("active", b.dataset.tool === B.tool);
    const u = $("#undo-btn");
    const r = $("#redo-btn");
    if (u) u.disabled = !B.history.undo.length;
    if (r) r.disabled = !B.history.redo.length;
  }

  function stickyFlyout() {
    return [h("div.pop-title", "Sticky color"), swatches(B.STICKY_COLORS, B.opts.sticky.color, (c) => (B.opts.sticky.color = c))];
  }

  function shapeFlyout() {
    return [
      h("div.pop-title", "Shape"),
      h("div.shape-grid", B.SHAPES.map((k) => {
        const b = h("button.icon-choice", { type: "button", title: k, "aria-label": k, onclick: () => { B.opts.shape.shape = k; B.closePopovers(); } }, shapeIcon(k));
        if (B.opts.shape.shape === k) b.classList.add("current");
        return b;
      })),
    ];
  }

  function connectorFlyout() {
    return [
      h("div.pop-title", "Line style"),
      h("div.choice-row", ["curve", "elbow", "straight"].map((s) => {
        const b = h("button.text-choice", { type: "button", onclick: () => { B.opts.connector.style = s; B.closePopovers(); } }, s[0].toUpperCase() + s.slice(1));
        if (B.opts.connector.style === s) b.classList.add("current");
        return b;
      })),
      h("p.pop-hint", "Drag from one item to another. Hold Alt for a free end."),
    ];
  }

  function penFlyout(kind) {
    const o = B.opts[kind];
    const widths = kind === "pen" ? [2, 3, 5, 8, 12] : [12, 18, 26];
    return [
      h("div.pop-title", kind === "pen" ? "Pen" : "Highlighter"),
      swatches(B.COLORS.filter((c) => c !== "#0a0a0c"), o.color, (c) => (o.color = c), { round: true }),
      h("div.choice-row", widths.map((w) => {
        const dot = h("span.width-dot");
        dot.style.width = dot.style.height = Math.min(18, w + 2) + "px";
        const b = h("button.text-choice", { type: "button", title: `${w}px`, "aria-label": `Width ${w}`, onclick: () => { o.width = w; B.closePopovers(); } }, dot);
        if (o.width === w) b.classList.add("current");
        return b;
      })),
    ];
  }

  // ---------------------------------------------------------------- context toolbar

  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96];

  function setProps(patch, types) {
    B.change((tx) =>
      B.selected().forEach((it) => {
        if (types && !types.includes(it.type)) return;
        tx.put({ ...it, ...(typeof patch === "function" ? patch(it) : patch) });
      }),
    );
  }

  function ctxBtn(name, label, onclick, opts = {}) {
    const b = h("button.ctx-btn", { type: "button", title: label, "aria-label": label, onclick, dataset: { popoverAnchor: "" } }, typeof name === "string" && ICONS[name] ? icon(name) : name);
    if (opts.active) b.classList.add("active");
    if (opts.danger) b.classList.add("danger");
    return b;
  }

  function colorBtn(label, current, colors, onPick, kind = "fill") {
    const chip = h("span.chip." + kind);
    if (!current || current === "transparent") chip.classList.add("none");
    else chip.style.setProperty("--c", current);
    const b = ctxBtn(chip, label, () => popover(b, [h("div.pop-title", label), swatches(colors, current, onPick)], "below"));
    return b;
  }

  function selectCtl(label, options, current, onPick) {
    const s = h("select.ctx-select", { "aria-label": label, title: label, onchange: () => onPick(s.value) },
      options.map(([v, text]) => {
        const o = h("option", { value: String(v) }, text);
        if (String(v) === String(current)) o.selected = true;
        return o;
      }));
    return s;
  }

  const sep = () => h("span.ctx-sep");

  function contextControls(items) {
    const types = new Set(items.map((it) => it.type));
    const one = types.size === 1 ? items[0] : null;
    const t = one && one.type;
    const out = [];
    const locked = items.some((it) => it.locked);
    if (locked) {
      out.push(ctxBtn("unlock", "Unlock (Ctrl+Shift+L)", () => B.actions.lock()));
      return out;
    }
    if (t === "sticky") {
      out.push(colorBtn("Note color", one.color, B.STICKY_COLORS, (c) => { B.opts.sticky.color = c; setProps({ color: c }); }));
      out.push(selectCtl("Text size", [["auto", "Auto"], ["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "X-large"]], one.fontSize || "auto", (v) => setProps({ fontSize: v })));
      out.push(alignBtn(one.align || "center", ["center", "left"]));
    } else if (t === "shape") {
      const kindBtn = ctxBtn(shapeIcon(one.shape || "rect"), "Shape type", () =>
        popover(kindBtn, [h("div.pop-title", "Shape"), h("div.shape-grid", B.SHAPES.map((k) => h("button.icon-choice", { type: "button", title: k, onclick: () => { setProps({ shape: k }); B.closePopovers(); } }, shapeIcon(k))))]));
      out.push(kindBtn);
      out.push(colorBtn("Fill", one.fill, [...B.COLORS, "transparent"], (c) => setProps({ fill: c })));
      out.push(colorBtn("Border", one.stroke, [...B.COLORS, "transparent"], (c) => setProps({ stroke: c, strokeWidth: c === "transparent" ? 0 : one.strokeWidth || 2 }), "stroke"));
      out.push(selectCtl("Border width", [[0, "No border"], [1, "1 px"], [2, "2 px"], [4, "4 px"], [8, "8 px"]], one.strokeWidth ?? 2, (v) => setProps({ strokeWidth: Number(v) })));
      out.push(sep());
      out.push(colorBtn("Text color", one.textColor || "#ececf1", B.COLORS, (c) => setProps({ textColor: c }), "text"));
      out.push(selectCtl("Font size", FONT_SIZES.map((s) => [s, String(s)]), one.fontSize || 20, (v) => setProps({ fontSize: Number(v) })));
      out.push(ctxBtn(h("b", "B"), "Bold", () => setProps({ bold: !one.bold }), { active: one.bold }));
    } else if (t === "text") {
      out.push(selectCtl("Font size", FONT_SIZES.map((s) => [s, String(s)]), one.fontSize || 24, (v) => setProps({ fontSize: Number(v) })));
      out.push(colorBtn("Text color", one.color || "#ececf1", B.COLORS, (c) => setProps({ color: c }), "text"));
      out.push(ctxBtn(h("b", "B"), "Bold", () => setProps({ bold: !one.bold }), { active: one.bold }));
      out.push(ctxBtn(h("i", "I"), "Italic", () => setProps({ italic: !one.italic }), { active: one.italic }));
      out.push(alignBtn(one.align || "left", ["left", "center", "right"]));
    } else if (t === "connector") {
      out.push(selectCtl("Line style", [["curve", "Curved"], ["elbow", "Elbow"], ["straight", "Straight"]], one.style || "curve", (v) => { B.opts.connector.style = v; setProps({ style: v }); }));
      out.push(colorBtn("Line color", one.stroke || "#ececf1", B.COLORS, (c) => setProps({ stroke: c }), "stroke"));
      out.push(selectCtl("Line width", [[1, "1 px"], [2, "2 px"], [3, "3 px"], [4, "4 px"], [6, "6 px"]], one.strokeWidth || 2, (v) => setProps({ strokeWidth: Number(v) })));
      out.push(ctxBtn("dash", "Dashed", () => setProps({ dash: !one.dash }), { active: one.dash }));
      const caps = [["none", "None"], ["arrow", "Arrow"], ["dot", "Dot"]];
      out.push(selectCtl("Start", caps.map(([v, l]) => [v, "Start: " + l]), one.startCap || "none", (v) => setProps({ startCap: v })));
      out.push(selectCtl("End", caps.map(([v, l]) => [v, "End: " + l]), one.endCap ?? "arrow", (v) => setProps({ endCap: v })));
    } else if (t === "draw") {
      out.push(colorBtn("Stroke color", one.color, B.COLORS, (c) => setProps({ color: c }), "stroke"));
      out.push(selectCtl("Stroke width", [2, 3, 5, 8, 12, 18, 26].map((w) => [w, `${w} px`]), one.width || 3, (v) => setProps({ width: Number(v) })));
    } else if (t === "frame") {
      out.push(ctxBtn(h("span.ctx-label", "Rename"), "Rename frame", () => B.renameFrame(one)));
      out.push(colorBtn("Frame color", one.fill || "#16161b", ["#16161b", "#0a0a0c", "#23232b", "#ffffff", "#f4f1ea", "#e8f6f7", "#fff8e1", "#fdecef"], (c) => setProps({ fill: c })));
    } else if (t === "image" && items.length === 1) {
      const a = h("a.ctx-btn", { href: B.fileUrl(one.asset, "original"), download: one.name || "", title: "Download original", "aria-label": "Download original" }, icon("download"));
      out.push(a);
    }
    if (out.length) out.push(sep());
    out.push(ctxBtn("front", "Bring to front (Ctrl+])", () => B.actions.front()));
    out.push(ctxBtn("back", "Send to back (Ctrl+[)", () => B.actions.back()));
    out.push(ctxBtn("duplicate", "Duplicate (Ctrl+D)", () => B.actions.duplicate()));
    out.push(ctxBtn("lock", "Lock (Ctrl+Shift+L)", () => B.actions.lock()));
    out.push(ctxBtn("trash", "Delete (Del)", () => B.actions.delete(), { danger: true }));
    return out;
  }

  function alignBtn(current, cycle) {
    const name = { left: "alignLeft", center: "alignCenter", right: "alignRight" }[current];
    return ctxBtn(name, "Text alignment", () => setProps({ align: cycle[(cycle.indexOf(current) + 1) % cycle.length] }));
  }

  let ctxKey = "";
  function updateContextToolbar() {
    const bar = $("#ctx");
    const items = B.selected();
    if (!items.length || !B.canEdit() || B.editingId || B.tool !== "select") {
      bar.hidden = true;
      ctxKey = "";
      return;
    }
    const key = items.map((it) => JSON.stringify(it)).join("|");
    if (key !== ctxKey) {
      ctxKey = key;
      bar.replaceChildren(...contextControls(items));
    }
    bar.hidden = false;
    positionContextToolbar();
  }

  function positionContextToolbar() {
    const bar = $("#ctx");
    if (bar.hidden) return;
    const b = B.unionBounds(B.selected());
    if (!b) return;
    const tl = B.boardToScreen(b.x, b.y);
    const br = B.boardToScreen(b.x + b.w, b.y + b.h);
    const w = bar.offsetWidth;
    const hh = bar.offsetHeight;
    let x = (tl.x + br.x) / 2 - w / 2;
    let y = tl.y - hh - 28;
    if (y < 70) y = br.y + 20;
    if (y > window.innerHeight - hh - 70) y = Math.max(70, Math.min(window.innerHeight - hh - 70, tl.y + 20));
    x = Math.max(68, Math.min(window.innerWidth - w - 12, x));
    bar.style.left = x + "px";
    bar.style.top = y + "px";
  }

  // ---------------------------------------------------------------- right-click menu

  B.openContextMenu = (cx, cy, hit) => {
    if (hit && !B.sel.has(hit.id)) B.setSelection([hit.id]);
    const has = B.sel.size > 0;
    const edit = B.canEdit();
    const entry = (label, key, fn, enabled = true) =>
      h("button.menu-item", { type: "button", disabled: !enabled, onclick: () => { B.closePopovers(); fn(); } }, h("span", label), key ? h("kbd", key) : null);
    const rows = [];
    if (has) {
      rows.push(entry("Copy", "Ctrl+C", copyToClipboard));
      if (edit) {
        rows.push(entry("Duplicate", "Ctrl+D", B.actions.duplicate));
        rows.push(entry("Bring to front", "Ctrl+]", B.actions.front));
        rows.push(entry("Send to back", "Ctrl+[", B.actions.back));
        rows.push(entry(B.selected().some((i) => i.locked) ? "Unlock" : "Lock", "Ctrl+Shift+L", B.actions.lock));
      }
      rows.push(entry("Zoom to selection", "Shift+2", B.actions.zoomToSelection));
      if (edit) rows.push(h("div.menu-sep"), entry("Delete", "Del", B.actions.delete));
    } else {
      if (edit) rows.push(entry("Paste here", "Ctrl+V", () => B.actions.paste(B.clipboard, B.screenToBoard(cx, cy)), !!B.clipboard));
      rows.push(entry("Select all", "Ctrl+A", B.actions.selectAll));
      rows.push(entry("Fit to screen", "Shift+1", () => B.fitAll()));
      if (B.can("comment")) rows.push(entry("Add comment here", "C", () => B.openCommentComposer(B.screenToBoard(cx, cy))));
    }
    popover({ left: cx, right: cx, top: cy, bottom: cy, width: 0, height: 0 }, h("div.menu", rows), "right");
  };

  async function copyToClipboard() {
    const text = B.actions.copy();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      /* the internal clipboard still works for Paste here */
    }
    toast(`Copied ${B.sel.size} item${B.sel.size === 1 ? "" : "s"}`);
  }

  // ---------------------------------------------------------------- title & sharing

  B.renameFrame = async (frame) => {
    const title = await textPrompt("Rename frame", frame.title || "Frame", 120);
    if (title) B.change((tx) => tx.update(frame.id, { title }));
  };

  function textPrompt(heading, value, max) {
    return modal((close) => {
      const input = h("input", { type: "text", maxlength: max, value, id: "prompt-input" });
      return h("form", { onsubmit: (e) => { e.preventDefault(); close(input.value.trim() || null); } },
        h("h2", heading),
        h("div.field", input),
        h("div.modal-actions",
          h("button.ghost", { type: "button", onclick: () => close(null) }, "Cancel"),
          h("button.primary", { type: "submit" }, "Save")));
    });
  }

  async function renameBoard() {
    const title = await textPrompt("Rename board", B.board.title, 120);
    if (!title || title === B.board.title) return;
    try {
      const board = await api("PATCH", `/admin/boards/${B.board.id}`, { title });
      B.setBoardMeta(board);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  B.setBoardMeta = (board) => {
    B.board = { ...B.board, ...board };
    document.title = `${B.board.title} · Betch board`;
    const t = $("#board-title");
    t.replaceChildren(B.board.title);
  };

  const ACCESS_TEXT = {
    private: "Only you",
    view: "Anyone with the link can view",
    comment: "Anyone with the link can comment",
    edit: "Anyone with the link can edit",
  };

  function boardLink() {
    return `${B.publicUrl || location.origin}/${B.board.slug}`;
  }

  async function openShare() {
    await modal((close) => {
      const access = h("select#share-access", { onchange: () => save({ access: access.value }) },
        Object.entries(ACCESS_TEXT).map(([v, label]) => {
          const o = h("option", { value: v }, label);
          if (v === B.board.access) o.selected = true;
          return o;
        }));
      const status = h("p.hint#share-status", B.board.has_passcode ? "A passcode is set. People enter it once per browser." : "No passcode. The link alone opens the board.");
      const pass = h("input#share-passcode", { type: "text", maxlength: 100, autocomplete: "off", placeholder: B.board.has_passcode ? "New passcode" : "Optional passcode" });
      const save = async (patch) => {
        try {
          const board = await api("PATCH", `/admin/boards/${B.board.id}`, patch);
          B.setBoardMeta(board);
          status.textContent = B.board.has_passcode ? "A passcode is set. People enter it once per browser." : "No passcode. The link alone opens the board.";
          removeBtn.hidden = !B.board.has_passcode;
          toast("Sharing updated");
        } catch (e) {
          toast(e.message, "error");
        }
      };
      const removeBtn = h("button.ghost", { type: "button", hidden: !B.board.has_passcode, onclick: () => save({ passcode: "" }) }, "Remove passcode");
      return [
        h("h2", "Share board"),
        h("div.field", h("label", { for: "share-link" }, "Link"),
          h("div.inline-row", h("input#share-link", { type: "text", readonly: true, value: boardLink() }),
            h("button.primary", { type: "button", onclick: () => copyText(boardLink()) }, "Copy"))),
        h("div.field", h("label", { for: "share-access" }, "Who can open it"), access),
        h("div.field", h("label", { for: "share-passcode" }, "Passcode"),
          h("div.inline-row", pass, h("button", { type: "button", onclick: () => pass.value.trim() && save({ passcode: pass.value.trim() }).then(() => (pass.value = "")) }, "Set")),
          status, removeBtn),
        h("div.modal-actions", h("button", { type: "button", onclick: () => close(null) }, "Done")),
      ];
    });
  }

  // ---------------------------------------------------------------- presence

  const cursorEls = new Map();
  let lastCursorSent = 0;
  let cursorTimer = null;

  B.sendCursor = (cx, cy) => {
    const send = () => {
      lastCursorSent = performance.now();
      if (cx === null) B.net.send({ t: "cursor", x: null, y: null });
      else {
        const p = B.screenToBoard(cx, cy);
        B.net.send({ t: "cursor", x: Math.round(p.x), y: Math.round(p.y) });
      }
    };
    clearTimeout(cursorTimer);
    if (performance.now() - lastCursorSent > 40) send();
    else cursorTimer = setTimeout(send, 40);
  };

  function renderCursor(peer) {
    let el = cursorEls.get(peer.id);
    if (peer.cursor == null || peer.cursor.x == null) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      const arrow = B.svg("svg", { viewBox: "0 0 16 20", width: 16, height: 20, "aria-hidden": "true" });
      arrow.append(B.svg("path", { d: "M1 1l14 9-6.5 1.5L5 18z", fill: peer.color, stroke: "#0a0a0c", "stroke-width": "1.2", "stroke-linejoin": "round" }));
      el = h("div.remote-cursor", arrow, h("span.name", peer.name));
      el.querySelector(".name").style.background = peer.color;
      el.querySelector(".name").classList.toggle("on-light", !B.isDark(peer.color));
      $("#cursor-layer").append(el);
      cursorEls.set(peer.id, el);
    }
    el.hidden = false;
    const s = B.boardToScreen(peer.cursor.x, peer.cursor.y);
    const r = B.dom.viewport.getBoundingClientRect();
    el.style.transform = `translate(${s.x - r.left}px, ${s.y - r.top}px)`;
  }

  B.renderPeers = () => {
    for (const [id, el] of cursorEls) {
      if (!B.peers.has(id)) {
        el.remove();
        cursorEls.delete(id);
      }
    }
    for (const p of B.peers.values()) renderCursor(p);
    const box = $("#peers");
    box.replaceChildren();
    const people = [B.me, ...B.peers.values()].filter(Boolean);
    for (const p of people.slice(0, 6)) {
      const initials = p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
      const a = h("button.avatar", {
        type: "button",
        title: p === B.me ? `${p.name} (you)` : p.name,
        "aria-label": p.name,
        onclick: () => p !== B.me && p.cursor && p.cursor.x != null && B.centerOn(p.cursor.x, p.cursor.y),
      }, initials || "?");
      a.style.background = p.color;
      a.classList.toggle("on-light", !B.isDark(p.color));
      box.append(a);
    }
    if (people.length > 6) box.append(h("span.avatar.more", `+${people.length - 6}`));
  };

  B.updateCursor = (id, x, y) => {
    const p = B.peers.get(id);
    if (!p) return;
    p.cursor = { x, y };
    renderCursor(p);
  };

  // ---------------------------------------------------------------- comments

  let showResolved = false;
  let openThreadId = null;

  const roots = () => B.comments.filter((c) => c.parent_id === null);

  function authorName() {
    return B.me ? B.me.name : "Guest";
  }

  B.renderComments = () => {
    const layer = B.dom.pinLayer;
    layer.replaceChildren();
    const list = roots();
    list.forEach((c, i) => {
      if (c.resolved_at && !showResolved && c.id !== openThreadId) return;
      const pin = h("button.cmt-pin.no-canvas", {
        type: "button",
        title: `${c.author}: ${c.body.slice(0, 80)}`,
        onclick: (e) => { e.stopPropagation(); openThread(c.id); },
      }, String(i + 1));
      if (c.resolved_at) pin.classList.add("resolved");
      if (c.is_owner) pin.classList.add("owner");
      if (c.id === openThreadId) pin.classList.add("active");
      pin.style.left = c.x + "px";
      pin.style.top = c.y + "px";
      layer.append(pin);
    });
    const open = list.filter((c) => !c.resolved_at).length;
    const count = $("#comment-count");
    count.textContent = open ? String(open) : "";
    count.hidden = !open;
    if (!$("#comments-panel").hidden) renderCommentsPanel();
    if (openThreadId) {
      const pop = document.querySelector(".thread-pop");
      if (pop) refreshThread(pop);
    }
  };

  function pinScreen(c) {
    const s = B.boardToScreen(c.x, c.y);
    return { left: s.x, right: s.x + 26, top: s.y - 26, bottom: s.y, width: 26, height: 26 };
  }

  function threadContent(root) {
    const replies = B.comments.filter((c) => c.parent_id === root.id);
    const n = roots().indexOf(root) + 1;
    const actions = h("div.thread-actions");
    if (B.can("comment")) {
      actions.append(h("button.ghost", { type: "button", onclick: () => resolve(root, !root.resolved_at) }, root.resolved_at ? "Reopen" : "Resolve"));
    }
    if (B.can("owner")) actions.append(h("button.ghost.danger", { type: "button", onclick: () => removeComment(root) }, "Delete"));
    const msgs = [root, ...replies].map((c) =>
      h("div.cmt",
        h("div.who", c.author, c.is_owner ? h("span.badge", "Owner") : null, h("span.when", timeAgo(c.created_at))),
        h("div.body", c.body)));
    const out = [h("div.thread-head", h("span.thread-num", String(n)), root.resolved_at ? h("span.muted.small", "Resolved") : null, actions), ...msgs];
    if (B.can("comment")) {
      const text = h("textarea", { rows: 1, placeholder: "Reply…", maxlength: 4000, "aria-label": "Reply" });
      const send = async () => {
        const body = text.value.trim();
        if (!body) return;
        try {
          const c = await api("POST", `/b/${encodeURIComponent(B.slug)}/comments`, { parent_id: root.id, body, author: authorName() });
          upsertComment(c);
          text.value = "";
        } catch (e) {
          toast(e.message, "error");
        }
      };
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
        e.stopPropagation();
      });
      out.push(h("div.reply-box", text, h("button.primary", { type: "button", onclick: send }, "Send")));
    }
    return out;
  }

  function refreshThread(pop) {
    const root = B.comments.find((c) => c.id === openThreadId);
    if (!root) {
      B.closePopovers();
      openThreadId = null;
      return;
    }
    const focused = pop.querySelector("textarea") === document.activeElement;
    const draft = pop.querySelector("textarea")?.value || "";
    pop.replaceChildren(...threadContent(root));
    const ta = pop.querySelector("textarea");
    if (ta) {
      ta.value = draft;
      if (focused) ta.focus();
    }
  }

  function openThread(id) {
    const root = B.comments.find((c) => c.id === id);
    if (!root) return;
    openThreadId = id;
    const pop = popover(pinScreen(root), threadContent(root), "right");
    pop.classList.add("thread-pop", "no-canvas");
    const obs = new MutationObserver(() => {
      if (!pop.isConnected) {
        obs.disconnect();
        if (openThreadId === id) {
          openThreadId = null;
          B.renderComments();
        }
      }
    });
    obs.observe(document.body, { childList: true });
    B.renderComments();
  }

  B.openCommentComposer = (p) => {
    if (!B.can("comment")) return;
    B.setTool("select");
    const text = h("textarea#new-comment", { rows: 3, placeholder: "Add a comment…", maxlength: 4000, "aria-label": "Comment" });
    const post = async () => {
      const body = text.value.trim();
      if (!body) return text.focus();
      try {
        const c = await api("POST", `/b/${encodeURIComponent(B.slug)}/comments`, { x: p.x, y: p.y, body, author: authorName() });
        B.closePopovers();
        upsertComment(c);
        openThread(c.id);
      } catch (e) {
        toast(e.message, "error");
      }
    };
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault();
        post();
      }
      if (e.key === "Escape") B.closePopovers();
      e.stopPropagation();
    });
    const s = B.boardToScreen(p.x, p.y);
    const pop = popover({ left: s.x, right: s.x, top: s.y, bottom: s.y, width: 0, height: 0 },
      [h("div.pop-title", "New comment"), text, h("div.modal-actions", h("button.ghost", { type: "button", onclick: () => B.closePopovers() }, "Cancel"), h("button.primary", { type: "button", onclick: post }, "Post"))],
      "right");
    pop.classList.add("composer-pop", "no-canvas");
    text.focus();
  };

  function upsertComment(c) {
    const i = B.comments.findIndex((x) => x.id === c.id);
    if (i >= 0) B.comments[i] = c;
    else B.comments.push(c);
    B.renderComments();
  }
  B.upsertComment = upsertComment;

  async function resolve(root, resolved) {
    try {
      upsertComment(await api("POST", `/b/${encodeURIComponent(B.slug)}/comments/${root.id}/resolve`, { resolved }));
      if (resolved && !showResolved) {
        B.closePopovers();
        openThreadId = null;
        B.renderComments();
      }
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function removeComment(root) {
    if (!(await confirmDialog("Delete comment thread?", "The comment and its replies will be removed.", "Delete"))) return;
    try {
      await api("DELETE", `/b/${encodeURIComponent(B.slug)}/comments/${root.id}`);
      B.removeComment(root.id);
      B.closePopovers();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  B.removeComment = (id) => {
    B.comments = B.comments.filter((c) => c.id !== id && c.parent_id !== id);
    B.renderComments();
  };

  function renderCommentsPanel() {
    const panel = $("#comments-panel");
    const list = roots();
    const visible = list.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => showResolved || !c.resolved_at);
    const toggle = h("input#show-resolved", { type: "checkbox", checked: showResolved, onchange: (e) => { showResolved = e.target.checked; B.renderComments(); } });
    panel.replaceChildren(
      h("div.panel-head", h("h2", "Comments"), h("button.icon-btn", { type: "button", "aria-label": "Close comments", onclick: () => (panel.hidden = true) }, icon("close"))),
      h("label.check", toggle, "Show resolved"),
      visible.length
        ? h("div.cmt-list", visible.map(({ c, n }) =>
            h("button.cmt-row", { type: "button", onclick: () => { B.centerOn(c.x, c.y); setTimeout(() => openThread(c.id), 300); } },
              h("span.thread-num" + (c.resolved_at ? ".resolved" : ""), String(n)),
              h("span.cmt-row-body", h("span.who", c.author, h("span.when", timeAgo(c.created_at))), h("span.body", c.body)),
              h("span.replies", (() => {
                const r = B.comments.filter((x) => x.parent_id === c.id).length;
                return r ? `${r} repl${r === 1 ? "y" : "ies"}` : "";
              })()))))
        : h("p.muted.small", B.can("comment") ? "No comments yet. Pick the comment tool (C) and click anywhere on the board." : "No comments yet."),
    );
  }

  // ---------------------------------------------------------------- help

  B.showHelp = () =>
    modal((close) => {
      const rows = [
        ["V / H", "Select / hand"], ["N", "Sticky note"], ["T", "Text"], ["S", "Shape"], ["L", "Connection line"],
        ["P / M / E", "Pen / highlighter / eraser"], ["F", "Frame"], ["C", "Comment"],
        ["Space + drag", "Pan (also right or middle drag)"], ["Scroll / pinch", "Pan / zoom (Ctrl + scroll zooms)"],
        ["Double-click", "Edit text"], ["Shift + click", "Add to selection"], ["Alt + drag", "Duplicate while moving"],
        ["Ctrl + Z / Ctrl + Shift + Z", "Undo / redo"], ["Ctrl + C / X / V / D", "Copy / cut / paste / duplicate"],
        ["Ctrl + ] / [", "Bring to front / send to back"], ["Arrows", "Nudge (Shift: 10 px)"],
        ["Shift + 1 / Shift + 2", "Fit board / zoom to selection"], ["Ctrl + 0", "Zoom to 100%"],
      ];
      return [
        h("h2", "Keyboard shortcuts"),
        h("dl.shortcuts", rows.map(([k, v]) => [h("dt", h("kbd", k)), h("dd", v)])),
        h("div.modal-actions", h("button.primary", { type: "button", onclick: () => close(null) }, "Close")),
      ];
    });

  // ---------------------------------------------------------------- wiring

  B.initUI = () => {
    buildToolbar();
    B.setBoardMeta(B.board);
    const owner = B.can("owner");
    $("#board-title").disabled = !owner;
    $("#board-title").title = owner ? "Rename board" : "";
    $("#board-title").onclick = () => owner && renameBoard();
    $("#home-link").hidden = !owner;
    $("#share-btn").hidden = !owner;
    $("#share-btn").onclick = openShare;
    const roleText = { view: "View only", comment: "Can comment", edit: "Can edit" }[B.role];
    $("#role-badge").hidden = owner;
    $("#role-badge").textContent = roleText || "";
    $("#comments-btn").onclick = () => {
      const p = $("#comments-panel");
      p.hidden = !p.hidden;
      if (!p.hidden) renderCommentsPanel();
    };
    $("#help-btn").onclick = B.showHelp;
    $("#zoom-in").onclick = B.zoomIn;
    $("#zoom-out").onclick = B.zoomOut;
    $("#zoom-fit").onclick = () => B.fitAll();
    $("#zoom-label").onclick = B.zoomReset;
    $("#image-input").onchange = (e) => {
      B.addImages(e.target.files, B.viewportCenter());
      e.target.value = "";
    };
    for (const [id, name] of [["zoom-in", "plus"], ["zoom-out", "minus"], ["zoom-fit", "fit"], ["help-btn", "help"], ["comments-btn", "comment"], ["share-btn", "link"]]) {
      $("#" + id).prepend(icon(name));
    }
    B.onToolChange = () => {
      syncToolbar();
      updateContextToolbar();
    };
    B.onHistoryChange = syncToolbar;
    B.onSelectionChange = updateContextToolbar;
    B.afterRender = () => {
      updateContextToolbar();
      syncToolbar();
    };
    B.onViewChange = () => {
      $("#zoom-label").textContent = Math.round(B.view.s * 100) + "%";
      positionContextToolbar();
      for (const p of B.peers.values()) renderCursor(p);
      if (openPopovers.length && !document.querySelector(".thread-pop, .composer-pop")) B.closePopovers();
    };
    B.renderComments();
    B.renderPeers();
  };
})();
