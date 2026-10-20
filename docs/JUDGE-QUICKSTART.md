# Judge quick-start (2 minutes, nothing to install)

## Path A — the hosted console (fastest)

1. Open **https://flowmesh-nohands.netlify.app/** (any OS, any browser, no account).
2. The status line under the title reads `Browser edition · live`. That means the page detected no local runtime and is running the browser edition, where the plan engine runs in the page.
3. Click **Create plan** with the sample text already in the box, or paste your own:

   > Start a 45 minute focus session. Open my project board and Notepad, notify my phone, dim the desk lamp to 30%, and start a timer.

4. Read the plan. Every action lists its surface (`PC`, `PHONE`, `SPACE`), its parameter, and where it came from.
5. Click **Approve & run ↗**.
   - The timer really starts (receipt: `verified`).
   - The approved URL really opens in a new tab (receipt: `sent`).
   - Phone and lamp read `not_configured` — nothing was attempted, and the reason is shown. That is the honest failure state, not a fake success.
6. The run writes a Markdown record and offers it as a download. It contains the plan, the receipts, and your command verbatim.

Things the browser edition will refuse, on purpose: `desktop_only` for launching Notepad/Calculator, anything unregistered ("delete my files"), and any second approval of the same plan.

## Path B — the desktop runtimes (real OS actions)

**Electron app — Windows, macOS, Linux.** Download the artifact for your OS from the [releases page](https://github.com/HamzaShaikh-source/flowmesh/releases) and run it: `FlowMesh-1.2.0-win-x64.exe` (portable single file), `FlowMesh-1.2.0.dmg`, or `FlowMesh-1.2.0.AppImage`. The builds are unsigned, so Windows SmartScreen (*More info → Run anyway*) and macOS Gatekeeper (*right-click → Open*) will warn.

**Python app — Windows.** Download `FlowMesh-Windows.zip`, unzip, run `FlowMesh.exe`.

**Any OS with Python 3.10+:**

```bash
git clone https://github.com/HamzaShaikh-source/flowmesh
cd flowmesh
python desktop.py --browser
```

The launcher prints a `127.0.0.1` URL containing a per-launch token and opens it. Keep that URL: every `/api` call needs the token, which is why another local process cannot drive your machine.

In desktop edition the same plan now:
- opens the URL in your default browser (`sent`),
- launches Notepad — TextEdit on macOS, the platform text editor on Linux — if the plan includes it (`verified` once the process is spawned),
- writes the run record to `~/FlowMesh/runs/<name>.md` and reports its byte count and SHA-256,
- and, **only if you configured Home Assistant**, sends the phone notification (`sent`) or sets the light and reads the state back (`verified` when it matches). Configure it in Settings; without it those rows stay `not_configured`.

## What to check if you only have 60 seconds

- Does one sentence become a plan you would actually accept? (Real problem test.)
- Does the disabled/refused path look deliberate rather than broken? (`desktop_only`, `not_configured`, unregistered command.)
- Is the receipt language defensible under scrutiny? (`sent` ≠ `verified`, and a hash for anything written.)
- Can you run the tests? `python -m unittest discover -s tests -v` — 57 tests, stdlib only, no network, no credentials. The Electron runtime has its own suite: `npm test` — 18 tests over a real loopback socket, plus `node scripts/e2e_electron.js`, which launches the actual app and drives the actual renderer (10 checks).

## Keyboard / dictation notes

The command box is a plain `<textarea>` with a `<label>`, so Wispr Flow (or any dictation tool) inserts text exactly where the caret is. `Ctrl+Enter` builds the plan, `Ctrl+Shift+Enter` approves it. Nothing in the app listens to a microphone: FlowMesh never claims to contain a speech engine.
