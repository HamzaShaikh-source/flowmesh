# 2-minute demo — shot list

Hard limit: 2:00. Every shot below is something the build actually does. Record on a
machine with **Wispr Flow installed and used at least once today** — that is the point
of the whole demo, and there is no way to fake it.

Total: 120 s. Rehearse the pull once before recording; the freshness window is 5
minutes, so dictate immediately before you hit record.

| Time | Shot | On screen | Say |
| --- | --- | --- | --- |
| 0:00–0:12 | Cold open on the live link | `flowmesh-nohands.netlify.app`, badge "Browser edition · live" | "This is the browser edition. It is real, but it cannot touch your machine — so the panel marked desktop only is honest about that." |
| 0:12–0:25 | Cut to the **desktop app** (Electron or Python build) | Wispr panel, badge **connected**, "9 dictations · 7 words · median 1152 ms" | "The desktop build reads my own Wispr Flow history. Read-only. Nine dictations on this machine." |
| 0:25–0:45 | **Hold the Wispr key and speak** — "start a 25 minute research sprint, open my board, notify my phone" | Wispr Flow's own overlay; then **press the pull hotkey** (shown in the tray) and the sentence appears in FlowMesh's box | "I dictated that sentence into Wispr Flow, then pulled it with one keystroke. I never typed it and never copied it." |
| 0:45–0:50 | Point at the provenance line | "From your Wispr Flow history (last dictated into chrome) · 8s ago · read-only" | "It tells you where the words came from, and it stays read-only." |
| 0:50–1:05 | **Press Plan** | The plan card: numbered steps, each with a surface tag PC/PHONE/SPACE | "Nothing has happened yet. Every effect is listed before it happens." |
| 1:05–1:15 | **Press the approve hotkey** — hands stay on the keyboard | Receipts appear: one by one, green/grey per step | "One keystroke approves the plan I am looking at. One approval, one run. Each step reports what actually happened." |
| 1:15–1:25 | Zoom the receipts | `sent`, `verified`, `NOT CONFIGURED`, `DESKTOP ONLY` | "Where nothing is configured it says so. It never shows a success it did not observe." |
| 1:25–1:35 | Hit **Approve** again / re-open the plan | "That plan was already used. Plans run once." | "A plan runs once. An old approval can never fire later." |
| 1:35–1:50 | Second dictation, then type over it | Provenance flips from "From your Wispr Flow history" to **"Typed by you"** | "If I edit the words, it stops claiming they were dictated." |
| 1:50–2:00 | End card | Repo + release links + "No simulated success states." | "Same planner, same plan, three runtimes: browser, Windows, and Electron on macOS and Linux." |

## Rules for the recording

- **Do not** show a receipt as `verified` for something that is not configured. If the
  lamp or phone rows are `NOT CONFIGURED`, leave them on screen — that is a feature.
- **Do not** say a key that is not registered. Accelerators collide with other apps; the
  tray shows the keys that actually took effect, so read them off the tray and use those.
- **Do not** speed up or cut the typing. The point is that you never typed.
- One take, no jump cuts inside a single shot; judges can tell.
- No music over the narration; no on-screen text claiming a score, a rank, or a win.

## Before you record

1. Dictate one sentence with Wispr Flow into any app, **within the last five minutes**.
2. Confirm the panel says `connected` and the pull button shows a fresh age.
3. If the panel says `Wispr Flow not detected`, Wispr Flow is not installed for this
   user account — fix that first, do not re-record around it.