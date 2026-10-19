# FlowMesh

FlowMesh is a Windows voice-workflow app for the [No Hands challenge](https://www.wemakedevs.org/wispr). [Download the latest Windows release](https://github.com/HamzaShaikh-source/flowmesh/releases/latest) or visit the [product page](https://flowmesh-nohands-2026.exactpearl18.chatgpt.site/). The product page does not simulate device actions.

Speak into the focused command box with **Wispr Flow** (a separate installed app), review an exact plan, then approve it. A local Windows runtime executes allowlisted actions and records honest receipts. Jev can select a registered workflow when a TypeSafe API key is configured. Home Assistant can send a Companion phone notification and set a light; missing devices are reported as `not_configured`, never as success.

## Install

1. Download `FlowMesh-Windows.zip` from [Releases](https://github.com/HamzaShaikh-source/flowmesh/releases/latest).
2. Extract the whole `FlowMesh` folder. Run `FlowMesh.exe` inside it. Windows WebView2 Runtime is required; Windows 11 normally has it. The app is unsigned, so Windows may show a publisher warning.
3. Click a sample routine or focus the command box and dictate with Wispr Flow. The Windows shortcut shown in the app is **Ctrl + Win**. You can also type.
4. Review the plan, then select **Approve & run**. The plan is server-owned, expires after five minutes, and can execute only once.

The PC path works immediately: approved web URLs and Notepad/Calculator can launch. The app's runtime binds to `127.0.0.1` on a free port; it does not expose control to the LAN or the public website.

## Connect Jev, phone, and light

Open **Connect devices** inside the desktop app:

| Field | Example | Result |
| --- | --- | --- |
| Project board URL | `https://github.com/HamzaShaikh-source/flowmesh/issues` | Browser destination for focus/meeting |
| Documentation URL | `https://docs.python.org/3/` | Browser destination for research |
| Jev API key | Your TypeSafe key | Jev Choice routing among three registered routines |
| Home Assistant URL | `http://homeassistant.local:8123` | Your Home Assistant server |
| Home Assistant token | Long-lived access token | Authenticates local device calls |
| Light entity ID | `light.desk_lamp` | One allowlisted light |
| Phone notify service | `mobile_app_my_phone` | Home Assistant Companion notification |

API keys and the Home Assistant token are stored in Windows Credential Manager, not in the settings JSON or browser. Environment variables `TYPESAFE_API_KEY`, `FLOWMESH_HA_URL`, `FLOWMESH_HA_TOKEN`, `FLOWMESH_LIGHT_ENTITY`, `FLOWMESH_PHONE_NOTIFY_SERVICE`, `FLOWMESH_BOARD_URL`, and `FLOWMESH_DOCS_URL` also work for CLI runs. Do not add secrets to the repo or hosted site.

Install the official [Home Assistant Companion app](https://companion.home-assistant.io/) on your phone and grant notifications. Home Assistant exposes its service as `notify.mobile_app_<device_id>`; enter the part after `notify.` in FlowMesh. Connect a light to Home Assistant and use its exact `light.*` entity ID. FlowMesh uses the [REST API](https://developers.home-assistant.io/docs/api/rest/) to send service calls and read back light state.

## What is real—and what is not

- Windows: browser open and app launch requests are real, but labeled `sent` because the runtime cannot prove the target became usable.
- Timer: scheduled by the app process and shown as a live countdown. It ends if the app process exits.
- Phone: a real Home Assistant Companion notification request, labeled `sent` when Home Assistant accepts it. Delivery to a phone is not independently verified. This is **not** arbitrary control of mobile apps.
- Light: a real Home Assistant service call; labeled `verified` only when the returned entity state matches the requested brightness.
- Jev: a real TypeSafe API request when keyed. It chooses only among `focus`, `meeting`, `research`, and `none`; it never generates shell commands or unregistered device actions. Without a key, clearly labeled local rules route the three routines.
- Unsupported/sensitive commands are denied. Other appliances require a deliberately registered adapter; the app does not claim universal device control.

This repository does not bundle or reimplement Wispr Flow. A real Wispr session, Jev key, and Home Assistant devices are required to demonstrate those live integrations. Automated tests use controlled responses; they are not presented as live-device proof.

## Build from source

On Windows with Python 3.12+:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip --isolated install -r requirements-desktop.txt
.venv\Scripts\python.exe desktop.py
```

To package the onedir app:

```powershell
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --windowed --name FlowMesh --distpath release --workpath build --add-data "dist;dist" --collect-all keyring desktop.py
Compress-Archive -LiteralPath release\FlowMesh -DestinationPath release\FlowMesh-Windows.zip
```

For a local HTTP-only debug run, use `.venv\Scripts\python.exe desktop.py --headless --port 8766`, then open `http://127.0.0.1:8766/`.

## Architecture and verification

```text
Wispr Flow dictation → desktop UI → POST /api/plan
→ Jev Choice or labeled local route → server-owned, expiring plan
→ explicit approval → POST /api/execute with one-use plan ID
→ allowlisted Windows / Home Assistant adapters → per-action receipts
```

The `dist/index.html` file is the public download page; `dist/app.html` is served only by the desktop runtime. The browser cannot submit a raw action to `/api/execute`. The server checks Host, Origin, JSON content type, plan ID, and target allowlists.

Run the real project checks:

```powershell
.venv\Scripts\python.exe -m unittest discover -s tests -v
node --check dist/app.js
git diff --check
```

The implementation uses [pywebview](https://pywebview.flowrl.com/guide/usage.html), [keyring](https://github.com/jaraco/keyring), and [PyInstaller](https://pyinstaller.org/). Architecture was informed by [Jev Computer Use](https://github.com/JASGENIUS/jev-computer-use) and [TypeSafe's Choice API](https://docs.typesafe.ai/primitives/choice). No source from those inspiration repositories was copied into this project.

See [SUBMISSION.md](SUBMISSION.md) for the human-owned Wispr usage card, live-device evidence, and two-minute video checklist.
