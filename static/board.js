// Review board: pan/zoom canvas, comment pins, threads, approvals, and admin arranging.
"use strict";

const slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ""));
const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const world = $("world");
const panel = $("panel");

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD = 4;
const POLL_MS = 5000;
const NAME_KEY = "revo:name";

let data = null;              // board as returned by GET /api/b/:slug
let view = { x: 0, y: 0, s: 1 };
let selectedId = null;        // selected image id
const viewed = new Map();     // image id -> version id being viewed (default: latest)
let tool = "move";            // "move" | "comment"
let editMode = false;         // admin arranging
let activeThread = null;      // root comment id
let showResolved = false;
let composer = null;          // pending pin: { imageId, versionId, x, y }
const drafts = new Map();     // textarea key -> text, survives re-renders
let busy = 0;                 // > 0 while dragging: postpone refreshes
let refreshPending = false;
const imgCache = new Map();   // version id -> <img>, avoids flicker on re-render

// ---------------------------------------------------------------- data

async function load(initial) {
  try {
    data = await api("GET", `/b/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e.code === "passcode_required") return showGate();
    if (e.status === 404) return showMissing();
    toast(e.message, "error");
    return;
  }
  // Drop selections that no longer exist.
  if (selectedId && !imageById(selectedId)) selectedId = null;
  for (const [imgId, vId] of viewed) {
    const img = imageById(imgId);
    if (!img || !img.versions.some((v) => v.id === vId)) viewed.delete(imgId);
  }
  showBoard();
  render();
  if (initial) fitAll(false);
}

async function refresh() {
  if (busy > 0 || isTyping()) {
    refreshPending = true;
    return;
  }
  refreshPending = false;
  await load(false);
}

async function poll() {
  if (!data || document.hidden) return;
  try {
    const { rev } = await api("GET", `/b/${encodeURIComponent(slug)}/rev`);
    if (rev !== data.board.rev) await refresh();
  } catch (e) {
    if (e.code === "passcode_required" || e.status === 404) location.reload();
  }
}

/** Run an API mutation, then reload. Shows errors as toasts. */
async function mutate(fn, okMessage) {
  try {
    const result = await fn();
    if (okMessage) toast(okMessage);
    await load(false);
    return result;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

function imageById(id) {
  return data && data.images.find((i) => i.id === id);
}

function currentVersion(img) {
  return img.versions[img.versions.length - 1];
}

function viewedVersion(img) {
  const id = viewed.get(img.id);
  return img.versions.find((v) => v.id === id) || currentVersion(img);
}

function imageHeight(img, version) {
  const v = version || viewedVersion(img);
  return img.width * (v.px_height / v.px_width);
}

function rootComments(version) {
  return version.comments.filter((c) => c.parent_id === null);
}

function openCount(version) {
  return rootComments(version).filter((c) => !c.resolved_at).length;
}

function isAdmin() {
  return data && data.is_admin;
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && (a.value || "").trim() !== "";
}

// ---------------------------------------------------------------- screens

function showGate() {
  $("gate").hidden = false;
  $("gate-passcode").focus();
}

function showMissing() {
  $("missing").hidden = false;
}

function showBoard() {
  $("gate").hidden = true;
  for (const id of ["topbar", "viewport", "panel"]) $(id).hidden = false;
}

$("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("gate-error").textContent = "";
  try {
    await api("POST", `/b/${encodeURIComponent(slug)}/unlock`, { passcode: $("gate-passcode").value });
    await load(true);
  } catch (err) {
    $("gate-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------- rendering

function render() {
  document.title = `${data.board.title} · Betch review`;
  $("board-title").textContent = data.board.title;
  $("admin-tools").hidden = !isAdmin();
  $("btn-edit").classList.toggle("active", editMode);
  $("btn-comment").classList.toggle("active", tool === "comment");
  viewport.classList.toggle("tool-comment", tool === "comment");
  viewport.classList.toggle("edit-mode", editMode && isAdmin());
  renderSummary();
  renderWorld();
  renderPanel();
}

function renderSummary() {
  const current = data.images.map(currentVersion);
  const approved = current.filter((v) => v.status === "approved").length;
  const changes = current.filter((v) => v.status === "changes_requested").length;
  const box = $("summary");
  box.replaceChildren();
  if (!data.images.length) return;
  append(box, [
    h("span", `${approved}/${data.images.length} approved`),
    changes ? h("span.status.changes_requested", `${changes} need changes`) : null,
  ]);
}

function renderWorld() {
  world.replaceChildren();
  const sorted = [...data.images].sort((a, b) => a.z - b.z || a.id - b.id);
  for (const img of sorted) world.append(renderItem(img));

  const empty = $("empty");
  empty.hidden = data.images.length > 0;
  empty.replaceChildren(
    h("div",
      h("strong", "Nothing here yet"),
      isAdmin() ? "Drop images anywhere on the board, or use Upload." : "Images will appear here once they're uploaded."),
  );
  applyView();
}

function renderItem(img) {
  const version = viewedVersion(img);
  const isCurrent = version === currentVersion(img);
  const el = h("div.item", { dataset: { id: img.id } });
  el.classList.add("status-" + version.status);
  if (img.id === selectedId) el.classList.add("selected");
  el.style.left = img.x + "px";
  el.style.top = img.y + "px";
  el.style.width = img.width + "px";
  el.style.height = imageHeight(img, version) + "px";

  let picture = imgCache.get(version.id);
  if (!picture) {
    picture = h("img", { alt: img.title, draggable: "false", decoding: "async" });
    picture.src = `/files/${version.id}/display`;
    imgCache.set(version.id, picture);
  }

  append(el, [
    h("div.frame"),
    picture,
    h("div.label",
      h("span.name", img.title),
      img.versions.length > 1 || !isCurrent ? h("span.ver", `v${version.number}${isCurrent ? "" : " · old"}`) : null,
      version.status !== "pending" ? statusChip(version.status) : null),
  ]);

  rootComments(version).forEach((c, i) => {
    if (c.resolved_at && !showResolved && c.id !== activeThread) return;
    const pin = h("button.pin", {
      type: "button",
      title: `${c.author}: ${c.body.slice(0, 80)}`,
      onpointerdown: (e) => e.stopPropagation(),
      onclick: (e) => {
        e.stopPropagation();
        openThread(img.id, c.id, false);
      },
    }, String(i + 1));
    if (c.is_admin) pin.classList.add("admin");
    if (c.resolved_at) pin.classList.add("resolved");
    if (c.id === activeThread) pin.classList.add("active");
    pin.style.left = c.x * 100 + "%";
    pin.style.top = c.y * 100 + "%";
    el.append(pin);
  });

  if (composer && composer.imageId === img.id && composer.versionId === version.id) {
    const pin = h("div.pin.pending", "+");
    pin.style.left = composer.x * 100 + "%";
    pin.style.top = composer.y * 100 + "%";
    el.append(pin, renderComposer());
  }

  if (isAdmin()) el.append(h("div.resize-handle", { title: "Resize" }));
  return el;
}

function renderComposer() {
  const needsName = !isAdmin() && !localStorage.getItem(NAME_KEY);
  const nameInput = needsName ? h("input", { type: "text", placeholder: "Your name", maxlength: 60, autocomplete: "name" }) : null;
  const text = draftArea("composer", { placeholder: "What should change here?", maxlength: 4000 });
  const post = async () => {
    const body = text.value.trim();
    if (!body) return text.focus();
    if (nameInput) {
      const n = nameInput.value.trim();
      if (!n) return nameInput.focus();
      localStorage.setItem(NAME_KEY, n);
    }
    const target = composer;
    const res = await mutate(() =>
      api("POST", `/b/${encodeURIComponent(slug)}/comments`, {
        version_id: target.versionId,
        x: target.x,
        y: target.y,
        body,
        author: authorName(),
      }),
    );
    if (res) {
      drafts.delete("composer");
      composer = null;
      activeThread = res.id;
      render();
    }
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post();
    if (e.key === "Escape") cancelComposer();
  });
  const box = h("div.pin-composer", {
    onpointerdown: (e) => e.stopPropagation(),
    onwheel: (e) => e.stopPropagation(),
  },
    nameInput,
    nameInput ? h("div", { class: "hint" }, "Shown next to your comments.") : null,
    text,
    h("div.row",
      h("span.who", isAdmin() ? "Posting as Betch" : authorName() ? `as ${authorName()}` : ""),
      h("button.ghost", { type: "button", onclick: cancelComposer }, "Cancel"),
      h("button.primary", { type: "button", onclick: post }, "Post")),
  );
  if (nameInput) nameInput.style.marginBottom = "4px";
  box.style.left = composer.x * 100 + "%";
  box.style.top = composer.y * 100 + "%";
  requestAnimationFrame(() => (nameInput || text).focus({ preventScroll: true }));
  return box;
}

function cancelComposer() {
  composer = null;
  drafts.delete("composer");
  render();
}

function draftArea(key, attrs) {
  const t = h("textarea", attrs);
  t.value = drafts.get(key) || "";
  t.addEventListener("input", () => drafts.set(key, t.value));
  return t;
}

function authorName() {
  return isAdmin() ? "Betch" : localStorage.getItem(NAME_KEY) || "";
}

/** Ask for the client's name once; resolves to the name or null. */
async function ensureName() {
  if (isAdmin()) return "Betch";
  const existing = localStorage.getItem(NAME_KEY);
  if (existing) return existing;
  const name = await modal((close) => {
    const input = h("input", { type: "text", maxlength: 60, autocomplete: "name", placeholder: "First and last name" });
    const submit = (e) => {
      e.preventDefault();
      if (input.value.trim()) close(input.value.trim());
    };
    return h("form", { onsubmit: submit },
      h("h2", "What's your name?"),
      h("p", "It's shown next to your comments and approvals."),
      input,
      h("div.modal-actions",
        h("button.ghost", { type: "button", onclick: () => close(null) }, "Cancel"),
        h("button.primary", { type: "submit" }, "Continue")));
  });
  if (name) localStorage.setItem(NAME_KEY, name);
  return name;
}

// ---------------------------------------------------------------- panel

function renderPanel() {
  const scrollTop = panel.querySelector(".panel-body")?.scrollTop || 0;
  panel.replaceChildren();
  const img = selectedId && imageById(selectedId);
  if (img) renderImagePanel(img);
  else renderOverviewPanel();
  const body = panel.querySelector(".panel-body");
  if (body) body.scrollTop = scrollTop;
}

function panelHead(titleNodes, meta, onClose) {
  const head = h("div.panel-head", { onclick: (e) => { if (e.target === head || e.target.tagName === "H2") toggleSheet(); } },
    h("h2", h("span.grow", titleNodes),
      onClose ? h("button.icon.ghost", { type: "button", title: "Close", onclick: (e) => { e.stopPropagation(); onClose(); } }, "×") : null),
    meta ? h("div.meta", meta) : null);
  return head;
}

function toggleSheet(force) {
  panel.classList.toggle("collapsed", force);
}

function renderOverviewPanel() {
  const current = data.images.map(currentVersion);
  const approved = current.filter((v) => v.status === "approved").length;
  const rows = [...data.images]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((img) => {
      const v = currentVersion(img);
      const open = openCount(v);
      return h("button.image-row", { type: "button", onclick: () => selectImage(img.id, true) },
        h("img", { src: `/files/${v.id}/thumb`, alt: "", loading: "lazy" }),
        h("div",
          h("div.t", img.title),
          h("div.s", statusChip(v.status), img.versions.length > 1 ? `v${v.number}` : null)),
        h("span.count", open ? `${open} open` : ""));
    });

  append(panel, [
    panelHead(data.board.title,
      data.images.length ? `${data.images.length} image${data.images.length === 1 ? "" : "s"} · ${approved} approved` : "No images yet"),
    h("div.panel-body",
      h("div.panel-section",
        h("p.small.muted",
          "Drag to move around, scroll or pinch to zoom. Select an image to leave comments and approve it or request changes.")),
      data.images.length
        ? h("div.panel-section", h("div.section-title", "Images"), h("div.image-list", rows))
        : null),
  ]);
}

function renderImagePanel(img) {
  const version = viewedVersion(img);
  const latest = currentVersion(img);
  const isCurrent = version === latest;
  const admin = isAdmin();

  const title = admin
    ? h("span", { title: "Click to rename", class: "", onclick: (e) => { e.stopPropagation(); renameImage(img); } }, img.title)
    : img.title;

  const meta = `v${version.number} · ${version.px_width}×${version.px_height}px · uploaded ${timeAgo(version.created_at)}`;
  const body = h("div.panel-body");

  // Versions
  if (img.versions.length > 1) {
    const buttons = img.versions.map((v) => {
      const b = h("button", { type: "button", onclick: () => viewVersion(img, v.id) },
        `v${v.number}${v === latest ? " · current" : ""}`);
      if (v === version) b.classList.add("active");
      return b;
    });
    append(body, h("div.panel-section",
      h("div.section-title", "Versions"),
      h("div.versions", buttons),
      isCurrent ? null : h("div.old-version-note",
        `You're looking at an older version. Its comments and decision are kept as they were. `,
        h("a", { href: "#", onclick: (e) => { e.preventDefault(); viewVersion(img, latest.id); } }, "Show current version"))));
  }

  // Decision
  const setStatus = async (status) => {
    const next = version.status === status ? "pending" : status;
    const name = await ensureName();
    if (!name) return;
    await mutate(() => api("POST", `/b/${encodeURIComponent(slug)}/versions/${version.id}/status`, { status: next, author: name }));
  };
  const canDecide = isCurrent || admin;
  const approve = h("button.approve", { type: "button", disabled: !canDecide, onclick: () => setStatus("approved") }, "✓ Approve");
  const changes = h("button.changes", { type: "button", disabled: !canDecide, onclick: () => setStatus("changes_requested") }, "↺ Request changes");
  approve.classList.toggle("active", version.status === "approved");
  changes.classList.toggle("active", version.status === "changes_requested");
  append(body, h("div.panel-section",
    h("div.section-title", "Decision"),
    h("div.decision", approve, changes),
    h("div.decision-meta",
      version.status === "pending"
        ? "Waiting for a decision."
        : `${STATUS_LABEL[version.status]} by ${version.status_by || "someone"} · ${timeAgo(version.status_at)}`)));

  // Comments
  const roots = rootComments(version);
  const open = roots.filter((c) => !c.resolved_at).length;
  const resolved = roots.length - open;
  const toggleResolved = h("input", { type: "checkbox", checked: showResolved, onchange: (e) => { showResolved = e.target.checked; render(); } });
  const threads = roots
    .map((c, i) => ({ c, n: i + 1 }))
    .filter(({ c }) => showResolved || !c.resolved_at || c.id === activeThread)
    .map(({ c, n }) => renderThread(img, version, c, n));

  append(body, h("div.panel-section",
    h("div.section-title",
      h("span.grow", `Comments${open ? ` · ${open} open` : ""}`),
      resolved ? h("label.check", toggleResolved, `Show ${resolved} resolved`) : null),
    isCurrent || admin
      ? h("button", { type: "button", onclick: () => setTool("comment") }, "+ Add a comment pin")
      : null,
    threads.length
      ? h("div", { class: "" }, threads)
      : h("p.small.muted", roots.length ? "All comments are resolved." : "No comments yet. Click “Add a comment pin”, then click the spot on the image."),
  ));
  body.lastChild.lastChild.style.marginTop = "12px";

  // Admin tools
  if (admin) {
    const versionInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true,
      onchange: (e) => e.target.files[0] && uploadVersion(img, e.target.files[0]) });
    append(body, h("div.panel-section",
      h("div.section-title", "Admin"),
      h("div.toolbar-row",
        h("button", { type: "button", onclick: () => versionInput.click() }, "Upload new version"),
        h("a.btn", { href: `/files/${version.id}/original`, download: "" }, "Download original"),
        h("button.danger", { type: "button", onclick: () => deleteImage(img) }, "Delete image"),
        versionInput),
      h("p.hint", `Original file: ${version.original_name}`)));
  }

  append(panel, [panelHead(title, meta, () => selectImage(null)), body]);
}

