# Live field check — how FlowMesh compares to the repos actually entered

Written 21 Oct 2026, revised the same day after an external read of the field. Everything
below is measured by the scripts in `.research/live/` (`analyze_entries.py`, `digest.py`,
`friction.py`, `score.py`, `verify_field.py`), not recalled.

**This revision retracts a claim from the first version.** See "The claim I got wrong".

## What I could see, and what I could not

- The challenge page (`wemakedevs.org/wispr`) publishes **no gallery or submission list** —
  229 KB of page, zero GitHub links, zero gallery section. There is no official roster.
- Candidates came from GitHub search on event-specific strings (`wemakedevs`,
  `"no hands"`, `"wispr flow" hackathon`, `wemakedevs+wispr in:readme`), then **verified**
  by re-reading each README for an explicit event reference.
- Result: **21 repos scanned, 16 that explicitly name the challenge, 5 that do not.**
- This is a **sample, not the field**. The page's own sample submission is a Lovable app
  with no public repo, so part of the real competition is invisible to GitHub search by
  construction. Any rank below is "of 16 discoverable", never "of everyone".
- **A page returning `200` is not an end-to-end test.** I reviewed repositories,
  documentation, CI and first-screen responses. I did not complete any rival's user journey.

## The axes

Seven axes, **equal weight** — that weighting is mine, not the organisers'. The public page
still renders `0%` next to the criteria, so no official weights exist to copy. Axes 1–2 are
the judges' published questions; 3–5 make the page's sample-submission bar explicit; 6–7 are
what decides whether a judge can trust a result.

This rubric **over-credits engineering and product depth relative to the mandatory
submission artifacts.** The organisers require a working link, a ≤2 min video, a genuine
Insights usage card and evidence of voice-in-the-build. Missing any of those is not a lost
point or two; the entry is incomplete. Read the table as a build-quality measure, and the
readiness ledger below as the thing that actually decides placement.

| # | Axis | Question |
| --- | --- | --- |
| 1 | problem | Is it a real problem in the builder's own work? |
| 2 | wispr_product | Is Wispr meaningfully inside the product? |
| 3 | wispr_build | The twist: was voice used to *build* it? |
| 4 | judge_access | Can a judge open and use it in about a minute? |
| 5 | demo | Is there a clear ≤2 min demo? |
| 6 | engineering | Tests, CI, artifacts, docs — shipped, not promised. |
| 7 | trust | Does it gate/verify actions rather than claim success? |

## Ranked: the 16 that name the challenge

| # | Entry | Mean | prob | prod | build | access | demo | eng | trust |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | debrief / `Prashant-thakur77` | **4.00** | 5 | 4 | 3 | **5** | 1 | 5 | 5 |
| **2** | **flowmesh (ours)** | **3.71** | 5 | **5** | 2 | 3 | **1** | 5 | 5 |
| 3 | receipts / `jars-demo/wispr-demo` | 3.43 | 5 | 2 | 3 | 4 | 1 | 4 | 5 |
| 4 | scar-tissue / `j4yop/scar-tissue` | 3.14 | 5 | 3 | 2 | 4 | 1 | 4 | 3 |
| 5 | shiplog / `Ankith-m1006/shiplog` | 2.86 | 5 | 2 | **5** | 1 | 1 | 3 | 3 |
| 6 | reviewaloud / `priyansh-narang2308` | 2.86 | 5 | 2 | 3 | 1 | 1 | 4 | 4 |
| 7 | docs-drift / `ayushagarwalhere` | 2.86 | 4 | 1 | 2 | 2 | 1 | 5 | 5 |
| 8 | offer-check / `nilesh0199` | 2.71 | 4 | 1 | 2 | **5** | 1 | 3 | 3 |
| 9 | deja-vu / `aneek22112007-tech` | 2.57 | 5 | 2 | 2 | 3 | 1 | 3 | 2 |
| 10 | sprintpulse / `satanic47` | 2.57 | 3 | 2 | 4 | 3 | 1 | 3 | 2 |
| 11 | demoready / `shivam499-pro` | 2.57 | 4 | 2 | 2 | 2 | 1 | 3 | 4 |
| 12 | debrief / `Utkarsh2730` | 2.43 | 4 | 2 | 2 | 2 | 1 | 2 | 4 |
| 13 | nohandsdev / `swaritn13` | 2.14 | 4 | 2 | 2 | 2 | 1 | 2 | 2 |
| 14 | motionbrief / `Fahad-Dezloper` | 2.14 | 4 | 2 | 2 | 2 | 1 | 2 | 2 |
| 15 | dictate-docs / `sahilsaeidkhan` | 2.00 | 4 | 2 | 2 | 1 | 1 | 2 | 2 |
| 16 | flowinsights / `awanishkumarmishra` | 1.86 | 4 | 1 | 2 | 1 | 1 | 2 | 2 |

