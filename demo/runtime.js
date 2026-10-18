// Demo shell: swaps between the admin dashboard and board pages inside one
// document, and lets you switch between your browser and a client's.
"use strict";

(() => {
  const root = document.getElementById("demo-root");
  const paths = { admin: "/atelier-lumen", client: "/atelier-lumen" };
  let gen = 0;
  let cleanup = [];

  const path = () => paths[Demo.role];
  const never = () => new Promise(() => {});

  function navigate(p) {
    paths[Demo.role] = p === "/" ? "/admin" : p;
    run();
  }

  // Ignore results that arrive after the page they belong to was replaced.
  function guard(g, promise) {
    return promise.then((v) => (g === gen ? v : never()), (e) => (g === gen ? Promise.reject(e) : never()));
  }

  function run() {
    const g = ++gen;
    cleanup.forEach((f) => f());
    cleanup = [];
    document.querySelectorAll("#toasts, .modal-backdrop").forEach((e) => e.remove());

    const view = path() === "/admin" ? "admin" : "board";
    document.body.classList.toggle("board-page", view === "board");
    root.innerHTML = document.getElementById("tpl-" + view).innerHTML;
    updateBar();

    // Track the global listeners and timers the page script registers, so
    // they can be removed when the next page replaces it.
    const added = [];
    const track = (target) => {
      target.addEventListener = function (type, fn, opts) {
        added.push(() => EventTarget.prototype.removeEventListener.call(target, type, fn, opts));
        return EventTarget.prototype.addEventListener.call(target, type, fn, opts);
      };
    };
    const origInterval = window.setInterval;
    track(document);
    track(window);
    window.setInterval = (fn, ms, ...args) => {
      const t = origInterval(fn, ms, ...args);
      added.push(() => clearInterval(t));
      return t;
    };
    try {
      new Function("api", "uploadForm", "demoFile", "demoNavigate", "demoPath", "localStorage", VIEW_SOURCES[view])(
        (m, p, b) => guard(g, Demo.api(m, p, b)),
        (p, f, cb) => guard(g, Demo.uploadForm(p, f, cb)),
        Demo.file,
        navigate,
        path,
        Demo.store(),
      );
    } finally {
      delete document.addEventListener;
      delete window.addEventListener;
      window.setInterval = origInterval;
    }
    cleanup = added;
  }

  // ---------------------------------------------------------------- demo bar

  const bar = document.getElementById("demo-bar");
  const hint = document.getElementById("demo-hint");
  const boardSelect = document.getElementById("demo-board");

  function updateBar() {
    for (const b of bar.querySelectorAll("[data-role]")) {
      b.classList.toggle("active", b.dataset.role === Demo.role);
      b.setAttribute("aria-pressed", String(b.dataset.role === Demo.role));
    }
    const client = Demo.role === "client";
    hint.textContent = client ? "Passcode for Atelier Lumen: lumen2026" : `Admin password: ${Demo.ADMIN_PASSWORD}`;
    boardSelect.hidden = !client;
    if (client) {
      boardSelect.replaceChildren(
        ...Demo.boards().map((b) => {
          const o = document.createElement("option");
          o.value = "/" + b.slug;
          o.textContent = b.title;
          o.selected = "/" + b.slug === path();
          return o;
        }),
      );
    }
  }

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-role]");
    if (!b || b.dataset.role === Demo.role) return;
    Demo.role = b.dataset.role;
    run();
  });
  boardSelect.addEventListener("change", () => navigate(boardSelect.value));
  document.getElementById("demo-reset").addEventListener("click", () => {
    Demo.seed();
    paths.admin = paths.client = "/atelier-lumen";
    run();
    toast("Sample boards restored");
  });

  // Internal links (/admin, /<board>) switch pages inside the demo.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/"]');
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }, true);

  window.copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied");
    } catch (_) {
      toast(`Link: ${text}`);
    }
  };

  run();
  toast("Everything here runs in your browser. Switch between your view and a client's at the bottom left.");
})();
