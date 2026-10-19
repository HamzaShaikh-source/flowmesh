"""User-owned integration settings. Secrets live in Windows Credential Manager."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import keyring

APP_NAME = "FlowMesh"
FIELDS = {
    "board_url": "FLOWMESH_BOARD_URL",
    "docs_url": "FLOWMESH_DOCS_URL",
    "ha_url": "FLOWMESH_HA_URL",
    "light_entity": "FLOWMESH_LIGHT_ENTITY",
    "phone_service": "FLOWMESH_PHONE_NOTIFY_SERVICE",
}
DEFAULTS = {
    "board_url": "https://github.com/HamzaShaikh-source/flowmesh/issues",
    "docs_url": "https://docs.python.org/3/",
    "ha_url": "",
    "light_entity": "",
    "phone_service": "",
}
SECRET_ENV = {"jev_key": "TYPESAFE_API_KEY", "ha_token": "FLOWMESH_HA_TOKEN"}


def config_path() -> Path:
    root = os.environ.get("FLOWMESH_CONFIG_DIR")
    if root:
        return Path(root) / "settings.json"
    appdata = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
    if appdata:
        return Path(appdata) / APP_NAME / "settings.json"
    return Path.home() / f".{APP_NAME.lower()}" / "settings.json"


def settings() -> dict[str, str]:
    try:
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        if not isinstance(saved, dict):
            saved = {}
    except (OSError, ValueError):
        saved = {}
    return {name: str(saved.get(name) or os.environ.get(env) or DEFAULTS[name]) for name, env in FIELDS.items()}


def secret(name: str) -> str:
    if name not in SECRET_ENV:
        return ""
    try:
        stored = keyring.get_password(APP_NAME, name)
    except (RuntimeError, OSError):
        stored = None
    return stored or os.environ.get(SECRET_ENV[name], "")


def public_settings() -> dict:
    return {**settings(), "jev_connected": bool(secret("jev_key")), "ha_token_connected": bool(secret("ha_token"))}


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
    for name in SECRET_ENV:
        if clean.get(name):
            keyring.set_password(APP_NAME, name, clean[name])
    return public_settings()