function renderThread(img, version, root, n) {
  const replies = version.comments.filter((c) => c.parent_id === root.id);
  const admin = isAdmin();
  const el = h("div.thread", { dataset: { id: root.id } });
  if (root.id === activeThread) el.classList.add("active");
  if (root.resolved_at) el.classList.add("resolved");

  const actions = admin
    ? h("div.comment-actions",
        h("button.ghost", { type: "button", onclick: () => resolveThread(root, !root.resolved_at) }, root.resolved_at ? "Reopen" : "Resolve"),
        h("button.ghost.danger", { type: "button", title: "Delete thread", onclick: () => deleteComment(root) }, "Delete"))
    : root.resolved_at ? h("span.small.muted", "Resolved") : null;

  append(el, h("div.thread-head",
    h("span.thread-num", { title: "Show on image", onclick: () => openThread(img.id, root.id, true) }, String(n)),
    actions));

  for (const c of [root, ...replies]) {
    append(el, h("div.comment",
      h("div.who", c.author, c.is_admin ? h("span.badge", "BETCH") : null, h("span.when", timeAgo(c.created_at)),
        admin && c !== root ? h("button.ghost", { type: "button", title: "Delete reply", onclick: () => deleteComment(c) }, "×") : null),
      h("div.body", c.body)));
  }

  const key = "reply-" + root.id;
  const text = draftArea(key, { placeholder: "Reply…", maxlength: 4000, rows: 1 });
  const send = async () => {
    const body = text.value.trim();
    if (!body) return;
    const name = await ensureName();
    if (!name) return;
    const res = await mutate(() => api("POST", `/b/${encodeURIComponent(slug)}/comments`, {
      version_id: version.id, parent_id: root.id, body, author: name,
    }));
    if (res) {
      drafts.delete(key);
      renderPanel();
    }
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  text.addEventListener("focus", () => { if (activeThread !== root.id) { activeThread = root.id; renderWorld(); } });
  append(el, h("div.reply-box", text, h("button", { type: "button", onclick: send }, "Send")));
  return el;
}

// ---------------------------------------------------------------- actions

function selectImage(id, focus) {
  selectedId = id;
  activeThread = null;
  if (composer && composer.imageId !== id) composer = null;
  render();
  if (id) toggleSheet(false);
  if (id && focus) focusImage(imageById(id));
}

function viewVersion(img, versionId) {
  viewed.set(img.id, versionId);
  activeThread = null;
  composer = null;
  render();
}

function openThread(imageId, commentId, pan) {
  selectedId = imageId;
  activeThread = commentId;
  render();
  toggleSheet(false);
  const t = panel.querySelector(`.thread[data-id="${commentId}"]`);
  if (t) t.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (pan) {
    const img = imageById(imageId);
    const c = viewedVersion(img).comments.find((x) => x.id === commentId);
    if (c) centerOn(img.x + c.x * img.width, img.y + c.y * imageHeight(img));
  }
}

function setTool(next) {
  tool = tool === next ? "move" : next;
  if (tool === "comment") {
    editMode = false;
    toast("Click the spot on an image you want to comment on");
  } else {
    composer = null;
  }
  render();
}

async function resolveThread(c, resolved) {
  await mutate(() => api("POST", `/admin/comments/${c.id}/resolve`, { resolved }));
}

async function deleteComment(c) {
  const ok = await confirmDialog("Delete comment?", c.parent_id ? "This reply will be removed." : "The whole thread, including replies, will be removed.", "Delete");
  if (ok) await mutate(() => api("DELETE", `/admin/comments/${c.id}`));
}

async function renameImage(img) {
  const title = await modal((close) => {
    const input = h("input", { type: "text", maxlength: 200, value: img.title });
    return h("form", { onsubmit: (e) => { e.preventDefault(); close(input.value.trim() || null); } },
      h("h2", "Rename image"),
      h("div.field", input),
      h("div.modal-actions",
        h("button.ghost", { type: "button", onclick: () => close(null) }, "Cancel"),
        h("button.primary", { type: "submit" }, "Save")));
  });
  if (title && title !== img.title) await mutate(() => api("PATCH", `/admin/images/${img.id}`, { title }));
}

async function deleteImage(img) {
  const ok = await confirmDialog("Delete image?", `“${img.title}”, all its versions and comments will be removed for good.`, "Delete");
  if (!ok) return;
  selectedId = null;
  await mutate(() => api("DELETE", `/admin/images/${img.id}`), "Image deleted");
}

async function uploadVersion(img, file) {
  const t = toast(`Uploading new version of “${img.title}”…`);
  const form = new FormData();
  form.append("file", file);
  try {
    await uploadForm(`/admin/images/${img.id}/versions`, form, (p) => (t.textContent = `Uploading… ${Math.round(p * 100)}%`));
    viewed.delete(img.id);
    activeThread = null;
    toast("New version uploaded");
    await load(false);
  } catch (e) {
    toast(e.message, "error");
  }
}

/** Upload files one by one, laying them out in a row from the given board point. */
async function uploadFiles(files, at) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return toast("Only image files can be uploaded", "error");
  let anchor = null;
  for (const [i, file] of files.entries()) {
    const t = toast(`Uploading ${i + 1}/${files.length}: ${file.name}`);
    const form = new FormData();
    if (anchor) {
      form.append("x", anchor.x);
      form.append("y", anchor.y);
      form.append("anchor", "left");
    } else {
      form.append("x", at.x);
      form.append("y", at.y);
    }
    form.append("file", file);
    try {
      const res = await uploadForm(`/admin/boards/${data.board.id}/images`, form,
        (p) => (t.textContent = `Uploading ${i + 1}/${files.length}: ${Math.round(p * 100)}%`));
      await load(false);
      const added = imageById(res.ids[res.ids.length - 1]);
      if (added) anchor = { x: added.x + added.width + 60, y: added.y + imageHeight(added) / 2 };
    } catch (e) {
      toast(`${file.name}: ${e.message}`, "error");
    }
  }
  if (data.images.length === files.length) fitAll(true);
}

