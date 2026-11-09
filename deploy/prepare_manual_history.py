"""Read an XLSX export into private, provenance-preserving manual anchors.

Run with a Python environment that has openpyxl. No workbook is edited.
Invoice anchors are a separate private JSON input, never embedded in the code.
"""

import argparse
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import openpyxl


def prepare(path, meter, invoice, excludes):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    values = {}
    source_cells = {}
    selected = [
        sheet
        for sheet in workbook
        if sheet.title.endswith((" - Electricity T1", " - Electricity T2"))
    ]
    if len(selected) != 4:
        raise ValueError(
            "Select an export with the four expected electricity reading tables"
        )
    excluded = []
    for sheet in selected:
        tariff = "vt" if sheet.title.endswith("T1") else "nt"
        for row in range(3, sheet.max_row + 1):
            day, value = sheet.cell(row, 1).value, sheet.cell(row, 2).value
            if (
                not isinstance(day, datetime)
                or isinstance(value, bool)
                or not isinstance(value, (int, float))
            ):
                raise ValueError(f"Invalid manual reading in {sheet.title} row {row}")
            date = day.date().isoformat()
            if date in excludes:
                excluded.append(
                    {
                        "sheet": sheet.title,
                        "row": row,
                        "reading_date": date,
                        "reason": "superseded_by_invoice_meter_closing",
                    }
                )
                continue
            if tariff in values.setdefault(date, {}) and values[date][tariff] != str(
                value
            ):
                raise ValueError("Conflicting duplicate manual readings")
            values[date][tariff] = str(value)
            source_cells.setdefault(date, {})[tariff] = {
                "sheet": sheet.title,
                "date_cell": f"A{row}",
                "reading_cell": f"B{row}",
            }
    anchors = []
    for date, readings in sorted(values.items()):
        if set(readings) != {"vt", "nt"}:
            raise ValueError("Every manual date must have both tariff readings")
        anchors.append(
            {
                "boundary": (
                    datetime.fromisoformat(date).date() + timedelta(days=1)
                ).isoformat(),
                "meter_id": meter,
                **readings,
                "source": {
                    "kind": "manual_xlsx",
                    "reading_date": date,
                    "time_convention": "date_only_assumed_end_of_day",
                    "cells": source_cells[date],
                },
            }
        )
    anchors.extend(invoice)
    return {
        "schema_version": 1,
        "supply_point": "dubnice",
        "source": {
            "filename": path.name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "excluded_rows": excluded,
            "zero_nt_until": "2025-01-20; confirmed by owner",
        },
        "anchors": anchors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--meter", required=True)
    parser.add_argument("--invoice-anchors", type=Path, required=True)
    parser.add_argument("--exclude-date", action="append", default=[])
    args = parser.parse_args()
    payload = prepare(
        args.xlsx,
        args.meter,
        json.loads(args.invoice_anchors.read_text()),
        set(args.exclude_date),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    args.output.chmod(0o600)
    print(
        json.dumps(
            {
                "anchors": len(payload["anchors"]),
                "excluded_rows": len(payload["source"]["excluded_rows"]),
                "first_boundary": min(a["boundary"] for a in payload["anchors"]),
                "last_boundary": max(a["boundary"] for a in payload["anchors"]),
            }
        )
    )
