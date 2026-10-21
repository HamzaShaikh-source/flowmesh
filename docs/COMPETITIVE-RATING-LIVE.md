# Live field check — how FlowMesh compares to the repos actually entered

Written 21 Oct 2026, against GitHub as it stood that day. Everything below is measured
by the scripts in `.research/live/` (`analyze_entries.py`, `digest.py`, `friction.py`,
`score.py`, `verify_field.py`), not recalled.

## What I could see, and what I could not

- The challenge page (`wemakedevs.org/wispr`) publishes **no gallery or submission list** —
  I checked: 229 KB of page, zero GitHub links, zero gallery section. So there is no
  official roster to score against.
- I found candidates through GitHub search on event-specific strings (`wemakedevs`,
  `"no hands"`, `"wispr flow" hackathon`, `wemakedevs+wispr in:readme`), then **verified**
  each one by re-reading its README for an explicit event reference.
- Result: **18 repos** found, **13** that explicitly name the challenge, **5** that do not.
- This is a **sample, not the field**. The page's own sample submission is a Lovable app
  with no public repo, so part of the real competition is invisible to GitHub search by
  construction. Any rank below is "of 13 discoverable", never "of everyone".

## The axes

Seven axes, **equal weight** — that weighting is mine, not the organisers'. The public
page still renders `0%` next to the criteria, so no official weights exist to copy.
Axes 1–2 are the judges' published questions; 3–5 make the page's sample-submission bar
explicit; 6–7 are what actually decides whether a judge can trust a result.

| # | Axis | Question |
| --- | --- | --- |
| 1 | problem | Is it a real problem in the builder's own work? |
| 2 | wispr_product | Is Wispr meaningfully inside the product? |
| 3 | wispr_build | The twist: was voice used to *build* it? |
| 4 | judge_access | Can a judge open and use it in about a minute? |
| 5 | demo | Is there a clear ≤2 min demo? |
| 6 | engineering | Tests, CI, artifacts, docs — shipped, not promised. |
| 7 | trust | Does it gate/verify actions rather than claim success? |

## Ranked: the 13 that name the challenge

| # | Entry | Mean | prob | prod | build | access | demo | eng | trust |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | **flowmesh (ours)** | **3.71** | 5 | **5** | 2 | 3 | **1** | 5 | 5 |
| 2 | receipts / `jars-demo/wispr-demo` | 3.43 | 5 | 2 | 3 | 4 | 1 | 4 | 5 |
| 3 | scar-tissue / `j4yop/scar-tissue` | 3.00 | 5 | 2 | 2 | 4 | 1 | 4 | 3 |
| 4 | shiplog / `Ankith-m1006/shiplog` | 2.86 | 5 | 2 | **5** | 1 | 1 | 3 | 3 |
| 5 | reviewaloud / `priyansh-narang2308` | 2.86 | 5 | 2 | 3 | 1 | 1 | 4 | 4 |
| 6 | offer-check / `nilesh0199` | 2.71 | 4 | 1 | 2 | **5** | 1 | 3 | 3 |
| 7 | deja-vu / `aneek22112007-tech` | 2.57 | 5 | 2 | 2 | 3 | 1 | 3 | 2 |
| 8 | sprintpulse / `satanic47` | 2.57 | 3 | 2 | 4 | 3 | 1 | 3 | 2 |
| 9 | demoready / `shivam499-pro` | 2.57 | 4 | 2 | 2 | 2 | 1 | 3 | 4 |
| 10 | debrief / `Utkarsh2730` | 2.43 | 4 | 2 | 2 | 2 | 1 | 2 | 4 |
| 11 | nohandsdev / `swaritn13` | 2.14 | 4 | 2 | 2 | 2 | 1 | 2 | 2 |
| 12 | motionbrief / `Fahad-Dezloper` | 2.14 | 4 | 2 | 2 | 2 | 1 | 2 | 2 |
| 13 | dictate-docs / `sahilsaeidkhan` | 2.00 | 4 | 2 | 2 | 1 | 1 | 2 | 2 |