$("btn-upload").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  uploadFiles(e.target.files, viewportCenter());
  e.target.value = "";
});
$("btn-edit").addEventListener("click", () => {
  editMode = !editMode;
  if (editMode) tool = "move";
  composer = null;
  render();
  if (editMode) toast("Arrange mode: drag images to move them, drag the corner dot to resize");
});
$("btn-comment").addEventListener("click", () => setTool("comment"));
$("zoom-in").addEventListener("click", () => zoomAtCenter(1.25));
$("zoom-out").addEventListener("click", () => zoomAtCenter(0.8));
$("zoom-fit").addEventListener("click", () => fitAll(true));

// Drag & drop upload (admin).
viewport.addEventListener("dragover", (e) => {
  if (!isAdmin() || !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  viewport.classList.add("drop-target");
});
viewport.addEventListener("dragleave", () => viewport.classList.remove("drop-target"));
viewport.addEventListener("drop", (e) => {
  viewport.classList.remove("drop-target");
  if (!isAdmin() || !e.dataTransfer.files.length) return;
  e.preventDefault();
  uploadFiles(e.dataTransfer.files, screenToBoard(e.clientX, e.clientY));
});

// ---------------------------------------------------------------- view (pan & zoom)

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  world.style.setProperty("--inv", String(1 / view.s));
  $("zoom-label").textContent = Math.round(view.s * 100) + "%";
}

