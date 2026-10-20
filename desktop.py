"""Launch FlowMesh.

    python desktop.py            # native window when the toolkit is present
    python desktop.py --browser  # plain browser tab (no GUI toolkit needed)
    python desktop.py --headless # print the URL, no UI (for CI and screenshots)

Only the Python standard library is required. pywebview and keyring are
optional: with them you get a native window and the OS credential store.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser

from bridge import SESSION_TOKEN, VERSION, serve
from flowmesh_config import config_dir


def record_launch(url: str) -> None:
    """Leave the launch URL where the person can find it if the window fails.

    The file is user-only (0600). It is overwritten on every launch, so it can
    never accumulate tokens.
    """
    try:
        path = config_dir() / "launch-url.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(url + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        pass


def open_window(url: str) -> bool:
    """Return True when a native window was opened and then closed."""
    try:
        import webview  # type: ignore
    except Exception:
        return False
    try:
        webview.create_window(
            "FlowMesh",
            url,
            width=1180,
            height=880,
            min_size=(900, 640),
            background_color="#0a100e",
        )
        webview.start()
        return True
    except Exception:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flowmesh", description="Run the local FlowMesh runtime.")
    parser.add_argument("--port", type=int, default=0, help="Port to bind on 127.0.0.1 (default: any free port).")
    parser.add_argument("--browser", action="store_true", help="Open a browser tab instead of a native window.")
    parser.add_argument("--window", action="store_true", help="Require the native window (fails loudly if unavailable).")
    parser.add_argument("--headless", action="store_true", help="Do not open any UI; print the URL and serve.")
    args = parser.parse_args(argv)

    server = serve(args.port)
    thread = threading.Thread(target=server.serve_forever, name="flowmesh-http", daemon=True)
    thread.start()
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/?k={SESSION_TOKEN}"

    print(f"FlowMesh {VERSION} — local runtime on 127.0.0.1:{port}")
    print(f"Open: {url}")
    print("This URL carries the session token. It only answers on this machine.")
    record_launch(url)

    windowed = False
    if not (args.headless or args.browser):
        if args.window or os.name == "nt" or sys.platform == "darwin":
            windowed = open_window(url)
            if args.window and not windowed:
                print("pywebview is not available. Install it with: pip install pywebview", file=sys.stderr)
                server.shutdown()
                return 2
        if not windowed:
            webbrowser.open(url)

    try:
        thread.join()
    except KeyboardInterrupt:
        print("\nStopping FlowMesh.")
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
