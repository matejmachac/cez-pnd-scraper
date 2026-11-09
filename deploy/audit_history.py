"""Read-only, credential-free audit of the native measurement archive on HA."""

from calendar import monthrange
from collections import Counter, defaultdict
from decimal import Decimal
import glob
import json
from pathlib import Path


def audit(root="/config/.storage"):
    paths = glob.glob(str(Path(root) / "cez_pnd.*.state"))
    if len(paths) != 1:
        raise RuntimeError("Select an installation with exactly one native PND entry")
    state_path = Path(paths[0])
    state = json.loads(state_path.read_text())["data"]
    prefix = str(state_path).removesuffix(".state")
    months = defaultdict(
        lambda: {
            "days": 0,
            "kwh": Decimal(0),
            "vt": Decimal(0),
            "nt": Decimal(0),
            "paired_profile_kwh": Decimal(0),
            "qualities": Counter(),
        }
    )
    all_days = {}
    if state.get("manual_enabled", True):
        for path in sorted(glob.glob(prefix + ".manual.*")):
            all_days.update(json.loads(Path(path).read_text())["data"])
    pnd_days = 0
    for path in sorted(glob.glob(prefix + ".history.*")):
        for day, item in json.loads(Path(path).read_text())["data"].items():
            pnd_days += 1
            manual = all_days.get(day)
            if manual and item["tariffs"]["quality"] != "measured":
                item = {**item, "tariffs": manual["tariffs"]}
            all_days[day] = item
    prices = []
    entries_file = Path(root) / "core.config_entries"
    if entries_file.exists():
        for entry in json.loads(entries_file.read_text())["data"]["entries"]:
            if entry["domain"] == "cez_pnd":
                prices = entry.get("options", {}).get("prices", [])
    for day, item in sorted(all_days.items()):
        row = months[day[:7]]
        energy = (
            sum((Decimal(str(v["kwh"])) for v in item["intervals"]), Decimal(0))
            if item["intervals"]
            else Decimal(item["daily_kwh"])
        )
        row["days"] += 1
        row["kwh"] += energy
        tariffs = item["tariffs"]
        row["qualities"][tariffs["quality"]] += 1
        if tariffs["quality"] in ("measured", "estimated_daily"):
            row["paired_profile_kwh"] += energy
            row["vt"] += Decimal(str(tariffs["vt"]))
            row["nt"] += Decimal(str(tariffs["nt"]))
            price = next((p for p in prices if p["from"] <= day < p["until"]), None)
            if price:
                charges = row.setdefault(
                    "expected_priced_costs",
                    {
                        "vt": Decimal(0),
                        "nt": Decimal(0),
                        "fixed": Decimal(0),
                        "total": Decimal(0),
                        "priced_days": 0,
                    },
                )
                vt = Decimal(tariffs["vt"]) * Decimal(price["vt"])
                nt = Decimal(tariffs["nt"]) * Decimal(price["nt"])
                year, month, _ = map(int, day.split("-"))
                fixed = Decimal(price["fixed"]) / monthrange(year, month)[1]
                charges["vt"] += vt
                charges["nt"] += nt
                charges["fixed"] += fixed
                charges["total"] += vt + nt + fixed
                charges["priced_days"] += 1
    pending = state.get("pending", {})
    cursor = pending.get("cursor", 0)
    dates = pending.get("dates", [])
    result = {
        "status": state.get("status"),
        "enabled": state.get("enabled"),
        "last_success": state.get("last_success"),
        "archived_days": len(all_days),
        "pnd_profile_days": pnd_days,
        "estimated_days": len(state.get("estimated_days", [])),
        "unpriced_days": len(state.get("unpriced_days", [])),
        "first": min(all_days, default=None),
        "last": max(all_days, default=None),
        "pending": {
            "cursor": cursor,
            "count": len(dates),
            "next": dates[cursor] if cursor < len(dates) else None,
        },
        "missing_days": state.get("missing_days", []),
        "unavailable_days": len(state.get("unavailable_days", [])),
        "totals": state.get("totals"),
        "months": dict(months),
    }
    target = all_days.get("2026-11-08")
    if target:
        result["reference_day"] = {"day": "2026-11-08", "tariffs": target["tariffs"]}
    baseline = all_days.get("2026-09-30")
    if baseline:
        result["billing_opening_registers"] = {
            row["register"]: row["kwh"] for row in baseline["registers"]
        }
    return result


if __name__ == "__main__":
    print(json.dumps(audit(), ensure_ascii=False, default=str, indent=2))
