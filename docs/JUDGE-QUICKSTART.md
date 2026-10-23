# Judge quick-start (2 minutes, nothing to install)

**The flagship integration needs the desktop build.** FlowMesh reads your own Wispr
Flow history — hold your Wispr key, speak, press **Use my last dictation**, and the
sentence you just dictated becomes the plan. A web page cannot read your local files,
so the browser edition shows that panel as **desktop only** and says why, instead of
pretending. Path B below is where to watch it work.

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

**Electron app — Windows, macOS, Linux.** Download the artifact for your OS from the [releases page](https://github.com/HamzaShaikh-source/flowmesh/releases) and run it: `FlowMesh-1.7.2-win-x64.exe` (portable: double-click, no install), `FlowMesh-1.7.2-mac-arm64.dmg` (Apple silicon), or `FlowMesh-1.7.2-linux-x86_64.AppImage` (`chmod +x`, then run). The builds are unsigned, so Windows SmartScreen (*More info → Run anyway*) and macOS Gatekeeper (*right-click → Open*) will warn.

**Python app — Windows.** Download `FlowMesh-Windows.zip`, unzip, run `FlowMesh.exe`.

### Watch the Wispr integration (the demo moment)

1. If you do not have Wispr Flow, install it and dictate one sentence into any app so
   there is history to read. Without it the panel says **Wispr Flow not detected** —
   which is the honest state, not a bug.
2. Open FlowMesh. The panel shows **connected**, the lifetime dictation count, and the
   median dictation latency read from your own history.
3. Hold your Wispr key and speak a command, e.g.

   > Start a 25 minute research sprint. Open my board and notify my phone.

4. Press **Use my last dictation**. The sentence appears in the box, with a line under
   it saying where it came from and how old it is. Edit one character and that line
   changes to **Typed by you**.
5. Plan → approve → run, as in Path A.

Only a dictation from the last **5 minutes** can be pulled, so dictate just before you
try it. Press **Type into my window** to send the dictation back as keystrokes into
whichever app has focus — that receipt says `sent`, never `verified`, because FlowMesh
cannot read back what the other app did with it.

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
- Can you run the tests? `python -m unittest discover -s tests -v` — 84 tests, stdlib only, no network, no credentials. The Electron runtime has its own suite: `npm --prefix electron test` — 41 tests over a real loopback socket, plus `node scripts/e2e_electron.js`, which launches the actual app and drives the actual renderer (10 checks).
- Do you want the numbers without running anything? [EVAL.md](EVAL.md) is generated from the shipped code by `python eval/run_eval.py`: 43/43 cross-runtime parity, 12/12 recorded plans reproduced, 6/6 destructive commands refused, 6/6 adversarial HTTP requests answered as designed, plus real readings from the local Wispr database. It states what it does not measure.

## Keyboard / dictation notes

The command box is a plain `<textarea>` with a `<label>`, so Wispr Flow (or any dictation tool) inserts text exactly where the caret is. `Ctrl+Enter` builds the plan, `Ctrl+Shift+Enter` approves it. Nothing in the app listens to a microphone: FlowMesh never claims to contain a speech engine.
