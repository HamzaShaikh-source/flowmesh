import re
import urllib.request

URLS = {
    "flowmesh (ours)": "https://flowmesh-nohands.netlify.app/",
    "receipts/jars-demo": "https://wispr.jishanahmed.in",
    "scar-tissue": "https://scar-tissue-main-ec61.vercel.app",
    "deja-vu": "https://aneek22112007-tech.github.io/deja-vu/",
    "offer-check": "https://offer-check-wispr-flow-hackathon-20.vercel.app",
    "sprintpulse": "https://sprintpulse-ai.vercel.app",
    "operation-human": "https://kavish0001.github.io/Task-Wispr-Flow/",
    "say-what-you-saw": "https://say-what-you-saw.vercel.app",
    "redline": "https://redline-pbv.vercel.app/",
    "vantage-zero": "https://vantage-zero.vercel.app",
}

FRICTION = {
    "signin": r"sign[ -]?in|log[ -]?in|create account",
    "apikey": r"api[ -]?key|enter your key|get a key",
    "upload_first": r"upload|drag|drop",
}

for name, url in URLS.items():
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read(400000).decode("utf-8", "ignore")
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        hits = {k: len(re.findall(v, html, re.I)) for k, v in FRICTION.items()}
        print(f"{name:20} {r.status} bytes={len(html):>7} text={len(text):>5} "
              f"signin={hits['signin']:<3} apikey={hits['apikey']:<3} :: {text[:110]}")
    except Exception as exc:
        print(f"{name:20} ERR {str(exc)[:70]}")