function viewportRect() {
  return viewport.getBoundingClientRect();
}

function screenToBoard(cx, cy) {
  const r = viewportRect();
  return { x: (cx - r.left - view.x) / view.s, y: (cy - r.top - view.y) / view.s };
}

function viewportCenter() {
  const r = viewportRect();
  return screenToBoard(r.left + r.width / 2, r.top + r.height / 2);
}

function zoomAt(factor, cx, cy) {
  const r = viewportRect();
  const px = cx - r.left;
  const py = cy - r.top;
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.s * factor));
  const k = s / view.s;
  view.x = px - (px - view.x) * k;
  view.y = py - (py - view.y) * k;
  view.s = s;
  applyView();
}

function zoomAtCenter(factor) {
  const r = viewportRect();
  zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}

function fitBounds(b, animate, maxScale) {
  const r = viewportRect();
  const pad = Math.min(80, r.width * 0.08);
  const w = Math.max(1, b.x2 - b.x1);
  const hgt = Math.max(1, b.y2 - b.y1);
  const s = Math.min(maxScale || 1.5, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / hgt)));
  animateTo({ s, x: r.width / 2 - (b.x1 + w / 2) * s, y: r.height / 2 - (b.y1 + hgt / 2) * s }, animate);
}

function fitAll(animate) {
  if (!data || !data.images.length) {
    const r = viewportRect();
    animateTo({ s: 0.5, x: r.width / 2, y: r.height / 2 }, animate);
    return;
  }
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const img of data.images) {
    b.x1 = Math.min(b.x1, img.x);
    b.y1 = Math.min(b.y1, img.y - 30);
    b.x2 = Math.max(b.x2, img.x + img.width);
    b.y2 = Math.max(b.y2, img.y + imageHeight(img));
  }
  fitBounds(b, animate, 1);
}

