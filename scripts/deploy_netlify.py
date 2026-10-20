"""Deploy web/ to the public Netlify site.

Needs a Netlify personal token in the standard CLI config
(%APPDATA%/netlify/Config/config.json) or NETLIFY_AUTH_TOKEN. The token is never
printed, logged, or written into the repo.

    python scripts/deploy_netlify.py [--site flowmesh-nohands] [--dir web] [--dry-run]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

API = "https://api.netlify.com/api/v1"


def token() -> str:
    env = os.environ.get("NETLIFY_AUTH_TOKEN")
    if env:
        return env.strip()
    config = Path(os.environ.get("APPDATA", "")) / "netlify" / "Config" / "config.json"
    if config.exists():
        data = json.loads(config.read_text(encoding="utf-8"))
        for user in (data.get("users") or {}).values():
            if user.get("auth", {}).get("token"):
                return user["auth"]["token"]
    raise SystemExit("No Netlify token found. Set NETLIFY_AUTH_TOKEN or run `netlify login`.")


def request(path: str, *, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(f"{API}{path}", method=method, data=body)
    req.add_header("Authorization", f"Bearer {token()}")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"Netlify {method} {path} failed: {error.code} {detail}") from error


def find_site(name: str) -> dict:
    for site in request("/sites?per_page=100"):
        if site.get("name") == name or name in (site.get("custom_domain") or ""):
            return site
    raise SystemExit(f"No Netlify site matching {name!r}.")


def bundle(directory: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and "node_modules" not in path.parts:
                archive.write(path, path.relative_to(directory).as_posix())
    return buffer.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Deploy a static directory to Netlify.")
    parser.add_argument("--site", default="flowmesh-nohands")
    parser.add_argument("--dir", default="web")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    directory = Path(args.dir).resolve()
    if not (directory / "index.html").exists():
        raise SystemExit(f"{directory} has no index.html")

    site = find_site(args.site)
    payload = bundle(directory)
    print(f"site={site['name']} files={len(list(directory.rglob('*')))} zip={len(payload)} bytes")
    if args.dry_run:
        print("dry run: nothing uploaded")
        return 0

    deploy = request(
        f"/sites/{site['id']}/deploys",
        method="POST",
        body=payload,
        headers={"Content-Type": "application/zip"},
    )
    deploy_id = deploy["id"]
    print(f"deploy {deploy_id} state={deploy.get('state')}")

    for _ in range(60):
        state = request(f"/deploys/{deploy_id}")["state"]
        if state in {"ready", "current"}:
            print(f"published: {site.get('ssl_url') or site.get('url')}")
            return 0
        if state in {"error", "rejected"}:
            raise SystemExit(f"deploy ended in state {state}")
        time.sleep(3)
    raise SystemExit("deploy did not settle in time")


if __name__ == "__main__":
    sys.exit(main())
