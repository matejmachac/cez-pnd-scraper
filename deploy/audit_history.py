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
    for path in sorted(glob.glob(prefix + ".history.*")):
        for day, item in json.loads(Path(path).read_text())["data"].items():
            all_days[day] = item
            row = months[day[:7]]
            energy = sum(
                (Decimal(str(v["kwh"])) for v in item["intervals"]), Decimal(0)
            )
            row["days"] += 1
            row["kwh"] += energy
            tariffs = item["tariffs"]
            row["qualities"][tariffs["quality"]] += 1
            if tariffs["quality"] == "measured":
                row["paired_profile_kwh"] += energy
                row["vt"] += Decimal(str(tariffs["vt"]))
                row["nt"] += Decimal(str(tariffs["nt"]))
    for month, row in months.items():
        if "2026-10" <= month <= "2026-12":
            year, number = map(int, month.split("-"))
            # Independent check against the user-supplied default price period.
            fixed = Decimal(842) * row["days"] / monthrange(year, number)[1]
            row["expected_priced_costs"] = {
                "vt": row["vt"] * Decimal("4.19544"),
                "nt": row["nt"] * Decimal("3.42314"),
                "fixed": fixed,
                "total": row["vt"] * Decimal("4.19544")
                + row["nt"] * Decimal("3.42314")
                + fixed,
                "valid_for_all_days": row["qualities"]["measured"] == row["days"],
            }
    pending = state.get("pending", {})
    cursor = pending.get("cursor", 0)
    dates = pending.get("dates", [])
    result = {
        "status": state.get("status"),
        "enabled": state.get("enabled"),
        "last_success": state.get("last_success"),
        "archived_days": len(all_days),
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
