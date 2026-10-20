"""User-owned integration settings.

Secrets prefer the OS credential store (Windows Credential Manager, macOS
Keychain, Secret Service on Linux). When no backend is available the app falls
back to a 0600 JSON file next to the settings, and the UI says which one is in
use. Nothing here is ever returned by the HTTP API.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from urllib.parse import urlparse

APP_NAME = "FlowMesh"
VERSION = "1.1.0"

try:  # Optional: the app must run with a bare Python interpreter.
    import keyring
    from keyring.errors import KeyringError
except Exception:  # pragma: no cover - depends on the machine
    keyring = None

    class KeyringError(Exception):
        pass


FIELDS = {
    "board_url": "FLOWMESH_BOARD_URL",
    "docs_url": "FLOWMESH_DOCS_URL",
    "ha_url": "FLOWMESH_HA_URL",
    "light_entity": "FLOWMESH_LIGHT_ENTITY",
    "phone_service": "FLOWMESH_PHONE_NOTIFY_SERVICE",
}
DEFAULTS = {
    "board_url": "https://github.com/HamzaShaikh-source/flowmesh/issues",
    "docs_url": "https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs",
    "ha_url": "",
    "light_entity": "",
    "phone_service": "",
}
SECRET_ENV = {"jev_key": "TYPESAFE_API_KEY", "ha_token": "FLOWMESH_HA_TOKEN"}


def config_dir() -> Path:
    root = os.environ.get("FLOWMESH_CONFIG_DIR")
    if root:
        return Path(root)
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / APP_NAME
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / APP_NAME.lower()
    return Path.home() / f".{APP_NAME.lower()}"


def config_path() -> Path:
    return config_dir() / "settings.json"


def _secrets_path() -> Path:
    return config_dir() / "secrets.json"


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def settings() -> dict[str, str]:
    saved = _read_json(config_path())
    return {name: str(saved.get(name) or os.environ.get(env) or DEFAULTS[name]) for name, env in FIELDS.items()}


def secret(name: str) -> str:
    if name not in SECRET_ENV:
        return ""
    stored = ""
    if keyring is not None:
        try:
            stored = keyring.get_password(APP_NAME, name) or ""
        except (KeyringError, RuntimeError, OSError):
            stored = ""
    if not stored:
        stored = str(_read_json(_secrets_path()).get(name) or "")
    return stored or os.environ.get(SECRET_ENV[name], "")


def secret_backend() -> str:
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            name = type(backend).__name__
            if "fail" not in name.lower():
                return name
        except (KeyringError, RuntimeError, OSError):
            pass
    return "local file (0600)"


def public_settings() -> dict:
    return {
        **settings(),
        "jev_connected": bool(secret("jev_key")),
        "ha_token_connected": bool(secret("ha_token")),
        "secret_backend": secret_backend(),
    }


def validate(values: dict) -> dict[str, str]:
    if any(name not in FIELDS and name not in SECRET_ENV for name in values):
        raise ValueError("Unknown setting")
    clean = {}
    for name, value in values.items():
        if not isinstance(value, str) or len(value) > 2048:
            raise ValueError(f"Invalid {name}")
        value = value.strip()
        if name in {"board_url", "docs_url", "ha_url"} and value:
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError(f"{name} must be an HTTP(S) URL without credentials")
        if name == "light_entity" and value and (not value.startswith("light.") or not value.replace(".", "").replace("_", "").isalnum()):
            raise ValueError("Light entity must look like light.desk_lamp")
        if name == "phone_service" and value and (not value.startswith("mobile_app_") or not value.replace("_", "").isalnum()):
            raise ValueError("Phone service must look like mobile_app_my_phone")
        clean[name] = value
    return clean


def save(values: dict) -> dict:
    clean = validate(values)
    current = settings()
    current.update({name: value for name, value in clean.items() if name in FIELDS})
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the existing file intact if the replacement cannot be completed.
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(current, indent=2), encoding="utf-8")
    temporary.replace(path)
    wanted = {name: value for name, value in clean.items() if name in SECRET_ENV and value}
    if wanted:
        leftover = {}
        for name, value in wanted.items():
            stored = False
            if keyring is not None:
                try:
                    keyring.set_password(APP_NAME, name, value)
                    stored = True
                except (KeyringError, RuntimeError, OSError):
                    stored = False
            if not stored:
                leftover[name] = value
        if leftover:
            path_secrets = _secrets_path()
            merged = {**_read_json(path_secrets), **leftover}
            path_secrets.parent.mkdir(parents=True, exist_ok=True)
            path_secrets.write_text(json.dumps(merged, indent=2), encoding="utf-8")
            try:
                os.chmod(path_secrets, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
    return public_settings()
