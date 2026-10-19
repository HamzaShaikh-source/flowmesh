# FlowMesh submission preparation

**Status: not ready to submit.** The Windows app and public download are live, but the creator has not run the app yet. No personal result, Wispr usage, connected-device outcome, or video is claimed here. Do not submit this document as proof of those things.

The [official challenge page](https://www.wemakedevs.org/wispr) requires one working project link, a demo video of up to two minutes, a Wispr Insights usage-card screenshot, and a short explanation of the problem, user, and how Wispr was used. It calls for a tool addressing a problem in the entrant's own work, built with voice, and one real result it produced. Submissions close **30 October 2026 at 11:59 pm IST**.

## Project facts that can already be shared

- **Name/track:** FlowMesh / Builders.
- **Product:** A downloadable Windows app for reviewing and approving bounded focus, meeting, or research routines dictated into its command box. It requests allowlisted PC actions, optionally routes with Jev Choice, and can request Home Assistant phone notifications and light changes when configured.
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
