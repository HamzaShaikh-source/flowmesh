import json
import pathlib
import re
import subprocess
import base64
import urllib.request

E = json.loads(pathlib.Path(".research/live/entries.json").read_text(encoding="utf-8"))


def readme(full):
    b64 = subprocess.run(
        ["gh", "api", f"repos/{full}/readme", "--jq", ".content"],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
    ).stdout.strip()
    if not b64:
        return ""
    try:
        return base64.b64decode(b64.replace("\n", "")).decode("utf-8", "ignore")
    except Exception:
        return ""


def http(url, timeout=12):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 flowmesh-check"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(200000).decode("utf-8", "ignore")
            title = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
            return r.status, (title.group(1).strip()[:60] if title else ""), len(body)
    except Exception as exc:
        code = getattr(exc, "code", None)
        return (code or "ERR"), str(exc)[:40], 0


report = []
for e in E:
    full = e["full"]
    if full.startswith("HamzaShaikh"):
        continue
    r = readme(full)
    head = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", r)
    head = re.sub(r"<[^>]+>", " ", head)
    head = re.sub(r"[#*`>|]", "", head)
    head = re.sub(r"\s+", " ", head).strip()
    urls = sorted(set(re.findall(r"https?://[^\s\)\]\"']+", r)))
    live = [u for u in urls if re.search(r"vercel\.app|netlify\.app|lovable\.app|streamlit\.app|onrender|railway\.app|\.dev\b|\.app\b|\.io\b|\.com", u)
            and not re.search(r"github|shields\.io|img\.shields|badge|license|nodejs|python\.org|npmjs|pypi|docs\.", u)]
    vid = [u for u in urls if re.search(r"youtube|youtu\.be|loom\.com|vimeo", u)]
    print("=" * 100)
    print(f"{full}  | stars={e['stars']} lang={e['lang']} {e['blob_kb']}KB files={e['files']} lic={e['license']} pushed={e['pushed']}")
    print(f"  homepage: {e['homepage'] or '-'}")
    print(f"  video:    {vid[:2] or '-'}")
    print(f"  live-url: {live[:3] or '-'}")
    print(f"  says:     {head[:520]}")
    report.append({"full": full, "live": live[:3], "video": vid[:2], "homepage": e["homepage"]})

print("\n\n===== HTTP CHECK OF LIVE LINKS =====")
for r in report:
    for u in ([r["homepage"]] if r["homepage"] else []) + r["live"]:
        if not u:
            continue
        code, title, n = http(u if u.startswith("http") else "https://" + u)
        print(f"  {code}  {u[:70]:70}  {title}")
