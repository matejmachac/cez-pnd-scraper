"""HA-independent, UTC-normalized measurements and exact daily tariff billing."""

from datetime import date, datetime, timedelta, UTC
from decimal import Decimal, InvalidOperation
import math
import re
from zoneinfo import ZoneInfo

PRAGUE = ZoneInfo("Europe/Prague")
NANO = Decimal("0.000000001")


class MeasurementError(ValueError):
    """Malformed or incomplete measured data; never silently interpolate."""


def parse_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Expected YYYY-MM-DD")
    return date.fromisoformat(value)


def boundary(day):
    if isinstance(day, str):
        day = parse_date(day)
    return datetime.combine(day, datetime.min.time(), PRAGUE).astimezone(UTC)


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise MeasurementError("A timestamp must have an explicit timezone")
    return result.astimezone(UTC)


def normalise_profile(profile, supply_point):
    day = parse_date(profile["targetDate"])
    start, end = boundary(day), boundary(day + timedelta(days=1))
    expected = int((end - start).total_seconds() // 900)
    rows = profile["intervals"]
    if len(rows) != expected or not profile.get("meterId"):
        raise MeasurementError(f"Incomplete profile: {len(rows)}/{expected}")
    normalized = []
    for index, row in enumerate(sorted(rows, key=lambda item: item["endMs"])):
        end_time = datetime.fromtimestamp(row["endMs"] / 1000, UTC)
        power = row["powerKw"]
        if (
            isinstance(power, bool)
            or not isinstance(power, (int, float))
            or not math.isfinite(power)
            or power < 0
        ):
            raise MeasurementError("Invalid import power")
        if end_time != start + timedelta(minutes=15 * (index + 1)):
            raise MeasurementError("Duplicate, missing, or misaligned interval")
        normalized.append(
            {
                "supply_point": supply_point,
                "meter_id": str(row.get("meterId", profile["meterId"])),
                "start": (end_time - timedelta(minutes=15)).isoformat(),
                "end": end_time.isoformat(),
                "kwh": str(Decimal(str(power)) / 4),
                "tariff": None,
                "source": "pnd_profile_csv",
                "quality": "measured",
                "complete": True,
            }
        )
    return normalized


def hourly_energy(intervals):
    hours = {}
    for row in intervals:
        start = timestamp(row["start"]).replace(minute=0, second=0, microsecond=0)
        hours[start] = hours.get(start, Decimal(0)) + Decimal(row["kwh"])
    return hours


def daily_tariffs(day, previous, current, profile_total=None):
    """Daily deltas only; no fabricated hourly VT/NT energy curve."""
    before, after = (
        {item["register"]: item for item in rows} for rows in (previous, current)
    )
    if any(
        key not in readings
        for key in ("total", "vt", "nt")
        for readings in (before, after)
    ):
        return {"quality": "tariff_unavailable"}
    if len(before) != len(previous) or len(after) != len(current):
        raise MeasurementError("Duplicate registry readings")
    if len({item["meterId"] for item in [*previous, *current]}) != 1:
        return {"quality": "meter_changed"}
    start, end = boundary(day), boundary(parse_date(day) + timedelta(days=1))
    for readings, instant in ((before, start), (after, end)):
        for item in readings.values():
            if (
                timestamp(item["timestamp"]) != instant
                or item.get("quality") != "measured"
            ):
                raise MeasurementError(
                    "Unverified or incorrectly dated registry reading"
                )
    deltas = {
        key: Decimal(str(after[key]["kwh"])) - Decimal(str(before[key]["kwh"]))
        for key in ("total", "vt", "nt")
    }
    if any(not value.is_finite() or value < 0 for value in deltas.values()):
        return {"quality": "register_reset"}
    # Export rounding is 0.001 kWh; actual daily register vs profile observations
    # differ by up to 0.002 kWh. Larger disagreements are an explicit repair.
    if abs(deltas["vt"] + deltas["nt"] - deltas["total"]) > Decimal("0.01") or (
        profile_total is not None
        and abs(deltas["total"] - profile_total) > Decimal("0.01")
    ):
        return {"quality": "reconciliation_failed"}
    return {
        "quality": "measured",
        "resolution": "day",
        **{key: str(value) for key, value in deltas.items()},
    }


def validate_prices(prices):
    schedule = sorted(prices, key=lambda item: item["from"])
    seen = set()
    for index, item in enumerate(schedule):
        first, last = parse_date(item["from"]), parse_date(item["until"])
        if first >= last or (index and schedule[index - 1]["until"] > item["from"]):
            raise ValueError("Overlapping or empty price validity")
        if (
            not item.get("version")
            or item["version"] in seen
            or item.get("currency") != "CZK"
        ):
            raise ValueError("Prices require unique versions and CZK currency")
        seen.add(item["version"])
        for key in ("vt", "nt", "fixed"):
            try:
                value = Decimal(str(item[key]))
            except (InvalidOperation, TypeError) as err:
                raise ValueError("Invalid price") from err
            if not value.is_finite() or value < 0 or value.as_tuple().exponent < -9:
                raise ValueError(
                    "Price must be nonnegative and have at most nine decimal places"
                )
    return schedule


def price_for_day(day, prices):
    return next((item for item in prices if item["from"] <= day < item["until"]), None)


def fixed_hourly(day, price):
    day = parse_date(day)
    start, end = boundary(day), boundary(day + timedelta(days=1))
    next_month = (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    days_in_month = (next_month - day.replace(day=1)).days
    nano = int(Decimal(str(price["fixed"])) / NANO)
    daily = nano * day.day // days_in_month - nano * (day.day - 1) // days_in_month
    count = int((end - start).total_seconds() // 3600)
    return {
        start + timedelta(hours=index): Decimal(
            daily * (index + 1) // count - daily * index // count
        )
        * NANO
        for index in range(count)
    }


def daily_cost(tariffs, price):
    if tariffs["quality"] != "measured" or not price:
        return None
    return {
        key: Decimal(tariffs[key]) * Decimal(str(price[key])) for key in ("vt", "nt")
    }


def cumulative_rows(increments, baseline=Decimal(0)):
    """Recorder upserts by hour; sums include only validated interval deltas."""
    total = Decimal(str(baseline))
    rows = []
    for instant, delta in sorted(increments.items()):
        if not delta.is_finite() or delta < 0:
            raise MeasurementError("Invalid statistic increment")
        total += delta
        rows.append({"start": instant, "state": float(total), "sum": float(total)})
    return rows
