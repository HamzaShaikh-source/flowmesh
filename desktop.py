"""FlowMesh Windows desktop entrypoint."""

from __future__ import annotations

import argparse
import sys
import threading

from bridge import Handler, ThreadingHTTPServer


def main() -> None:
    parser = argparse.ArgumentParser(description="FlowMesh desktop app")
    parser.add_argument("--headless", action="store_true", help="Serve locally without opening a window")
    parser.add_argument("--port", type=int, default=0, help="Local server port (0 chooses a free port)")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}/"
    worker = threading.Thread(target=server.serve_forever, daemon=True, name="flowmesh-http")
    worker.start()
    if sys.stdout is not None:
        print(f"FlowMesh ready: {url}", flush=True)
    try:
        if args.headless:
            worker.join()
        else:
            import webview

            webview.create_window("FlowMesh — make room for the work", url, width=1320, height=900, min_size=(900, 640))
            webview.start(gui="edgechromium")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
