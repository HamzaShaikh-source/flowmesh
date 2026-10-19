# FlowMesh — No Hands 2026

Public judge demo: https://flowmesh-nohands-2026.exactpearl18.chatgpt.site/

One spoken intention becomes an approved set of actions across a computer, phone, and desk lamp. The public link is a resettable judge simulator. The Windows desktop app runs the same interface with real allowlisted actions and local connection settings.

## Run the Windows app

Download or build the `FlowMesh` folder, then open `FlowMesh.exe`. The app starts its own loopback server on a free port and opens a native Windows window; it does not need the hosted site or a Python installation. Windows WebView2 Runtime is required (normally present on Windows 11). Wispr Flow itself remains a separate app: click the command box and dictate into it.

To build from source on Windows with Python 3.12+:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip --isolated install -r requirements-desktop.txt
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --windowed --name FlowMesh --distpath release --workpath build --add-data "dist;dist" --collect-all keyring desktop.py
```

Keep the whole `release/FlowMesh` folder together. Run `release/FlowMesh/FlowMesh.exe`. The binary is not code-signed, so Windows may display a publisher warning.

## Run locally

Python 3.12+ is the only required runtime. From this directory:

```powershell
python bridge.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The bridge binds to your own computer only. No account or API key is needed for the interactive demo.

Focus the command box, hold **Ctrl + Win** and dictate with Wispr Flow on Windows, then release to insert the transcript. You can also type or select one of the sample commands. Wispr Flow is a separate app that you install and sign in to; FlowMesh receives the text it inserts into the focused field.

## Enable Jev routing

In the desktop app, open **Connect devices** and paste a TypeSafe API key. Alternatively, set `TYPESAFE_API_KEY` before launch. Jev uses a typed Choice to select `focus`, `meeting`, `research`, or `none`. The app only accepts a registered choice with confidence at least 0.65. If Jev is unavailable, local rules handle the three sample workflows and the UI labels the routing source. Jev does not execute device actions or invent unrestricted commands.

## Enable the real devices

Fill the desktop app's **Connect devices** form. The equivalent environment variables remain available for CLI use:

| Variable | Purpose |
| --- | --- |
| `FLOWMESH_BOARD_URL` | Approved project board URL; defaults to GitHub Issues |
| `FLOWMESH_DOCS_URL` | Approved documentation URL; defaults to Python docs |
| `FLOWMESH_HA_URL` | Home Assistant origin, for example `http://192.168.1.10:8123` |
| `FLOWMESH_HA_TOKEN` | Home Assistant long-lived access token |
| `FLOWMESH_LIGHT_ENTITY` | An entity such as `light.desk_lamp` |
| `FLOWMESH_PHONE_NOTIFY_SERVICE` | Companion notify service such as `mobile_app_my_phone` |

The desktop app stores Jev and Home Assistant secrets in Windows Credential Manager; the browser receives only connection flags. Environment-provided secrets remain in the environment. For phone actions, install the official Home Assistant Companion app, register the phone, and use its `notify.mobile_app_*` service name. Leave fields unset to receive an honest `not_configured` receipt. Do not put secrets in the hosted static demo.

## How to use

1. Speak into the command box using Wispr Flow or select **Deep focus**.
2. Select **Create action plan**. Review the exact action list.
3. Select **Approve & run**. Watch the computer, phone, and space panels update.
4. Inspect the receipt list. It distinguishes simulated verification, device verification, action requests, failures, and unconfigured integrations.
5. Select **Reset demo** for the next judge.

Try an unsafe or unsupported command such as “unlock the door.” FlowMesh declines to prepare any action.

## Architecture

```text
Wispr Flow dictation → command box → Jev Choice (optional) or local route
→ registered action plan → explicit approval → local adapters → receipts
```

The static `dist/` folder is the no-login judge experience. `desktop.py` wraps the same UI in a Windows WebView2 window; `bridge.py` provides the local action API. Only registered app names, browser destinations, and device targets are accepted. The bridge binds to loopback and rejects cross-origin requests. The Windows app is packaged with [pywebview](https://pywebview.flowrl.com/guide/usage.html) (BSD-3-Clause), [keyring](https://github.com/jaraco/keyring) (MIT), and [PyInstaller](https://pyinstaller.org/) (GPL-2.0-or-later with a special exception for distributing bundled apps); those are dependencies, not copied source.

## Scope and limits

- Windows apps: Notepad and Calculator.
- Browser: two approved URLs.
- Phone: Home Assistant Companion notification. The site is responsive on phones, but there is no native phone controller or arbitrary phone-app control.
- Appliance: one allowlisted Home Assistant light, or the public simulator. Other Home Assistant appliances are future adapters, not silently granted access.
- The bridge can verify the light state after setting it. Browser opening, app launching, and notification delivery are reported as sent requests, because success cannot be established from the service call alone.
- The hosted demo does not call Jev or control the visitor's devices. Its simulator is labeled as such.

## Hackathon submission

Track: **Builders**. Supply the deployed `dist/` link, a demo video of at most two minutes, your Wispr Flow Insights usage-card screenshot, and a short statement about the problem, user, voice-built workflow, and one measured real result. The usage card and real-result claim require your own Wispr session and use of the product; they are not fabricated by this repository.

Suggested result to capture: perform the same focus setup manually and through FlowMesh, record elapsed times, and include the exact number of actions verified or sent.

## Verification

```powershell
python -m unittest discover -s tests -v
node --check dist/app.js
python desktop.py --headless --port 8766
```

Sources that informed the implementation: [challenge rules](https://www.wemakedevs.org/wispr), [Wispr Flow dictation](https://docs.wisprflow.ai/articles/6409258247-starting-your-first-dictation), [TypeSafe Python SDK](https://github.com/typesafe-ai/typesafe-sdk-python), [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast), [Jev Computer Use](https://github.com/JASGENIUS/jev-computer-use), and [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/). No external source code is copied into this repository.
