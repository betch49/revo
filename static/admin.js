// Admin dashboard: sign in, create, edit and delete boards.
"use strict";

const $ = (id) => document.getElementById(id);
let publicUrl = location.origin;
let slugEdited = false;

async function init() {
  const s = await api("GET", "/admin/session");
  if (s.public_url) publicUrl = s.public_url;
  if (s.admin) showDashboard();
  else showLogin();
}

function showLogin() {
  $("dashboard").hidden = true;
  $("login").hidden = false;
  $("login-password").focus();
}

async function showDashboard() {
  $("login").hidden = true;
  $("dashboard").hidden = false;
  updateSlugPreview();
  await loadBoards();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("POST", "/admin/login", { password: $("login-password").value });
    $("login-password").value = "";
    showDashboard();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  await api("POST", "/admin/logout");
  showLogin();
});

// ---------------------------------------------------------------- create

function slugify(text) {
  return text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function boardUrl(slug) {
  return `${publicUrl}/${slug}`;
}

function updateSlugPreview() {
  const slug = $("new-slug").value;
  $("slug-preview").textContent = slug ? boardUrl(slug) : `${publicUrl}/…`;
}

$("new-title").addEventListener("input", () => {
  if (!slugEdited) $("new-slug").value = slugify($("new-title").value);
  updateSlugPreview();
});
$("new-slug").addEventListener("input", () => {
  slugEdited = $("new-slug").value !== "";
  $("new-slug").value = $("new-slug").value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  updateSlugPreview();
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  const slug = $("new-slug").value.trim();
  try {
    await api("POST", "/admin/boards", {
      title: $("new-title").value,
      slug,
      passcode: $("new-passcode").value || null,
    });
    e.target.reset();
    slugEdited = false;
    updateSlugPreview();
    toast("Board created");
    location.href = "/" + slug;
  } catch (err) {
    $("create-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------- list

async function loadBoards() {
  let boards;
  try {
    boards = await api("GET", "/admin/boards");
  } catch (e) {
    if (e.status === 401) return showLogin();
    return toast(e.message, "error");
  }
  $("board-count").textContent = boards.length ? `${boards.length}` : "";
  const list = $("boards");
  list.replaceChildren();
  if (!boards.length) {
    list.append(h("div.empty", "No boards yet. Create one for your first client."));
    return;
  }
  for (const b of boards) list.append(boardCard(b));
}

function boardCard(b) {
  const cover = h("a.cover", { href: "/" + b.slug },
    b.cover_version_id ? h("img", { src: `/files/${b.cover_version_id}/thumb`, alt: "", loading: "lazy" }) : "No images yet");
  const stats = h("div.stats",
    h("span", `${b.images} image${b.images === 1 ? "" : "s"}`),
    b.images ? h("span.ok", `${b.approved} approved`) : null,
    b.changes_requested ? h("span.warn", `${b.changes_requested} need changes`) : null,
    b.open_comments ? h("span.acc", `${b.open_comments} open comment${b.open_comments === 1 ? "" : "s"}`) : null);
  return h("article.board-card",
    cover,
    h("div.info",
      h("div.t", h("a", { href: "/" + b.slug }, b.title), b.has_passcode ? h("span.lock", "passcode") : null),
      h("div.link", boardUrl(b.slug)),
      stats,
      h("div.small.muted", `Created ${timeAgo(b.created_at)}`)),
    h("div.actions",
      h("a.btn.primary", { href: "/" + b.slug }, "Open"),
      h("button", { type: "button", onclick: () => copyText(boardUrl(b.slug)) }, "Copy link"),
      h("button", { type: "button", onclick: () => editBoard(b) }, "Settings"),
      h("button.danger", { type: "button", onclick: () => deleteBoard(b) }, "Delete")));
}

async function editBoard(b) {
  const result = await modal((close) => {
    const title = h("input", { type: "text", maxlength: 120, value: b.title, required: true });
    const passcode = h("input", { type: "text", maxlength: 100, autocomplete: "off",
      placeholder: b.has_passcode ? "Leave empty to keep the current passcode" : "No passcode" });
    const remove = b.has_passcode ? h("input", { type: "checkbox" }) : null;
    const submit = (e) => {
      e.preventDefault();
      const patch = { title: title.value };
      if (remove && remove.checked) patch.passcode = "";
      else if (passcode.value.trim()) patch.passcode = passcode.value.trim();
      close(patch);
    };
    return h("form", { onsubmit: submit },
      h("h2", "Board settings"),
      h("p", boardUrl(b.slug)),
      h("div.field", h("label", "Client / project"), title),
      h("div.field", h("label", b.has_passcode ? "New passcode" : "Passcode"), passcode,
        h("div.hint", "Changing it signs out clients who entered the old one.")),
      remove ? h("label.check", remove, "Remove passcode (anyone with the link can open the board)") : null,
      h("div.modal-actions",
        h("button.ghost", { type: "button", onclick: () => close(null) }, "Cancel"),
        h("button.primary", { type: "submit" }, "Save")));
  });
  if (!result) return;
  try {
    await api("PATCH", `/admin/boards/${b.id}`, result);
    toast("Saved");
    loadBoards();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteBoard(b) {
  const ok = await confirmDialog(
    `Delete “${b.title}”?`,
    `The board, its ${b.images} image${b.images === 1 ? "" : "s"}, all versions and comments are deleted for good, and the link stops working.`,
    "Delete board");
  if (!ok) return;
  try {
    await api("DELETE", `/admin/boards/${b.id}`);
    toast("Board deleted");
    loadBoards();
  } catch (e) {
    toast(e.message, "error");
  }
}

init().catch((e) => toast(e.message, "error"));