## Not counted, because they do not name the event

| Entry | Mean | Created | Why excluded |
| --- | --- | --- | --- |
| `sushh-05/redline` | 4.00 | 2026-10-04 | Would tie 1st. Created **12 days before the challenge opened**; says "built with Wispr Flow", has a build video, never names WeMakeDevs or No Hands. |
| `adityabrabb/say-what-you-saw` | 3.29 | 2026-10-07 | Pre-dates the 16 Oct start; names Hacker House Goa, not this event. Strongest build-process proof of anyone (two videos, "never typed a line"). |
| `Somya6422/Game-using-Wispr-Flow` | 2.29 | 2026-10-05 | Playable Three.js game; no event reference and no work problem. |
| `Kavish0001/Task-Wispr-Flow` | 2.00 | 2026-10-10 | Security training sim; no event reference. |
| `Aman071Raj/WeMakeDevs_Project_Wispr_Flow` | 1.00 | 2026-10-21 | Named for the event, but **0 files** and a binary-garbage README. Empty repo. |

Excluding the first two solely because their READMEs omit the event name is unsafe — a
submission form can accept a repo that predates the event. **If either is entered, we are
3rd, not 2nd.** I cannot know which it is, so no rank here should be read as settled.

## The claim I got wrong

The first version of this document said:

> **No rival reads Wispr's data.** I searched every repo's README and full file list for
> `flow.sqlite`, `sqlite3`, `better-sqlite3`, `DatabaseSync`, Wispr API/SDK strings. Zero
> hits outside our repo. Every other entry uses Wispr as *the keyboard*.

**That is false, and the method that produced it was broken.**

1. **Wispr Flow ships an official remote MCP server.** Verified live, not from a README:
   `https://api.wisprflow.ai/.well-known/oauth-protected-resource` returns `200` with
   `{"resource":"https://api.wisprflow.ai/connect/mcp","authorization_servers":["https://mcp-auth.wisprflow.com"],"scopes_supported":["openid","offline_access"]}`,
   and `POST https://api.wisprflow.ai/connect/mcp` returns `401` without a bearer token.
2. **Two rivals integrate through it.** `Prashant-thakur77/Debrief` carries
   `packages/core/src/wispr/mcp.ts`, `packages/core/src/wispr/oauth.ts` and
   `apps/web/app/api/wispr/import/route.ts`; it calls `search_scratchpad_notes` and
   `get_scratchpad_note` to pull the developer's Scratchpad devlog and latest Notetaker
   summary. `j4yop/scar-tissue` carries `web/src/lib/wispr.ts`,
   `web/src/app/api/wispr/notes/route.ts` and `web/src/app/api/wispr/import/route.ts`
   doing the same via `listScratchpadNotes()` / `getScratchpadNote()`.
3. **My detector did not detect our own repo either.** Re-running it prints
   `flowsqlite: false, db_read: false` **for flowmesh itself**, because it only scans the
   README text and file listing, and our README never writes the literal `flow.sqlite`.
   A detector that fails to find the thing in the repo built around the thing proves
   nothing about the repos it found nothing in.

The accurate statement, and it is narrower:

> Two surfaces exist. **Scratchpad notes** are reachable through Wispr's supported MCP with
> OAuth — two rivals use that. **The dictated log** (`flow.sqlite`: transcripts, latency,
> target app, dictionary) has no supported interface; only FlowMesh reads it, read-only,
> `?mode=ro`, over an allow-list of metadata columns.

So FlowMesh has the **broader** Wispr data surface and the **less sanctioned** one. For a
criterion that asks whether Wispr was used "meaningfully", an OAuth integration with the
vendor's own MCP is the stronger evidence, and mine is the one a judge could reasonably ask
"is this supported?" about. That is a real weakness in the standout feature, not a detail.

## Code surface, measured

Not an opinion — `code_surface.py` walks each clone and counts authored source
(no `node_modules`, no build output, no lockfiles, no minified blobs).

