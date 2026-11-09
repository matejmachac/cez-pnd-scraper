#!/usr/bin/env python3
"""Run inside the existing HA SSH app. Never print tokens or PND credentials.

Stages deliberately separate reversible preparation, transport upgrade, Core
restart, and native entry creation. Uses supported Supervisor/Core APIs only.
"""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

PRIVATE = Path("/config/.cez_pnd_migration")


def save(name, data):
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(PRIVATE, 0o700)
    target = PRIVATE / name
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(data, stream)
    os.chmod(target, 0o600)


def api(path, data=None, *, method=None, token=None, base="http://supervisor"):
    headers = {"Authorization": "Bearer " + (token or os.environ["SUPERVISOR_TOKEN"])}
    payload = None
    if data is not None:
        payload = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        base + path, data=payload, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"API operation failed with HTTP {error.code}; response suppressed to protect credentials"
        ) from None
    if isinstance(result, dict) and result.get("result") == "error":
        raise RuntimeError(
            "Supervisor rejected the operation; response suppressed to protect credentials"
        )
    return result


def transport_url(info):
    """Use Supervisor-registered DNS, not the Docker container hostname."""
    names = info.get("dns") or []
    host = names[0] if names else info["hostname"] + ".local.hass.io"
    return "http://" + host + ":8099"


def app_info(slug):
    return api(f"/addons/{slug}/info")["data"]


def main(args):
    if args.phase == "prepare":
        if not (PRIVATE / "original-app.json").exists():
            save("original-app.json", app_info(args.app))
        config = api("/core/api/config")
        if tuple(map(int, config["version"].split(".")[:2])) < (2026, 11):
            raise RuntimeError("Native adapter requires HA Core 2026.11 or newer")
        if config.get("currency") != "CZK":
            raise RuntimeError("HA currency must be CZK for these confirmed prices")
        print(
            json.dumps(
                {"prepared": True, "core": config["version"], "backup": str(PRIVATE)}
            )
        )
    elif args.phase == "transport":
        if not (PRIVATE / "original-app.json").exists():
            raise RuntimeError("Run prepare before upgrading or changing configuration")
        info = app_info(args.app)
        if tuple(map(int, info["version"].split("."))) < (0, 5, 0):
            raise RuntimeError("Upgrade the existing app to 0.5.0 first")
        token_file = PRIVATE / "bridge.json"
        token = (
            json.loads(token_file.read_text())["token"]
            if token_file.exists()
            else secrets.token_urlsafe(48)
        )
        save("bridge.json", {"token": token})
        options = {**info["options"], "writer_mode": "native", "bridge_token": token}
        api(f"/addons/{args.app}/options", {"options": options})
        api(f"/addons/{args.app}/restart", {})
        current = app_info(args.app)
        url = transport_url(current)
        transport = api("/v1/info", base=url, token=token)
        if transport.get("writerMode") != "native":
            raise RuntimeError("The legacy writer has not stopped")
        today = datetime.now(ZoneInfo("Europe/Prague")).date()
        try:
            first = today.replace(year=today.year - 3)
        except ValueError:
            first = today.replace(year=today.year - 3, day=28)
        save(
            "entry-input.json",
            {
                "url": url,
                "token": token,
                "supply_point": args.supply_point,
                "statistic_id": transport.get("statisticId") or "",
                "history_start": args.start or first.isoformat(),
            },
        )
        print(
            json.dumps(
                {
                    "transport": "native",
                    "legacy_writer": "stopped",
                    "version": current["version"],
                }
            )
        )
    elif args.phase == "setup":
        data = json.loads((PRIVATE / "entry-input.json").read_text())
        existing = [
            entry
            for entry in api("/core/api/config/config_entries/entry")
            if entry["domain"] == "cez_pnd"
        ]
        if existing:
            print(json.dumps({"existing_entry": existing[0]["entry_id"]}))
            return
        flow = api(
            "/core/api/config/config_entries/flow",
            {"handler": "cez_pnd", "show_advanced_options": False},
        )
        result = api("/core/api/config/config_entries/flow/" + flow["flow_id"], data)
        if result["type"] != "create_entry":
            print(
                json.dumps(
                    {"flow_type": result["type"], "errors": result.get("errors", {})}
                )
            )
            raise RuntimeError("Native config flow did not create an entry")
        save("entry-result.json", {"entry_id": result["result"]["entry_id"]})
        print(json.dumps({"native_entry": result["result"]["entry_id"]}))
    elif args.phase == "verify":
        entries = [
            entry
            for entry in api("/core/api/config/config_entries/entry")
            if entry["domain"] == "cez_pnd"
        ]
        states = [
            state
            for state in api("/core/api/states")
            if state["entity_id"].startswith(
                "sensor.cez_pnd_" + args.supply_point + "_"
            )
        ]
        print(
            json.dumps(
                {
                    "entries": [
                        {"state": entry["state"], "title": entry["title"]}
                        for entry in entries
                    ],
                    "sensors": [
                        {
                            "entity": state["entity_id"],
                            "state": state["state"],
                            "unit": state["attributes"].get("unit_of_measurement"),
                        }
                        for state in states
                    ],
                },
                ensure_ascii=False,
            )
        )
    elif args.phase == "rollback":
        entries = [
            entry
            for entry in api("/core/api/config/config_entries/entry")
            if entry["domain"] == "cez_pnd"
        ]
        for entry in entries:
            api("/core/api/services/cez_pnd/rollback", {"entry_id": entry["entry_id"]})
        old = json.loads((PRIVATE / "original-app.json").read_text())
        options = {**old["options"], "writer_mode": "legacy", "bridge_token": ""}
        api(f"/addons/{args.app}/options", {"options": options})
        api(f"/addons/{args.app}/restart", {})
        print(
            json.dumps(
                {"rolled_back": True, "writer": "legacy", "statistics_retained": True}
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase", choices=["prepare", "transport", "setup", "verify", "rollback"]
    )
    parser.add_argument("--app", required=True)
    parser.add_argument("--supply-point", default="dubnice")
    parser.add_argument("--start")
    main(parser.parse_args())