## Not counted, because they do not name the event

| Entry | Mean | Created | Why excluded |
| --- | --- | --- | --- |
| `sushh-05/redline` | 4.00 | 2026-10-04 | Would rank 1st. Created **12 days before the challenge opened**; says "built with Wispr Flow" but never names WeMakeDevs or No Hands. |
| `adityabrabb/say-what-you-saw` | 3.29 | 2026-10-07 | Pre-dates the 16 Oct start; no event reference. Strongest build-process proof of anyone (two videos, "never typed a line"). |
| `Somya6422/Game-using-Wispr-Flow` | 2.29 | 2026-10-05 | Playable Three.js game, but no event reference and no work problem. |
| `Kavish0001/Task-Wispr-Flow` | 2.00 | 2026-10-10 | Security training sim; no event reference. |
| `Aman071Raj/WeMakeDevs_Project_Wispr_Flow` | 1.00 | 2026-10-21 | Named for the event, but **0 files** and a binary-garbage README. Empty repo. |

**If those two pre-existing projects are in fact entries, we are 2nd, not 1st.** I will not
pretend to know which it is; a submission form could accept a project whose repo predates
the event.

## Why we lead the named field

One number in that table does all the work: **wispr_product = 5, and nobody else is above 2.**

- **No rival reads Wispr's data.** I searched every repo's README and full file list for
  `flow.sqlite`, `sqlite3`, `better-sqlite3`, `DatabaseSync`, Wispr API/SDK strings. Zero
  hits outside our repo. Every other entry uses Wispr as *the keyboard* — you dictate into
  a form. We are the only submission where the product knows what you actually dictated,
  which app it landed in, how stale it is, and refuses to act when it is older than 300 s.
- That is visible in the UI as provenance (`last dictated into chrome · 8s ago · read-only`)
  and it is the thing a judge cannot get from any competitor.

## Why the lead is fragile

Our two `1` and `2` scores are the cheapest points in the table for anyone else to take:

1. **demo = 1.** We have no video. Only 2 of the 18 repos had one, so this is normal for
   the field — but it is the judges' fourth question, and it is currently blank for us.
2. **wispr_build = 2.** The challenge's twist is that voice must build the thing. `shiplog`
   and `say-what-you-saw` state this bluntly ("every prompt, spec note and commit message
   dictated"). Our repo proves the *product* uses Wispr; it does not yet prove the *build* did.
3. **judge_access = 3.** Nine of the eighteen repos serve a hosted app (Vercel or GitHub
   Pages), and every one returned `200` to a direct fetch. Our flagship needs a 103 MB portable `.exe` **and** Wispr Flow
   installed and recently used. Our web console opens instantly, but the integration that
   makes us #1 is exactly the part a judge cannot touch in a minute.

## The arithmetic of taking it outright

Same rubric, same field, only our row changes:

| Action | Mean | Position |
| --- | --- | --- |
| Today | 3.71 | 1st of 13 named (2nd if `redline` counts) |
| Record the 2-min video (demo 1→5) | **4.29** | 1st either way |
| + document build-process voice use (build 2→5) | **4.71** | clear 1st |
| + make the browser console show a labelled sample pull (access 3→4) | **4.86** | clear 1st |

The first two are yours to produce and cost an evening. The third is a small, honest UI
change: a sample transcript marked `SAMPLE` that replays the pull → plan → approve →
receipt flow in the browser, so a judge sees the whole product before downloading
anything. It must stay labelled as a sample — a fake "connected" badge would undo the one
thing that separates this entry from the field.

## Reproduce

```bash
python .research/live/analyze_entries.py   # metadata, file trees, signal detection
python .research/live/digest.py            # README claims + HTTP check of every live link
python .research/live/friction.py          # sign-in / API-key friction on first screen
python .research/live/score.py             # scores, means, ranking
python .research/live/verify_field.py      # event-relevance verification + re-rank
```
