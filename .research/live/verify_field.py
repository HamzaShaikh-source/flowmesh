import base64
import json
import pathlib
import re
import subprocess

SCORES = json.loads(pathlib.Path(".research/live/scores.json").read_text(encoding="utf-8"))
E = {e["full"]: e for e in json.loads(pathlib.Path(".research/live/entries.json").read_text(encoding="utf-8"))}

NAME2FULL = {
    "flowmesh (ours)": "HamzaShaikh-source/flowmesh",
    "redline (sushh-05)": "sushh-05/redline",
    "say-what-you-saw (adityabrabb)": "adityabrabb/say-what-you-saw",
    "receipts (jars-demo)": "jars-demo/wispr-demo",
    "scar-tissue (j4yop)": "j4yop/scar-tissue",
    "shiplog (Ankith-m1006)": "Ankith-m1006/shiplog",
    "reviewaloud (priyansh)": "priyansh-narang2308/reviewaloud",
    "offer-check (nilesh0199)": "nilesh0199/OfferCheck-WisprFlow-Hackathon-2026",
    "debrief (Utkarsh2730)": "Utkarsh2730/debrief",
    "deja-vu (aneek)": "aneek22112007-tech/deja-vu",
    "sprintpulse (satanic47)": "satanic47/sprintpulse-ai",
    "nohandsdev (swaritn13)": "swaritn13/nohandsdev",
    "motionbrief (Fahad)": "Fahad-Dezloper/MotionBrief",
    "demoready (shivam499)": "shivam499-pro/DemoReady",
    "dictate-docs (sahilsaeid)": "sahilsaeidkhan/dictate-docs",
    "vantage-zero (Somya6422)": "Somya6422/Game-using-Wispr-Flow",
    "operation-human (Kavish)": "Kavish0001/Task-Wispr-Flow",
    "we-makedevs (Aman071Raj)": "Aman071Raj/WeMakeDevs_Project_Wispr_Flow",
}

EVENT = re.compile(r"wemakedevs|no[ -]hands|wispr challenge|16\s*[-–]\s*30\s*oct|wisprflow hackathon|hackathon-2026", re.I)


def readme(full):
    b64 = subprocess.run(["gh", "api", f"repos/{full}/readme", "--jq", ".content"],
                         capture_output=True, text=True, encoding="utf-8", errors="ignore").stdout.strip()
    if not b64:
        return ""
    try:
        return base64.b64decode(b64.replace("\n", "")).decode("utf-8", "ignore")
    except Exception:
        return ""


rows = []
for r in SCORES["rows"]:
    full = NAME2FULL[r["name"]]
    meta = E.get(full, {})
    txt = readme(full)
    hit = EVENT.search(txt)
    rows.append({
        "name": r["name"], "full": full, "mean": r["mean"], "scores": r["scores"],
        "created": meta.get("created"), "pushed": meta.get("pushed"),
        "names_event": bool(hit), "quoted": (hit.group(0) if hit else ""),
    })

print(f"{'entry':32} {'mean':>5}  {'names event':>11}  created     quote")
for r in sorted(rows, key=lambda x: -x["mean"]):
    print(f"{r['name']:32} {r['mean']:5.2f}  {str(r['names_event']):>11}  {r['created']:10}  {r['quoted'][:28]}")

named = [r for r in rows if r["names_event"]]
print(f"\n--- rank among entries that explicitly name the challenge ({len(named)}) ---")
for i, r in enumerate(sorted(named, key=lambda x: -x["mean"]), 1):
    print(f"{i:2}. {r['name']:32} {r['mean']:.2f}")

ours = [r for r in named if r["name"].startswith("flowmesh")][0]
pos = [i for i, r in enumerate(sorted(named, key=lambda x: -x["mean"]), 1) if r["name"] == ours["name"]][0]
print(f"\nours: rank {pos} of {len(named)}; mean {ours['mean']:.2f}")
print(f"with video (demo 1->5):        {(sum(ours['scores']) - 1 + 5) / 7:.2f}")
print(f"with video + build proof:      {(sum(ours['scores']) - 3 + 10) / 7:.2f}")
print(f"with video + build + judge 4:  {(sum(ours['scores']) - 3 + 10 + 1) / 7:.2f}")

json.dump({"rows": rows}, open(".research/live/scores2.json", "w"), indent=2)
