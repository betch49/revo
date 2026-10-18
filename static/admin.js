// Dashboard: sign in, create, share, duplicate and delete boards.
"use strict";

const $ = (id) => document.getElementById(id);
let publicUrl = location.origin;

const ACCESS_LABEL = {
  private: "Private",
  view: "Link: can view",
  comment: "Link: can comment",
  edit: "Link: can edit",
};

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

const boardUrl = (slug) => `${publicUrl}/${slug}`;

function updateSlugPreview() {
  const slug = $("new-slug").value;
  $("slug-preview").textContent = slug ? boardUrl(slug) : "";
}

$("new-slug").addEventListener("input", () => {
  $("new-slug").value = $("new-slug").value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  updateSlugPreview();
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("create-error").textContent = "";
  try {
    const board = await api("POST", "/admin/boards", { title: $("new-title").value, slug: $("new-slug").value.trim() || null });
    location.href = "/" + board.slug;
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
  $("board-count").textContent = boards.length ? String(boards.length) : "";
  const list = $("boards");
  list.replaceChildren();
  if (!boards.length) {
    list.append(h("div.empty", "No boards yet. Create your first one on the left."));
    return;
  }
  for (const b of boards) list.append(boardCard(b));
}

/** A colored tile per board, derived from its link so it stays the same. */
function coverFor(b) {
  let n = 0;
  for (const c of b.slug) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const hue = n % 360;
  const cover = h("a.cover", { href: "/" + b.slug, "aria-label": `Open ${b.title}` },
    h("span.cover-initial", b.title.trim().charAt(0).toUpperCase() || "B"));
  cover.style.setProperty("--h1", String(hue));
  cover.style.setProperty("--h2", String((hue + 40) % 360));
  return cover;
}

function boardCard(b) {
  const stats = h("div.stats",
    h("span", `${b.items} item${b.items === 1 ? "" : "s"}`),
    b.open_comments ? h("span.acc", `${b.open_comments} open comment${b.open_comments === 1 ? "" : "s"}`) : null,
    b.online ? h("span.ok", `${b.online} online now`) : null);
  return h("article.board-card",
    coverFor(b),
    h("div.info",
      h("div.t", h("a", { href: "/" + b.slug }, b.title)),
      h("div.badges", h("span.lock", ACCESS_LABEL[b.access] || b.access), b.has_passcode ? h("span.lock", "Passcode") : null),
      h("div.link", boardUrl(b.slug)),
      stats,
      h("div.small.muted", `Edited ${timeAgo(b.updated_at)}`)),
    h("div.actions",
      h("a.btn.primary", { href: "/" + b.slug }, "Open"),
      h("button", { type: "button", onclick: () => copyText(boardUrl(b.slug)) }, "Copy link"),
      h("button", { type: "button", onclick: () => editBoard(b) }, "Settings"),
      h("button", { type: "button", onclick: () => duplicateBoard(b) }, "Duplicate"),
      h("button.danger", { type: "button", onclick: () => deleteBoard(b) }, "Delete")));
}

async function editBoard(b) {
  const result = await modal((close) => {
    const title = h("input#edit-title", { type: "text", maxlength: 120, value: b.title, required: true });
    const access = h("select#edit-access", Object.entries(ACCESS_LABEL).map(([v, label]) => {
      const o = h("option", { value: v }, label);
      if (v === b.access) o.selected = true;
      return o;
    }));
    const passcode = h("input#edit-passcode", { type: "text", maxlength: 100, autocomplete: "off", placeholder: b.has_passcode ? "Leave empty to keep the current passcode" : "No passcode" });
    const remove = b.has_passcode ? h("input#edit-remove", { type: "checkbox" }) : null;
    const submit = (e) => {
      e.preventDefault();
      const patch = { title: title.value, access: access.value };
      if (remove && remove.checked) patch.passcode = "";
      else if (passcode.value.trim()) patch.passcode = passcode.value.trim();
      close(patch);
    };
    return h("form", { onsubmit: submit },
      h("h2", "Board settings"),
      h("p", boardUrl(b.slug)),
      h("div.field", h("label", { for: "edit-title" }, "Name"), title),
      h("div.field", h("label", { for: "edit-access" }, "Who can open the link"), access),
      h("div.field", h("label", { for: "edit-passcode" }, b.has_passcode ? "New passcode" : "Passcode"), passcode,
        h("div.hint", "Changing it signs out people who entered the old one.")),
      remove ? h("label.check", remove, "Remove passcode") : null,
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

async function duplicateBoard(b) {
  try {
    const copy = await api("POST", `/admin/boards/${b.id}/duplicate`);
    toast(`Created “${copy.title}”`);
    loadBoards();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteBoard(b) {
  const ok = await confirmDialog(
    `Delete “${b.title}”?`,
    `The board, its ${b.items} item${b.items === 1 ? "" : "s"}, images and comments are deleted for good, and the link stops working.`,
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