function focusImage(img) {
  fitBounds({ x1: img.x, y1: img.y - 30, x2: img.x + img.width, y2: img.y + imageHeight(img) }, true, 2);
}

function centerOn(bx, by) {
  const r = viewportRect();
  animateTo({ s: view.s, x: r.width / 2 - bx * view.s, y: r.height / 2 - by * view.s }, true);
}

let animation = null;
function animateTo(target, animate) {
  cancelAnimationFrame(animation);
  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    view = target;
    return applyView();
  }
  const from = { ...view };
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / 260);
    const e = 1 - Math.pow(1 - p, 3);
    view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, s: from.s + (target.s - from.s) * e };
    applyView();
    if (p < 1) animation = requestAnimationFrame(step);
  };
  animation = requestAnimationFrame(step);
}

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  cancelAnimationFrame(animation);
  // Pinch on a trackpad arrives as ctrl+wheel. Mouse wheels send coarse
  // vertical steps; trackpad scrolling (fine or horizontal deltas) pans.
  const isMouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || isMouseWheel) {
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

// ---------------------------------------------------------------- pointer gestures

const pointers = new Map();
let gesture = null;

viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  if (e.target.closest(".pin-composer, .pin")) return;
  cancelAnimationFrame(animation);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewport.setPointerCapture(e.pointerId);

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true };
    return;
  }
  if (pointers.size > 2) return;

  const itemEl = e.target.closest(".item");
  const img = itemEl && imageById(Number(itemEl.dataset.id));
  const start = { x: e.clientX, y: e.clientY, view: { ...view } };
  if (img && isAdmin() && editMode && e.target.classList.contains("resize-handle")) {
    gesture = { type: "resize", img, start, width: img.width, moved: false };
  } else if (img && isAdmin() && editMode && tool === "move") {
    gesture = { type: "move", img, start, x: img.x, y: img.y, moved: false };
  } else {
    gesture = { type: "pan", img, start, itemEl, moved: false };
  }
  busy++;
});

