"""Explicit daily estimates constrained by register anchors and real PND data."""

from collections import defaultdict
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from .model import MeasurementError, NANO, parse_date, hourly_energy

KNOWN_TARIFFS = ("measured", "estimated_daily")


def number(value):
    try:
        result = Decimal(str(value))
    except InvalidOperation as err:
        raise MeasurementError("Invalid manual reading") from err
    if not result.is_finite() or result < 0 or result.as_tuple().exponent < -9:
        raise MeasurementError("Invalid manual reading")
    return result


def build_estimates(anchors, measured):
    """Boundaries are local midnights; an end-of-day reading uses the next date.

    Reserve all measured daily tariffs first. Preserve measured profiles with
    unknown tariffs, estimating only their tariff split. Distribute the remaining
    register deltas over unmeasured calendar days. Never cross a meter reset.
    """
    if not 2 <= len(anchors) <= 10000:
        raise MeasurementError("Provide between 2 and 10000 register anchors")
    groups = defaultdict(dict)
    for anchor in anchors:
        day = parse_date(anchor["boundary"])
        meter = anchor["meter_id"]
        if not isinstance(meter, str) or not meter or not anchor.get("source"):
            raise MeasurementError("Manual anchors require a meter and provenance")
        clean = {
            **anchor,
            "vt": str(number(anchor["vt"])),
            "nt": str(number(anchor["nt"])),
        }
        if day in groups[meter] and any(
            groups[meter][day][k] != clean[k] for k in ("vt", "nt")
        ):
            raise MeasurementError("Conflicting readings at the same boundary")
        groups[meter][day] = clean
    result, conflicts = {}, []
    for meter, values in groups.items():
        ordered = sorted(values)
        for start, end in zip(ordered, ordered[1:]):
            before, after = values[start], values[end]
            remaining = {
                k: Decimal(after[k]) - Decimal(before[k]) for k in ("vt", "nt")
            }
            if any(v < 0 for v in remaining.values()):
                raise MeasurementError(
                    "A decreasing register requires a separate meter segment"
                )
            days = [
                (start + timedelta(days=i)).isoformat()
                for i in range((end - start).days)
            ]
            missing, profile_only = [], []
            for day in days:
                item = measured.get(day)
                if item is None:
                    missing.append(day)
                    continue
                meters = {str(row["meter_id"]) for row in item["intervals"]}
                if meters != {meter}:
                    raise MeasurementError(
                        "Manual interval crosses a different physical meter"
                    )
                if item["tariffs"]["quality"] == "measured":
                    for k in remaining:
                        remaining[k] -= Decimal(item["tariffs"][k])
                else:
                    profile_only.append(day)
            if any(v < 0 for v in remaining.values()):
                conflicts.append(
                    {
                        "from": start.isoformat(),
                        "until": end.isoformat(),
                        "reason": "measured_tariffs_exceed_anchor",
                    }
                )
                continue
            allocations = {}
            for day in profile_only:
                total = sum(
                    hourly_energy(measured[day]["intervals"]).values(), Decimal(0)
                )
                available = sum(remaining.values(), Decimal(0))
                if total > available or (not available and total):
                    break
                vt = (
                    (total * remaining["vt"] / available).quantize(NANO)
                    if available
                    else Decimal(0)
                )
                vt = min(vt, remaining["vt"])
                nt = total - vt
                if nt > remaining["nt"]:
                    nt = remaining["nt"]
                    vt = total - nt
                allocations[day] = {"vt": vt, "nt": nt}
                remaining["vt"] -= vt
                remaining["nt"] -= nt
            else:
                if missing:
                    nanos = {k: int(v / NANO) for k, v in remaining.items()}
                    for i, day in enumerate(missing):
                        allocations[day] = {
                            k: Decimal(
                                v * (i + 1) // len(missing) - v * i // len(missing)
                            )
                            * NANO
                            for k, v in nanos.items()
                        }
                elif any(v > Decimal("0.01") for v in remaining.values()):
                    conflicts.append(
                        {
                            "from": start.isoformat(),
                            "until": end.isoformat(),
                            "reason": "no_unmeasured_days_for_residual",
                        }
                    )
                for day, amounts in allocations.items():
                    if day in result:
                        raise MeasurementError("Manual meter segments overlap")
                    total = amounts["vt"] + amounts["nt"]
                    result[day] = {
                        "source": "manual_register_interpolation",
                        "resolution": "day",
                        "meter_id": meter,
                        "intervals": [],
                        "registers": [],
                        "opening_registers": [],
                        "daily_kwh": str(total),
                        "tariffs": {
                            "quality": "estimated_daily",
                            "resolution": "day",
                            "vt": str(amounts["vt"]),
                            "nt": str(amounts["nt"]),
                            "total": str(total),
                        },
                        "provenance": {
                            "method": "equal_calendar_days_after_pnd",
                            "from_anchor": before,
                            "until_anchor": after,
                            "preserved_pnd_profile": day in profile_only,
                        },
                    }
                continue
            conflicts.append(
                {
                    "from": start.isoformat(),
                    "until": end.isoformat(),
                    "reason": "measured_profile_exceeds_residual",
                }
            )
    return result, conflicts