| Entry | LOC | files | test files | test cases | CI workflows | docs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| debrief (Prashant) | **67,269** | 705 | 165 | **~1,664** | 3 | 10 |
| docs-drift | 19,398 | 163 | 39 | ~286 | **6** | **70** |
| receipts | 10,197 | 124 | 19 | ~142 | 1 | 11 |
| **flowmesh (ours)** | **8,027** | **40** | 16 | **~125** | 1 | 19 |
| scar-tissue | 2,418 | 28 | 0 | 0 | 0 | 24 |

Our counted 125 reconciles exactly with the real runners (84 Python + 41 Node), which is
the only reason to trust the other columns.

Two honest caveats: LOC is not quality, and it is not even like-for-like — a Next.js app
carries framework boilerplate that a stdlib-only Python runtime does not, so 67k TypeScript
is not eight times the product. And a test-file count says nothing about what the tests
assert.

**What this table settles: we are not #1 on code.** We are 4th of these five by volume, with
the smallest suite of anyone who has one. Where we are genuinely first is narrower and
measurable: **platform breadth of shipped artifacts** — a Windows portable exe, an Apple
silicon dmg, a Linux AppImage and a Python zip, all built by CI from one commit, over one
planner pinned by a shared golden file. No other entry in the field ships a runnable binary
for three platforms — checked against the GitHub releases API across all 21 repos: ours has
10 assets, every other entry has 0. Add the dictated-log connector and that is the whole of
our lead — on code volume we are not first, and we should stop implying otherwise.



## What is actually distinctive, and what is not

Still ours alone, and still worth the submission:

- Reading the **dictated log** rather than Scratchpad notes: which app each dictation landed
  in, how stale it is, the dictionary, and a 300 s freshness gate on acting.
- The refusal design: bounded plan, one approval, one-use actions, `not_configured` instead
  of fake success, `sent` never rendered as `verified`.
- Three runtimes over one planner, pinned by a shared golden file so a planner drift fails CI.
- Ships signed-by-nobody but real binaries for Windows, macOS and Linux from the same commit.

Not ours, contrary to the first draft: "everyone else only uses Wispr as a keyboard".

## The requirement ledger

The judges' four questions are: a real problem, Wispr used meaningfully, a live link they
can open, and a clear two-minute demo. The submission also needs an Insights usage card and
honest build-process evidence.

| Requirement | State | Note |
| --- | --- | --- |
| Working link a judge can open | **yes** | `flowmesh-nohands.netlify.app`, no sign-in, sample text preloaded |
| Distinctive connector visible to a judge | **no** | the hosted page cannot touch the filesystem; the flagship needs a 103 MB exe **and** Wispr installed |
| Demo video ≤2 min | **no** | script written (`docs/DEMO-SCRIPT.md`), nothing recorded |
| Genuine Insights usage card | **no** | must come from the owner's account |
| Evidence voice was used to build it | **no** | repo proves the product uses Wispr, not the build |
| Personally run end to end | **no** | never launched by the owner on his own machine |
| Tests / CI / artifacts | **yes** | 84 Python + 41 Node, 7/7 CI, four CI-built release assets |

Three of the top four requirements are empty. **That is why I do not call this the current
#1 submission**, and why an honest reading puts it **~3rd–5th on readiness today** even
though its engineering and its connector are, as far as I can measure, ahead of the field.

## The arithmetic

Same rubric, same field, only our row changes:

| Action | Mean | Position among 16 named |
| --- | --- | --- |
| Today | 3.71 | 2nd (3rd if `redline` is entered) |
| Record the 2-min demo (demo 1→5) | **4.29** | 1st |
| + evidence of voice in the build (build 2→5) | **4.71** | 1st, clear |
| + judge-reachable connector (access 3→4) | **4.86** | 1st, clear |

The first two are the owner's to produce and cost an evening. The third is an honest UI
change — a transcript marked `SAMPLE` replaying pull → plan → approve → receipt in the
browser — and it must stay labelled. A fake "connected" badge would cost more than it buys.

The fourth is not a rubric point but the real decision: the only way `wispr_build` becomes
true is for the owner to build one thing by voice and keep the recording.

## Reproduce

```bash
python .research/live/analyze_entries.py   # metadata, file trees, signal detection (21 repos)
python .research/live/digest.py            # README claims + HTTP check of every live link
python .research/live/friction.py          # sign-in / API-key friction on first screen
python .research/live/score.py             # scores, means, ranking
python .research/live/verify_field.py      # event-relevance verification + re-rank
```

`score.py` prints its own rank line, so the table above can be checked rather than trusted.
