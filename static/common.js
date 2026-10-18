// Shared helpers for the board and admin pages.
"use strict";

/** Call the JSON API. Throws an Error with `.status` and `.code` on failure. */
async function api(method, path, body) {
  const opts = { method, headers: { "X-Revo": "1" }, credentials: "same-origin" };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api" + path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/** Upload with progress events (fetch has none). */
function uploadForm(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api" + path);
    xhr.setRequestHeader("X-Revo", "1");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.message) || (xhr.status === 413 ? "File is too large" : `Upload failed (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

/**
 * Tiny DOM builder: h("div.card#x", {onclick, title, dataset}, child, "text", ...)
 * Text is always set as text, never parsed as HTML.
 */
function h(tag, attrs, ...children) {
  const m = tag.match(/^([a-z0-9]+)((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m ? m[1] : tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

/** Append nodes/strings (nested arrays allowed); null/false are skipped. */
function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(message, kind) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div#toasts");
    document.body.append(box);
  }
  const t = h("div.toast" + (kind === "error" ? ".error" : ""), message);
  box.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 5000 : 2600);
  return t;
}

function timeAgo(unix) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const STATUS_LABEL = { pending: "Pending review", approved: "Approved", changes_requested: "Changes requested" };

function statusChip(status) {
  return h("span.status." + status, STATUS_LABEL[status] || status);
}

/** Promise-based modal. `build(close)` returns the card contents. */
function modal(build) {
  return new Promise((resolve) => {
    const backdrop = h("div.modal-backdrop");
    const close = (value) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener("keydown", onKey);
    backdrop.append(h("div.card", build(close)));
    document.body.append(backdrop);
    const first = backdrop.querySelector("input, textarea");
    if (first) first.focus();
  });
}

function confirmDialog(title, text, okLabel) {
  return modal((close) => [
    h("h2", title),
    h("p", text),
    h("div.modal-actions",
      h("button.ghost", { type: "button", onclick: () => close(false) }, "Cancel"),
      h("button.primary", { type: "button", onclick: () => close(true) }, okLabel || "OK")),
  ]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch (_) {
    window.prompt("Copy this link:", text);
  }
}
