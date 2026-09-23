#!/usr/bin/env python3
"""Post-process a generated eval viewer so easy-mode outputs are reviewable.

Two problems, both inherent to reviewing HTML deliverables inside an HTML page:

1. generate_review.py inlines every run's outputs into one
   `const EMBEDDED_DATA = {...};` literal inside a <script>. When an output is
   itself an HTML page with its own <script> blocks, the first </script> inside
   that JSON closes the viewer's script element early -- the browser stops
   parsing JS there and renders the rest of the document as plain text.
   Fixed by escaping `<` as \\u003c throughout the JSON literal. JSON carries no
   bare `<` outside string values, so this cannot corrupt the structure, and
   \\u003c parses back to exactly `<`.

2. .html outputs are classified as "text" and dumped into a <pre>, so a page
   built to be looked at can only be read as source. Fixed by retyping them as
   "html" and teaching the viewer to render those in a sandboxed iframe, with a
   toggle to fall back to source.

Usage: python3 fix_viewer.py <viewer.html> [output.html]
"""
import json
import re
import sys

src_path = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else src_path
src = open(src_path, encoding="utf-8").read()

# --- 1. Render HTML outputs as HTML -----------------------------------------

RENDER_BRANCH = """if (file.type === "html") {
          const wrap = document.createElement("div");
          wrap.className = "html-preview";
          const bar = document.createElement("div");
          bar.className = "html-preview-bar";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "View source";
          const frame = document.createElement("iframe");
          // Scripts run so the page's real behaviour is visible, but without
          // allow-same-origin it cannot reach this document or its storage.
          frame.setAttribute("sandbox", "allow-scripts");
          frame.srcdoc = file.content;
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          pre.style.display = "none";
          btn.addEventListener("click", function () {
            const showingSource = pre.style.display !== "none";
            pre.style.display = showingSource ? "none" : "block";
            frame.style.display = showingSource ? "block" : "none";
            btn.textContent = showingSource ? "View source" : "View rendered";
          });
          bar.appendChild(btn);
          wrap.appendChild(bar);
          wrap.appendChild(frame);
          wrap.appendChild(pre);
          TARGET.appendChild(wrap);
        } else if (file.type === "text") {"""

replacements = 0
for target in ("content", "fc"):
    needle = f"""if (file.type === "text") {{
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          {target}.appendChild(pre);"""
    if needle in src:
        branch = RENDER_BRANCH.replace("TARGET", target)
        body = f"""{branch}
          const pre = document.createElement("pre");
          pre.textContent = file.content;
          {target}.appendChild(pre);"""
        src = src.replace(needle, body, 1)
        replacements += 1

CSS = """
    .output-file-content .html-preview iframe {
      width: 100%;
      height: 78vh;
      min-height: 520px;
      border: 1px solid rgba(128,128,128,.35);
      border-radius: 6px;
      background: #fff;
    }
    .output-file-content .html-preview-bar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: .4rem;
    }
    .output-file-content .html-preview-bar button {
      font: inherit;
      font-size: .78rem;
      padding: .25rem .6rem;
      cursor: pointer;
      border-radius: 5px;
      border: 1px solid rgba(128,128,128,.45);
      background: transparent;
      color: inherit;
    }
"""
src = src.replace("    .output-file-content iframe {", CSS + "    .output-file-content iframe {", 1)

# --- 2. Retype .html outputs, then escape the payload ------------------------

lines = src.split("\n")
patched = retyped = 0

for i, line in enumerate(lines):
    stripped = line.lstrip()
    if not stripped.startswith("const EMBEDDED_DATA"):
        continue

    payload = stripped[len("const EMBEDDED_DATA"):].lstrip()
    payload = payload[1:] if payload.startswith("=") else payload
    data = json.loads(payload.strip().rstrip(";"))

    for run in data.get("runs", []):
        for f in run.get("outputs", []):
            if f.get("name", "").lower().endswith((".html", ".htm")) and f.get("type") == "text":
                f["type"] = "html"
                retyped += 1

    indent = line[: len(line) - len(stripped)]
    serialized = json.dumps(data).replace("<", "\\u003c")
    lines[i] = f"{indent}const EMBEDDED_DATA = {serialized};"
    patched += 1

fixed = "\n".join(lines)
open(out_path, "w", encoding="utf-8").write(fixed)

depth, ok = 0, True
for m in re.finditer(r"</?script", fixed):
    depth += -1 if m.group(0).startswith("</") else 1
    if depth < 0 or depth > 1:
        ok = False

print(f"render branches patched : {replacements} (expect 2)")
print(f"html outputs retyped    : {retyped}")
print(f"data lines re-escaped   : {patched}")
print(f"script tags nest cleanly: {ok} (final depth {depth})")
