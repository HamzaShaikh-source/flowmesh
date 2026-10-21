"""Measure the shipped code surface of the field's top entries vs FlowMesh.

Counts tracked source only: no node_modules, no build output, no lockfiles, no
generated assets. Tests are counted separately because a test count is not a
quality measure - it is only comparable within the same language conventions.
"""
import os
import re
import json

SKIP = {".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage",
        ".venv", "venv", "__pycache__", ".research", "release", "out", ".data",
        "vendor", "site-packages", ".cache"}

LOC_EXT = {
    ".py": "py", ".js": "js", ".mjs": "js", ".cjs": "js",
    ".ts": "ts", ".tsx": "ts", ".jsx": "js",
    ".css": "css", ".html": "html", ".sh": "sh", ".ps1": "sh",
    ".go": "go", ".rs": "rs", ".sql": "sql",
}
TEST_HINT = re.compile(r"(^|/)(tests?|__tests__)/|(^test_|_test\.|\.test\.|\.spec\.)", re.I)
CASE = re.compile(r"^\s*(def test_|it\(|test\(|test\.case\(|describe\()", re.M)

REPOS = {
    "flowmesh (ours)": r"D:\projects\flowmesh-handsfree",
    "debrief (Prashant)": r".research/live/clones/Prashant-thakur77_Debrief",
    "docs-drift": r".research/live/clones/ayushagarwalhere_docs-drift",
    "receipts": r".research/live/clones/jars-demo_wispr-demo",
    "scar-tissue": r".research/live/clones/j4yop_scar-tissue",
}


def measure(root):
    ext_loc = {}
    files = 0
    tests = 0
    cases = 0
    workflows = 0
    docs = 0
    top_dirs = set()
    if not os.path.isdir(root):
        return None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".next")]
        rel = os.path.relpath(dirpath, root)
        if rel != ".":
            top_dirs.add(rel.split(os.sep)[0])
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            path = os.path.join(dirpath, fn)
            relp = os.path.relpath(path, root).replace("\\", "/")
            if fn.endswith((".lock", "-lock.json", "pnpm-lock.yaml", "package-lock.json")):
                continue
            if fn.lower().startswith("license") or fn.lower().startswith("notice"):
                continue
            if "/.github/workflows/" in "/" + relp:
                workflows += 1
                continue
            if ext == ".md":
                docs += 1
                continue
            if ext not in LOC_EXT:
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
            except OSError:
                continue
            lang = LOC_EXT[ext]
            n = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
            # minified or generated single-line blobs are not authored surface
            if n <= 2 and len(text) > 4000:
                continue
            ext_loc[lang] = ext_loc.get(lang, 0) + n
            files += 1
            if TEST_HINT.search(relp):
                tests += 1
                cases += len(CASE.findall(text))
    return {
        "files": files,
        "loc": sum(ext_loc.values()),
        "by_lang": dict(sorted(ext_loc.items(), key=lambda kv: -kv[1])),
        "test_files": tests,
        "test_cases": cases,
        "workflows": workflows,
        "docs": docs,
        "top_dirs": len([d for d in top_dirs if not d.startswith(".")]),
    }


out = {}
for name, path in REPOS.items():
    m = measure(path)
    out[name] = m
    if m is None:
        print(f"{name:22} MISSING")
        continue
    langs = " ".join(f"{k}:{v}" for k, v in list(m["by_lang"].items())[:4])
    print(f"{name:22} loc={m['loc']:6}  files={m['files']:4}  "
          f"tests={m['test_files']:3} cases~{m['test_cases']:4}  "
          f"ci={m['workflows']}  docs={m['docs']:3}  topdirs={m['top_dirs']:2}  | {langs}")

with open(".research/live/code_surface.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1)
