from datetime import date, timedelta
from decimal import Decimal
import pytest
from custom_components.cez_pnd.model import (
    boundary,
    normalise_profile,
    hourly_energy,
    daily_tariffs,
    fixed_hourly,
    validate_prices,
    price_for_day,
    cumulative_rows,
    MeasurementError,
)
from custom_components.cez_pnd.const import DEFAULT_PRICES


def profile(day, power=1, meter="synthetic"):
    start, end = boundary(day), boundary(date.fromisoformat(day) + timedelta(days=1))
    count = int((end - start).total_seconds() // 900)
    return {
        "targetDate": day,
        "meterId": meter,
        "intervals": [
            {
                "endMs": int(
                    (start + timedelta(minutes=15 * (index + 1))).timestamp() * 1000
                ),
                "powerKw": power,
            }
            for index in range(count)
        ],
    }


def registers(day, total, nt, vt, meter="synthetic"):
    return [
        {
            "register": key,
            "kwh": value,
            "meterId": meter,
            "timestamp": boundary(
                date.fromisoformat(day) + timedelta(days=1)
            ).isoformat(),
            "quality": "measured",
        }
        for key, value in [("total", total), ("nt", nt), ("vt", vt)]
    ]


@pytest.mark.parametrize(
    "day,hours", [("2026-03-29", 23), ("2026-10-25", 25), ("2026-11-08", 24)]
)
def test_dst_and_complete_profile(day, hours):
    intervals = normalise_profile(profile(day), "supply")
    assert len(intervals) == hours * 4
    assert sum(hourly_energy(intervals).values()) == hours
    assert len(cumulative_rows(hourly_energy(intervals))) == hours
    assert intervals[0]["tariff"] is None
    broken = profile(day)
    broken["intervals"][1] = broken["intervals"][0]
    with pytest.raises(MeasurementError):
        normalise_profile(broken, "supply")


@pytest.mark.parametrize("month", [3, 10, 11, 12])
def test_fixed_exact_month(month):
    price = {**DEFAULT_PRICES[0], "from": "2026-01-01"}
    day = date(2026, month, 1)
    total = Decimal(0)
    while day.month == month:
        total += sum(fixed_hourly(day.isoformat(), price).values())
        day += timedelta(days=1)
    assert total == Decimal("842")


def test_actual_daily_tariff_values_and_replacement():
    before = registers("2026-11-07", 2236.796, 1870.517, 366.279)
    after = registers("2026-11-08", 2288.142, 1916.703, 371.439)
    result = daily_tariffs("2026-11-08", before, after, Decimal("51.346"))
    assert result == {
        "quality": "measured",
        "resolution": "day",
        "total": "51.346",
        "vt": "5.160",
        "nt": "46.186",
    }
    assert (
        daily_tariffs(
            "2026-11-08", before, registers("2026-11-08", 1, 1, 0, meter="replacement")
        )["quality"]
        == "meter_changed"
    )
    assert (
        daily_tariffs("2026-11-08", before, registers("2026-11-08", 1, 1, 0))["quality"]
        == "register_reset"
    )
    assert (
        daily_tariffs("2026-11-08", before, after, Decimal("100"))["quality"]
        == "reconciliation_failed"
    )


def test_prices_never_escape_their_validity():
    prices = validate_prices(DEFAULT_PRICES)
    assert price_for_day("2025-11-01", prices) is None
    assert price_for_day("2027-01-01", prices) is None
    with pytest.raises(ValueError):
        validate_prices([*prices, {**prices[0], "version": "overlap"}])
