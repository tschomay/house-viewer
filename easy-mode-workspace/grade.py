#!/usr/bin/env python3
"""Mechanically grade easy-mode outputs. Each check returns (passed, evidence)."""
import html, json, os, re, subprocess, sys, tempfile, glob

def read_outputs(d):
    files = {}
    for p in glob.glob(os.path.join(d, "outputs", "**", "*"), recursive=True):
        if os.path.isfile(p):
            try:
                files[os.path.basename(p)] = open(p, encoding="utf-8").read()
            except Exception:
                pass
    return files

def htmls(files):
    return {n: c for n, c in files.items() if n.lower().endswith((".html", ".htm"))}

def c_html_deliverable(f):
    h = htmls(f)
    if not h:
        return False, f"no HTML file produced; got {sorted(f) or 'nothing'}"
    n, c = next(iter(h.items()))
    return True, f"{n} ({len(c)} bytes)"

def c_copy_blocks(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    btns = re.findall(r'data-copy="([^"]+)"', c)
    ids = set(re.findall(r'<code id="([^"]+)"', c))
    if not btns: return False, "no copy buttons found"
    orphan = set(btns) - ids
    return (not orphan), f"{len(btns)} copy buttons, {len(ids)} targets, orphans={sorted(orphan) or 'none'}"

def c_white_space_pre(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    ok = bool(re.search(r'white-space:\s*pre', c))
    return ok, "white-space:pre present" if ok else "no white-space:pre rule"

def c_deep_links(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    links = re.findall(r'href="(https?://[^"]+)"', c)
    ext = [l for l in links if "fonts.googleapis" not in l and "fonts.gstatic" not in l]
    deep = [l for l in ext if len(l.rstrip("/").split("/")) > 3]
    if not ext: return False, "no external links"
    return len(deep) >= max(2, len(ext)//2), f"{len(deep)}/{len(ext)} links are deep paths"

def c_localstorage(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    if "localStorage" not in c: return False, "no localStorage usage"
    guarded = bool(re.search(r'try\s*\{[^}]*localStorage', c, re.S))
    return guarded, "localStorage wrapped in try/catch" if guarded else "localStorage used but not guarded"

def c_heredoc_single_paste(f):
    h = htmls(f)
    blob = next(iter(h.values())) if h else "\n".join(f.values())
    u = html.unescape(blob)
    ok = bool(re.search(r"<<\s*'?[A-Z]+'?\s*\n", u))
    return ok, "heredoc single-paste block present" if ok else "no heredoc-wrapped block"

def c_failure_signature(f):
    text = "\n".join(f.values()).lower()
    pats = ["failure signature", "if you see", "symptom", "means", "reads like", "looks like"]
    hits = [p for p in pats if p in text]
    return len(hits) >= 2, f"signals: {hits}"

def c_rerun_safe(f):
    text = "\n".join(f.values()).lower()
    pats = ["idempotent", "safe to re-run", "safe to run again", "run it again", "re-running", "as many times"]
    hits = [p for p in pats if p in text]
    return bool(hits), f"signals: {hits or 'none'}"

def c_warning_in_step(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    steps = re.findall(r'<li[^>]*class="[^"]*step[^"]*"(.*?)</li>', c, re.S)
    warned = sum(1 for s in steps if re.search(r'class="[^"]*(note|warn|caution|callout)', s))
    return warned >= 1, f"{warned}/{len(steps)} steps contain an inline callout"

def c_prereqs_frontloaded(f):
    h = htmls(f)
    if not h: return False, "no HTML deliverable"
    c = next(iter(h.values()))
    first_step = c.find('class="step')
    head = c[:first_step] if first_step > 0 else ""
    pats = ["before you start", "prerequisite", "before starting", "you need", "first"]
    hits = [p for p in pats if p in head.lower()]
    return bool(hits), f"pre-step signals: {hits or 'none'}"

CHECKS = [
    ("Deliverable is a self-contained HTML page, not only a chat reply or markdown file", c_html_deliverable),
    ("Every command and pasteable value sits in a copy-to-clipboard block with a button", c_copy_blocks),
    ("Copy blocks use white-space:pre so long values cannot soft-wrap into the copied text", c_white_space_pre),
    ("Links target specific console pages rather than product homepages", c_deep_links),
    ("Checklist progress persists to localStorage inside try/catch", c_localstorage),
    ("At least one warning is placed inside the step where it fires, not only in a preamble", c_warning_in_step),
    ("Names at least one concrete failure signature (symptom to cause)", c_failure_signature),
    ("Multi-command shell sequences are wrapped as a single paste (heredoc or one block)", c_heredoc_single_paste),
    ("States whether re-running a step is safe, or makes scripts idempotent", c_rerun_safe),
    ("Prerequisites that could block the whole procedure are front-loaded before step 1 work", c_prereqs_frontloaded),
]

base = sys.argv[1]
for run in sorted(glob.glob(os.path.join(base, "eval-*", "*", "run-*"))):
    if not os.path.isdir(os.path.join(run, "outputs")): continue
    f = read_outputs(run)
    exps = []
    for text, fn in CHECKS:
        try: passed, ev = fn(f)
        except Exception as e: passed, ev = False, f"check error: {e}"
        exps.append({"text": text, "passed": bool(passed), "evidence": str(ev)})
    json.dump({"expectations": exps}, open(os.path.join(run, "grading.json"), "w"), indent=2)
    n = sum(e["passed"] for e in exps)
    print(f"{os.path.relpath(run, base):45s} {n}/{len(exps)}")
