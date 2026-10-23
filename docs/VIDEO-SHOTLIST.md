# Two-minute demo video — shot list

Hard limit: **120 seconds**. Target **112 s** of content so the upload never gets cut. Record at 1440×900 or larger, cursor visible, no windowsill clutter, system sounds off.

Everything marked **[YOU]** can only be recorded by you: your voice, your screen, your machine, your Wispr card. Do not stage a fake first-person story.

| Time | Shot | What must be visible |
| --- | --- | --- |
| 0:00–0:08 | **[YOU]** Title card, spoken over | "I start every focus block by doing the same five things. This is FlowMesh, and I built it by talking to my tools." |
| 0:08–0:20 | **[YOU]** The problem, on screen: board, timer app, phone, lamp — the manual shuffle | Keep it real: your actual desktop, your actual windows. |
| 0:20–0:34 | **Wispr Flow dictating a requirement into your coding tool** | [YOU] Hold the key, speak a real requirement, show the text landing in the editor/terminal. This is the evidence the challenge is actually about — make it unmissable, and let it be a requirement this repo really implements. |
| 0:34–0:46 | **Wispr Flow dictating a follow-up** ("No — keep the lamp at forty percent, and make the phone notification say the standup is done") | Show the refinement landing, then the code or plan changing because of it. |
| 0:46–0:58 | Browser: live URL, `Browser edition · live` badge, paste the sentence with **Wispr Flow**, Create plan | The command box must be the real page, not a mockup. |
| 0:58–1:14 | Plan on screen: five actions, surfaces, parameters, `EXPIRES IN …`, single use | Read one row aloud so the reviewer hears the surface concept. |
| 1:14–1:34 | Approve & run: timer ticking, tab opens, receipts appear; point at `sent` vs `verified` vs `not_configured` | Say the honest line: "Phone and lamp aren't configured here, so they say so instead of pretending." |
| 1:34–1:44 | Run record: download in browser, and (if you have the Windows build) the `.md` file in `~/FlowMesh/runs/` with its SHA-256 | One line: "Every run leaves a record." |
| 1:44–1:52 | **Refusal**: type "delete my files" → refused with a reason; then replay/expired plan if you want a second beat | This is the trust argument; do not skip it. |
| 1:52–2:00 | **[YOU]** Close: the app's **Proof** page on screen (today's test counts, green CI, release checksums, and the "Still being measured" list), live link, repo link | "The numbers on this page come from real runs, and what I have not measured is listed too. Link's below." |

## Recording notes

- Speak the narration yourself; do not use a synthetic voice. The challenge is about your voice.
- If you show your Wispr Insights card in the video, blur anything you consider private — but keep the date range and the word count visible.
- Keep the browser window at one zoom level; the layout is responsive but a mid-video reflow looks like an edit.
- Windows build: `FlowMesh.exe` from the release ZIP. If SmartScreen appears, cut around it rather than cropping it — it is honest to show, but it costs seconds.
- Land the receipts beat. Judges remember the row that says *not configured* more than a row that says *success*.

## What must be true in the video

- The dictation is really Wispr Flow, in your environment.
- The plan really comes from the sentence you spoke.
- The receipts really appear from that run.
- Nothing you say claims a device you did not configure.

## After recording

1. Check duration ≤ 120 s (ffprobe or the player).
2. Upload unlisted/public as the form requires; keep the link alive through judging.
3. Screenshot your Wispr Insights card separately for the form field.


## Update, 23 October 2026

- **The clip on the hosted Home page is not your submission video.** `web/media/demo.mp4` (65 s) is a recording of
  the live page driven by *typed* sentences, labelled as such in a badge on screen and a caption under it. It is
  regenerated with `node scripts/record_demo.js` whenever the page changes. The 2-minute challenge video still has
  to be your voice, your Wispr Flow and your screen.
- **New beats worth adding to your own take** (all real in the build): hold your Wispr key and talk into the dock's
  capture field on the hosted page ("go to tools", "use the calculator tool", "set expression to 12 times 3");
  say "zoom in", "scroll to the receipts section" and "what can I say" (the page pilot); on the desktop app say
  "ask Codex to ..." and show a read-only council or a team-up plan.
- **Numbers to put on the closing card** (check them on the day): Python 334 tests, Node 177 tests, release 1.7.1
  or later. Read the counts off the Proof page on the day (`python scripts/build_proof.py` refreshes it).
- Do not claim Wispr audio in the recorded clip, and do not reuse it as proof of Wispr use.
