"""Apply confirmed historical prices using native HA Options Flow (run on HA)."""

import json
from pathlib import Path
import sys
import time
from native_deploy import api, PRIVATE


def main(schedule_path):
    entry_id = json.loads((PRIVATE / "entry-result.json").read_text())["entry_id"]
    backup = PRIVATE / "native-entry-before-historical-prices.json"
    if not backup.exists():
        entries = json.loads(Path("/config/.storage/core.config_entries").read_text())[
            "data"
        ]["entries"]
        old = next(entry for entry in entries if entry["entry_id"] == entry_id)
        backup.write_text(json.dumps(old))
        backup.chmod(0o600)
    history_start = json.loads((PRIVATE / "entry-input.json").read_text())[
        "history_start"
    ]
    for price in json.loads(Path(schedule_path).read_text()):
        flow = api(
            "/core/api/config/config_entries/options/flow",
            {"handler": entry_id, "show_advanced_options": False},
        )
        result = api(
            "/core/api/config/config_entries/options/flow/" + flow["flow_id"],
            {
                "history_start": history_start,
                "correction_days": 7,
                "update_price": True,
                "replace_source": "none",
                "price_from": price["from"],
                "price_until": price["until"],
                "price_vt": price["vt"],
                "price_nt": price["nt"],
                "price_fixed": price["fixed"],
            },
        )
        if result["type"] != "create_entry":
            raise RuntimeError("Options Flow rejected a historical price period")
        print(
            json.dumps({"from": price["from"], "until": price["until"], "saved": True})
        )
        time.sleep(2)  # Let the native options listener finish its entry reload.


if __name__ == "__main__":
    main(sys.argv[1])
