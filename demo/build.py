#!/usr/bin/env python3
"""Build a single-file, server-less demo of the board editor.

The real front end (static/) runs unchanged on top of demo/mock.js, an
in-browser stand-in for the Rust server and its live connection.
Usage:  python3 demo/build.py out.html
"""
import base64
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def patch(src, old, new):
    assert src.count(old) == 1, f"expected once: {old!r}"
    return src.replace(old, new)


def body_of(html):
    body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
    return re.sub(r"<script.*?</script>", "", body, flags=re.S).strip()


def script(code):
    return "<script>\n" + code.replace("</script", "<\\/script") + "\n</script>"


def font(name):
    return base64.b64encode((STATIC / "fonts" / name).read_bytes()).decode()


css = read("static/app.css")
css = patch(css, "url(/static/space-grotesk.woff2)", f"url(data:font/woff2;base64,{font('space-grotesk-latin-wght-normal.woff2')})")
css = patch(css, "url(/static/space-grotesk-ext.woff2)", f"url(data:font/woff2;base64,{font('space-grotesk-latin-ext-wght-normal.woff2')})")

demo_bar = """
<div id="demo-bar" class="ui" role="region" aria-label="Demo controls">
  <span class="demo-tag">Demo</span>
  <span class="demo-text">Runs in your browser. Your changes stay on this device.</span>
  <label class="check"><input type="checkbox" id="demo-teammate" checked> Simulated teammate</label>
  <button type="button" class="ghost" id="demo-reset">Reset board</button>
</div>"""

demo_wiring = """
document.getElementById("demo-teammate").addEventListener("change", (e) => Demo.setTeammate(e.target.checked));
document.getElementById("demo-reset").addEventListener("click", async () => {
  if (await confirmDialog("Reset the demo board?", "Your changes are removed and the sample board comes back.", "Reset")) Demo.reset();
});
"""

scripts = ['document.body.classList.add("board-page");', read("static/common.js")] + [read(f"static/board-{n}.js") for n in ("core", "render", "tools", "ui")]
scripts += [read("demo/mock.js"), read("static/board-main.js"), demo_wiring]

page = f"""<title>Betch Board</title>
<meta name="robots" content="noindex">
<style>
{css}
{read("static/board.css")}
{read("demo/demo.css")}
</style>
{body_of(read("static/board.html"))}
{demo_bar}
{"".join(script(s) for s in scripts)}
"""

out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "demo/revo-demo.html")
out.write_text(page, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
