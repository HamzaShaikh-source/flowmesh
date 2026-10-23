# FlowMesh submission preparation

**Status: build complete, submission not ready.** The code, tests and docs are done and in PR #1. What is missing is the evidence only you can produce. Nothing here claims a personal result, Wispr usage, a connected-device outcome, or a video.

Deadline: **30 October 2026, 11:59 pm IST.** Solo, Builders track, one submission.

## What still needs you (nobody else can do these)

| # | Item | Why it is yours |
| --- | --- | --- |
| 1 | Dictate your instructions to your coding tools through Wispr Flow from now on | Judges rank "meaningful Wispr use" and verify words dictated with Wispr. Code written for you is not voice use. |
| 2 | Screenshot of your Wispr **Insights** usage card | It must come from your account. |
| 3 | A demo video of **at most 2 minutes**, public without a request | Must show your real dictation and a real result. See `docs/VIDEO-SHOTLIST.md`. |
| 4 | A first-person description of the problem in **your** work, who else has it, and how you used Wispr | A generic story is penalised. |
| 5 | Redeploy the hosted page (`scripts/deploy_netlify.py`) after merging PR #1 | Needs your Netlify credentials; the live link does not yet show the tools UI. |
| 6 | Click **Connect Wispr account** once with your real login and note the result in `docs/VERIFICATION.md` | The last unverified step of the sanctioned connector. |
| 7 | Connect one real MCP server (for example Files) and run one plan | The tool layer is verified against mocks only. |
| 8 | Post weekly progress; register your submission at wemakedevs.org/wispr/submit | Required by the challenge. |

## Project facts that can already be shared

- **Name/track:** FlowMesh / Builders.
- **Product:** A downloadable desktop app (Windows, macOS, Linux) and a hosted browser edition. It turns one dictated sentence into a plan of routines and MCP tool calls you approve once, with honest receipts. Older description: a Windows app for reviewing and approving bounded focus, meeting, or research routines dictated into its command box. It requests allowlisted PC actions, optionally routes with Jev Choice, and can request Home Assistant phone notifications and light changes when configured.
- **Working project:** [Product and download page](https://flowmesh-nohands-2026.exactpearl18.chatgpt.site/) · [Windows release](https://github.com/HamzaShaikh-source/flowmesh/releases/tag/v1.0.0) · [Source](https://github.com/HamzaShaikh-source/flowmesh).
- **Scope:** The public page is a download page, not a controller. The app needs Windows and WebView2. PC actions are available without external credentials; Jev and Home Assistant need the entrant's accounts and devices. Missing adapters report `not_configured`, not success. The app does not provide arbitrary mobile or appliance control.
- **Automated proof:** The repository includes tests for planning, configuration, HTTP boundaries, and adapters. Those tests do not prove that a real Wispr session, phone, or lamp worked.

## Creator-run acceptance test

1. On your Windows PC, download the release, extract the entire folder, and open `FlowMesh.exe`. If Windows displays an unsigned-publisher warning, inspect the [public source](https://github.com/HamzaShaikh-source/flowmesh) before choosing whether to run it.
2. Set the board/documentation URLs to destinations from **your** routine. Install/sign in to Wispr Flow and dictate a command into the focused FlowMesh box. Note exactly what you said.
3. Inspect the proposed actions before approval. Approve once and observe the actual browser/app/timer behavior and every receipt status. Try the same plan a second time to check one-use enforcement.
4. If you own compatible Home Assistant devices, configure and test the phone notification and light. If not, show the `not_configured` receipts and describe them accurately. Do not present a simulated light/phone effect as physical execution.
5. Try an unsupported sensitive request, such as “delete my files.” Confirm that no executable plan is produced.
6. Record a specific real-work outcome: the routine it replaced, the manual steps, what completed, what failed, and (only if measured) time saved. Use repeat trials before claiming a timing improvement.

## Evidence still needed from the entrant

- A truthful first-person explanation of the recurring problem in **your** work and who else would use the tool. A generic hypothetical developer story is insufficient.
- Evidence that you used **Wispr Flow while building**, not merely as optional text input to the finished app. Capture your real dictated prompts/spec/docs and the Insights usage card from your account. Do not manufacture a screenshot or usage count.
- A recording of the **installed app** performing the creator-run test, including the actual dictation and result. Show physical phone/light behavior only if it really occurs.
- A video link, no more than two minutes, accessible to judges without permission requests. Include the Windows download/source link for judges who can test it, and clearly acknowledge the Windows requirement for judges who cannot.

## Suggested two-minute video sequence

| Time | Show |
| --- | --- |
| 0:00–0:15 | Your real work problem and current manual routine. |
| 0:15–0:35 | Your actual Wispr Flow dictation into the installed app and the proposed plan. |
| 0:35–1:15 | Approval, visible PC action, and each honest receipt; real phone/light only if configured. |
| 1:15–1:35 | One measured or directly observed result from your work. |
| 1:35–1:50 | A rejected unsupported/sensitive command. |
| 1:50–2:00 | Public project link, source/download, and genuine Wispr Insights card. |

Do not use the competitor comparison's numerical ranking as a judge score. The [official judging criteria](https://www.wemakedevs.org/wispr/judges) are the source of truth; only the organizers can assign results.
