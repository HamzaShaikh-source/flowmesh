import json

# Axes follow the organisers' four published questions plus two things the sample
# submission makes explicit. Equal weight is MY construct, not the judges'.
AXES = [
    "problem",       # Q1: real problem in your own work
    "wispr_product", # Q2a: Wispr inside the product
    "wispr_build",   # Q2b: the twist - voice used to BUILD it
    "judge_access",  # Q3: can a judge open and use it in a minute
    "demo",          # Q4: is the demo clear (video present)
    "engineering",   # shipped depth: tests, CI, artifacts, docs
    "trust",         # does it gate/verify actions instead of claiming success
]

S = {
 "flowmesh (ours)":            [(5,"repeated manual steps in own work; real dictations"),
                                (5,"only entry that reads Wispr's own flow.sqlite, read-only"),
                                (2,"repo shows product use; build-process voice not evidenced"),
                                (3,"console opens free; flagship needs portable exe + Wispr installed"),
                                (1,"no video yet"), (5,"84 py + 41 node tests, 7/7 CI, 4 CI artifacts"),
                                (5,"bounded plan, approval, one-use, receipts, not_configured")],
 "redline (sushh-05)":         [(4,"agent-spend policy testing"), (2,"voice input only"), (4,"README states build proof + video"),
                                (4,"hosted, deterministic demo"), (5,"video linked"), (4,"43 files, tests"),
                                (5,"simulator, no money moved, states limits")],
 "say-what-you-saw (adityabrabb)": [(3,"creative film gen, not a work problem per se"), (2,"voice input only"),
                                (5,"'never typed a line' + build timelapse"), (3,"hosted, JS/SPA"),
                                (5,"two videos"), (3,"131 files"), (2,"no action model")],
 "receipts (jars-demo)":       [(5,"verifying agent work, clearly personal"), (2,"voice as form input"), (3,"solo build, voice mentioned"),
                                (4,"hosted; sign-in mentions"), (1,"no video in README"), (4,"147 files, MIT, tests"),
                                (5,"Found/Partly/Missing/Off-limits/Can't tell")],
 "scar-tissue (j4yop)":        [(5,"agent repeats mistakes - personal"), (2,"voice capture into cards"), (2,"not evidenced"),
                                (4,"hosted 200"), (1,"none"), (4,"66 files, MIT, tests"), (3,"feeds memory to agents, no gating")],
 "shiplog (Ankith-m1006)":     [(5,"own tracker across 10 hackathons"), (2,"voice input"), (5,"every prompt/commit dictated"),
                                (1,"no hosted link"), (1,"none"), (3,"21 files, tests"), (3,"extracts tasks, no execution")],
 "reviewaloud (priyansh)":     [(5,"PR review follow-up"), (2,"voice-first reviews"), (3,"claimed"),
                                (1,"'in development', needs .env + keys"), (1,"none"), (4,"153 files, tests, TASKS.md"),
                                (4,"evidence-backed verification")],
 "offer-check (nilesh0199)":   [(4,"student job offers"), (1,"no meaningful integration"), (2,"not evidenced"),
                                (5,"no sign-in, sample data"), (1,"none"), (3,"147 files, tests"), (3,"advisory only")],
 "debrief (Utkarsh2730)":      [(4,"sales call notes"), (2,"dictate recap"), (2,"not evidenced"),
                                (2,"10.8MB HTML, no clear hosted URL"), (1,"none"), (2,"39 files"), (4,"voice correction + citations")],
 "deja-vu (aneek)":            [(5,"re-debugging solved bugs"), (2,"voice capture"), (2,"not evidenced"),
                                (3,"gh-pages, JS required"), (1,"none"), (3,"76 files"), (2,"no action model")],
 "sprintpulse (satanic47)":    [(3,"status updates"), (2,"voice input"), (4,"'built 100% by voice'"),
                                (3,"two different live URLs"), (1,"none"), (3,"46 files"), (2,"summarises only")],
 "nohandsdev (swaritn13)":     [(4,"PRD/issue writing"), (2,"voice input"), (2,"not evidenced"),
                                (2,"no hosted link found"), (1,"none"), (2,"22 files"), (2,"no action model")],
 "motionbrief (Fahad)":        [(4,"explaining motion to agents"), (2,"voice capture"), (2,"not evidenced"),
                                (2,"no hosted link"), (1,"none"), (2,"62 files"), (2,"no action model")],
 "demoready (shivam499)":      [(4,"pre-demo checks"), (2,"voice input"), (2,"not evidenced"),
                                (2,"CLI, no hosted"), (1,"none"), (3,"28 files, tests"), (4,"read-only inspection, no leaks")],
 "dictate-docs (sahilsaeid)":  [(4,"commit messages/docs"), (2,"voice input"), (2,"not evidenced"),
                                (1,"no link"), (1,"none"), (2,"27 files"), (2,"text generation only")],
 "vantage-zero (Somya6422)":   [(2,"game, not a work problem"), (2,"voice commands in game"), (3,"built for event"),
                                (4,"playable in browser"), (1,"none"), (3,"88 files"), (1,"no trust model needed")],
 "operation-human (Kavish)":   [(2,"training sim"), (2,"voice"), (2,"not evidenced"),
                                (4,"gh-pages playable"), (1,"none"), (2,"33 files"), (1,"no action model")],
 "we-makedevs (Aman071Raj)":   [(1,"empty repo"), (1,"nothing"), (1,"nothing"), (1,"nothing"), (1,"nothing"), (1,"0 files"), (1,"nothing")],
}

rows = []
for name, per in S.items():
    scores = [p[0] for p in per]
    assert len(scores) == len(AXES), name
    rows.append((name, sum(scores) / len(scores), scores))

rows.sort(key=lambda r: -r[1])
print(f"{'entry':32} mean  " + " ".join(a[:6] for a in AXES))
for name, mean, sc in rows:
    print(f"{name:32} {mean:4.2f}  " + " ".join(f"{s:>6}" for s in sc))

ours = [r for r in rows if r[0].startswith("flowmesh")][0]
rank = [i for i, r in enumerate(rows, 1) if r[0] == ours[0]][0]
print(f"\nours rank {rank} of {len(rows)} at {ours[1]:.2f}")
print(f"ours if demo made: {(sum(ours[2]) - 1 + 5) / len(AXES):.2f}")
print(f"ours if demo + build proof: {(sum(ours[2]) - 1 - 2 + 5 + 5) / len(AXES):.2f}")

json.dump({"axes": AXES, "rows": [{"name": n, "mean": round(m, 2), "scores": s} for n, m, s in rows]},
          open(".research/live/scores.json", "w"), indent=2)
print("wrote .research/live/scores.json")
