import json
import subprocess
import re
import pathlib
import base64

REPOS = [
    "HamzaShaikh-source/flowmesh",
    "Utkarsh2730/debrief",
    "priyansh-narang2308/reviewaloud",
    "aneek22112007-tech/deja-vu",
    "j4yop/scar-tissue",
    "Ankith-m1006/shiplog",
    "sahilsaeidkhan/dictate-docs",
    "satanic47/sprintpulse-ai",
    "shivam499-pro/DemoReady",
    "Fahad-Dezloper/MotionBrief",
    "swaritn13/nohandsdev",
    "nilesh0199/OfferCheck-WisprFlow-Hackathon-2026",
    "jars-demo/wispr-demo",
    "Somya6422/Game-using-Wispr-Flow",
    "Kavish0001/Task-Wispr-Flow",
    "adityabrabb/say-what-you-saw",
    "sushh-05/redline",
    "Aman071Raj/WeMakeDevs_Project_Wispr_Flow",
    "Prashant-thakur77/Debrief",
    "ayushagarwalhere/docs-drift",
    "awanishkumarmishra2005-eng/flowinsights",
]

SIG = {
    "flowsqlite": r"flow\.sqlite",
    "wispr_mcp": r"connect/mcp|api\.wisprflow\.ai|search_scratchpad_notes|get_scratchpad_note|Wispr Flow MCP",
    "wispr_api": r"wispr[ _-]?(api|sdk)|WISPR_API|api\.wisprflow",
    "db_read": r"sqlite3|DatabaseSync|better-sqlite3",
    "electron": r"electron",
    "tauri": r"tauri",
    "next": r"next\.js|nextjs|app/page\.tsx",
    "python": r"fastapi|flask|\.py\b",
    "tests": r"pytest|vitest|jest|unittest|npm test|\.test\.[jt]s",
    "video": r"youtube\.com|youtu\.be|loom\.com|vimeo",
    "hosted": r"vercel\.app|netlify\.app|lovable\.app|streamlit\.app|onrender\.com|railway\.app",
    "approval": r"approv|confirm|consent",
    "receipt": r"receipt|audit log|verif",
    "wemakedevs": r"wemakedevs",
    "no_hands": r"no[ -]hands",
    "license": r"MIT|Apache|GPL",
}


def gh(args):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    return r.stdout if r.returncode == 0 else ""


out = []
for full in REPOS:
    meta = {}
    raw = gh(["api", f"repos/{full}"])
    try:
        meta = json.loads(raw) if raw.strip() else {}
    except Exception:
        meta = {}
    if not meta or "full_name" not in meta:
        out.append({"full": full, "error": "not found"})
        print(f"{full:48} NOT FOUND")
        continue

    readme = ""
    b64 = gh(["api", f"repos/{full}/readme", "--jq", ".content"])
    if b64.strip():
        try:
            readme = base64.b64decode(b64.strip().replace("\n", "")).decode("utf-8", "ignore")
        except Exception:
            readme = ""

    tree = gh(["api", f"repos/{full}/git/trees/{meta.get('default_branch','main')}?recursive=1"])
    files, blobs, has_test_dir = [], 0, False
    try:
        t = json.loads(tree) if tree.strip() else {}
        for e in t.get("tree", []):
            if e.get("type") != "blob":
                continue
            p = e["path"]
            if p.startswith(".git/") or "/node_modules/" in p:
                continue
            files.append(p)
            blobs += e.get("size", 0)
            if re.search(r"(^|/)(tests?|__tests__|spec)/", p):
                has_test_dir = True
    except Exception:
        t = {}

    blob = (readme + "\n" + " ".join(files)).lower()
    hits = {k: bool(re.search(v, blob, re.I)) for k, v in SIG.items()}
    entry = {
        "full": full,
        "stars": meta.get("stargazers_count"),
        "lang": meta.get("language"),
        "size_kb": meta.get("size"),
        "license": (meta.get("license") or {}).get("spdx_id"),
        "homepage": meta.get("homepage"),
        "pushed": (meta.get("pushed_at") or "")[:10],
        "created": (meta.get("created_at") or "")[:10],
        "files": len(files),
        "blob_kb": round(blobs / 1024),
        "readme_chars": len(readme),
        "has_test_dir": has_test_dir,
        "signals": hits,
    }
    out.append(entry)
    sig = ",".join(k for k, v in hits.items() if v)
    print(f"{full:48} st={entry['stars']:<3} {str(entry['lang']):11} {entry['blob_kb']:>6}KB "
          f"f={entry['files']:<5} {entry['license']} | {sig}")

pathlib.Path(".research/live/entries.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
print("\nwrote entries:", len(out))
