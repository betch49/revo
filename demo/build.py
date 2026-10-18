#!/usr/bin/env python3
"""Build a single-file, server-less demo of the review app.

The real front end (static/) runs unchanged on top of demo/mock.js, an
in-browser stand-in for the Rust API. Usage:  python3 demo/build.py out.html
"""
import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def patch(src, old, new, count=1):
    assert src.count(old) == count, f"expected {count}x: {old!r}"
    return src.replace(old, new)


def body_of(html):
    body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
    return re.sub(r"<script.*?</script>", "", body, flags=re.S).strip()


FILE_URL = re.compile(r"`/files/\$\{([^}]+)\}/(\w+)`")


def view_source(path, patches):
    src = read(path)
    for old, new in patches:
        src = patch(src, old, new)
    src = FILE_URL.sub(r'demoFile(\1, "\2")', src)
    assert "/files/" not in src and "location." not in src, path
    return src


board_js = view_source("static/board.js", [
    ('const slug = decodeURIComponent(location.pathname.replace(/^\\/+|\\/+$/g, ""));',
     "const slug = demoPath().slice(1);"),
    ("location.reload();", "demoNavigate(demoPath());"),
    # Downloads are blocked inside artifacts.
    ('h("a.btn", { href: `/files/${version.id}/original`, download: "" }, "Download original"),', ""),
])
admin_js = view_source("static/admin.js", [
    ("let publicUrl = location.origin;", 'let publicUrl = "https://review.betch.ch";'),
    ('location.href = "/" + slug;', 'demoNavigate("/" + slug);'),
])

font = base64.b64encode((STATIC / "fonts/space-grotesk-latin-wght-normal.woff2").read_bytes()).decode()
font_ext = base64.b64encode((STATIC / "fonts/space-grotesk-latin-ext-wght-normal.woff2").read_bytes()).decode()
css = read("static/app.css")
css = patch(css, "url(/static/space-grotesk.woff2)", f"url(data:font/woff2;base64,{font})")
css = patch(css, "url(/static/space-grotesk-ext.woff2)", f"url(data:font/woff2;base64,{font_ext})")


def script(code):
    return "<script>\n" + code.replace("</script", "<\\/script") + "\n</script>"


sources = json.dumps({"board": board_js, "admin": admin_js}).replace("</", "<\\/")

page = f"""<title>Betch Review Board</title>
<meta name="robots" content="noindex">
<style>
{css}
{read("demo/demo.css")}
</style>
<template id="tpl-board">
{body_of(read("static/board.html"))}
</template>
<template id="tpl-admin">
{body_of(read("static/admin.html"))}
</template>
<div id="demo-root"></div>
<div id="demo-bar" role="region" aria-label="Demo controls">
  <span class="demo-tag">Demo</span>
  <div class="demo-seg" role="group" aria-label="View as">
    <button type="button" data-role="admin">You (Betch)</button>
    <button type="button" data-role="client">Client</button>
  </div>
  <select id="demo-board" aria-label="Board the client opens" hidden></select>
  <span class="demo-hint" id="demo-hint"></span>
  <button type="button" class="ghost" id="demo-reset" title="Restore the sample boards">Reset</button>
</div>
{script(read("static/common.js"))}
<script>const VIEW_SOURCES = {sources};</script>
{script(read("demo/mock.js"))}
{script(read("demo/runtime.js"))}
"""

out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "demo/revo-demo.html")
out.write_text(page, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