viewport.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture.type === "pinch") {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    view.x += mid.x - gesture.mid.x;
    view.y += mid.y - gesture.mid.y;
    zoomAt(dist / gesture.dist, mid.x, mid.y);
    gesture.dist = dist;
    gesture.mid = mid;
    return;
  }

  const dx = e.clientX - gesture.start.x;
  const dy = e.clientY - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!gesture.moved) {
    gesture.moved = true;
    if (gesture.type === "pan") viewport.classList.add("panning");
    if (gesture.type === "move" || gesture.type === "resize") {
      selectedId = gesture.img.id;
      gesture.img.z = Math.max(...data.images.map((i) => i.z)) + 1;
      renderWorld();
      gesture.el = world.querySelector(`.item[data-id="${gesture.img.id}"]`);
    }
  }

  if (gesture.type === "pan") {
    view.x = gesture.start.view.x + dx;
    view.y = gesture.start.view.y + dy;
    applyView();
  } else if (gesture.type === "move") {
    gesture.img.x = gesture.x + dx / view.s;
    gesture.img.y = gesture.y + dy / view.s;
    gesture.el.style.left = gesture.img.x + "px";
    gesture.el.style.top = gesture.img.y + "px";
  } else if (gesture.type === "resize") {
    gesture.img.width = Math.max(60, gesture.width + dx / view.s);
    gesture.el.style.width = gesture.img.width + "px";
    gesture.el.style.height = imageHeight(gesture.img) + "px";
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size === 0) finishGesture();
    return;
  }
  const g = gesture;
  finishGesture();
  if (e.type === "pointercancel") return;

  if (g.type === "move" || g.type === "resize") {
    if (g.moved) {
      const patch = g.type === "move" ? { x: g.img.x, y: g.img.y, z: g.img.z } : { width: g.img.width, z: g.img.z };
      mutate(() => api("PATCH", `/admin/images/${g.img.id}`, patch));
      renderPanel();
    } else {
      selectImage(g.img.id);
    }
    return;
  }

  if (g.moved) return;
  // A click (no drag).
  if (g.img && tool === "comment") {
    placeComposer(g.img, e.clientX, e.clientY);
  } else if (g.img) {
    if (selectedId !== g.img.id) selectImage(g.img.id);
  } else if (composer) {
    cancelComposer();
  } else if (selectedId) {
    selectImage(null);
  }
}

function finishGesture() {
  gesture = null;
  viewport.classList.remove("panning");
  busy = Math.max(0, busy - 1);
  if (refreshPending) refresh();
}

viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

function placeComposer(img, clientX, clientY) {
  const version = viewedVersion(img);
  if (version !== currentVersion(img) && !isAdmin()) {
    toast("Switch to the current version to add comments", "error");
    return;
  }
  const p = screenToBoard(clientX, clientY);
  const x = (p.x - img.x) / img.width;
  const y = (p.y - img.y) / imageHeight(img);
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  composer = { imageId: img.id, versionId: version.id, x, y };
  selectedId = img.id;
  activeThread = null;
  render();
}

// ---------------------------------------------------------------- keyboard

document.addEventListener("keydown", (e) => {
  if (!data || e.target.closest("input, textarea") || document.querySelector(".modal-backdrop")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "c": case "C": setTool("comment"); break;
    case "a": case "A": if (isAdmin()) $("btn-edit").click(); break;
    case "+": case "=": zoomAtCenter(1.25); break;
    case "-": case "_": zoomAtCenter(0.8); break;
    case "0": fitAll(true); break;
    case "Escape":
      if (composer) cancelComposer();
      else if (tool !== "move") setTool("move");
      else if (selectedId) selectImage(null);
      break;
    default: return;
  }
  e.preventDefault();
});

window.addEventListener("resize", () => data && applyView());
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
setInterval(poll, POLL_MS);
if (matchMedia("(max-width: 820px)").matches) panel.classList.add("collapsed");

load(true);
