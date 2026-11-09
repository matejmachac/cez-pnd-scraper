from datetime import datetime, UTC
import json
from pathlib import Path
from homeassistant.exceptions import HomeAssistantError
from decimal import Decimal
import pytest
from homeassistant.components.energy.data import async_get_manager
from custom_components.cez_pnd.manual import build_estimates
from custom_components.cez_pnd.model import normalise_profile, MeasurementError
from test_native_model import profile
from test_native_lifecycle import simple_entry


def anchor(day, vt, nt, meter="synthetic"):
    return {
        "boundary": day,
        "vt": str(vt),
        "nt": str(nt),
        "meter_id": meter,
        "source": {"kind": "manual_test"},
    }


def raw(day, vt=None, nt=None, power=1):
    return {
        "intervals": normalise_profile(profile(day, power=power), "manual"),
        "tariffs": {"quality": "measured", "vt": str(vt), "nt": str(nt)}
        if vt is not None
        else {"quality": "tariff_unavailable"},
        "registers": [],
        "opening_registers": [],
        "meter_id": "synthetic",
    }


def test_calendar_averages_zero_dst_and_meter_replacement():
    anchors = [
        anchor("2026-03-28", 100, 0),
        anchor("2026-03-31", 106, 30),
        anchor("2026-03-31", 3, 0, "new"),
        anchor("2026-04-02", 5, 10, "new"),
    ]
    days, conflicts = build_estimates(anchors, {})
    assert conflicts == []
    assert len(days) == 5
    assert [Decimal(days[d]["daily_kwh"]) for d in sorted(days)] == [12, 12, 12, 6, 6]
    assert (
        days["2026-03-29"]["intervals"] == []
    )  # No invented quarter-hours on a DST day.
    assert days["2026-03-31"]["meter_id"] == "new"
    zeros, _ = build_estimates(
        [anchor("2025-01-01", 0, 0), anchor("2025-01-21", 735, 0)], {}
    )
    assert all(item["tariffs"]["nt"] == "0E-9" for item in zeros.values())


def test_pnd_profile_and_tariffs_have_priority_and_residuals_are_exact():
    anchors = [anchor("2026-04-01", 0, 0), anchor("2026-04-06", 40, 80)]
    measured = {"2026-04-03": raw("2026-04-03", 4, 20), "2026-04-04": raw("2026-04-04")}
    days, conflicts = build_estimates(anchors, measured)
    assert not conflicts
    assert "2026-04-03" not in days
    assert Decimal(days["2026-04-04"]["daily_kwh"]) == 24
    assert days["2026-04-04"]["provenance"]["preserved_pnd_profile"]
    assert sum(Decimal(item["tariffs"]["vt"]) for item in days.values()) + 4 == 40
    assert sum(Decimal(item["tariffs"]["nt"]) for item in days.values()) + 20 == 80
    conflicts_days, conflicts = build_estimates(
        [anchor("2026-04-03", 0, 0), anchor("2026-04-04", 1, 1)],
        {"2026-04-03": measured["2026-04-03"]},
    )
    assert not conflicts_days and conflicts
    with pytest.raises(MeasurementError):
        build_estimates(
            [anchor("2026-04-01", 100, 100), anchor("2026-04-02", 0, 0)], {}
        )


@pytest.mark.asyncio
async def test_actual_recorder_manual_import_repeat_correction_reload_and_disable(
    hass, monkeypatch
):
    entry, _ = await simple_entry(hass, monkeypatch, "manual")
    coordinator = entry.runtime_data
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    original_energy = coordinator.data["totals"]["import_total"]
    original_cost = coordinator.data["totals"]["cost_total"]
    pnd_before = await coordinator.archive.measured("2026-11-07")
    payload = {
        "schema_version": 1,
        "supply_point": "manual",
        "source": {"file_sha256": "anonymized"},
        "anchors": [anchor("2026-11-05", 0, 0), anchor("2026-11-09", 16, 80)],
    }
    Path(hass.config.path("manual.json")).write_text(json.dumps(payload))
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            "cez_pnd",
            "import_manual_history",
            {"file": "../outside.json"},
            blocking=True,
        )
    await hass.services.async_call(
        "cez_pnd", "import_manual_history", {"file": "manual.json"}, blocking=True
    )
    assert coordinator.data["totals"]["import_total"] == 96
    assert coordinator.data["tariff_quality"] == "daily_measured_and_estimated"
    assert coordinator.data["cost_quality"] == "daily_settlement_with_estimates"
    assert len(coordinator.data["estimated_days"]) == 2
    assert await coordinator.archive.measured("2026-11-07") == pnd_before
    assert (await coordinator.archive.get("2026-11-05"))["intervals"] == []
    manager = await async_get_manager(hass)
    assert "odhady" in manager.data["energy_sources"][0]["name"]
    first = dict(coordinator.data["totals"])
    await coordinator.import_manual(payload)
    assert coordinator.data["totals"] == first
    # An authoritative PND day replaces one estimate; remaining residual days
    # change without changing the source interval's sum or existing PND values.
    await coordinator.synchronize("2026-11-06", "2026-11-06")
    assert coordinator.data["totals"]["import_total"] == 96
    assert coordinator.data["estimated_days"] == ["2026-11-05"]
    await hass.config_entries.async_reload(entry.entry_id)
    coordinator = entry.runtime_data
    await coordinator.reprice("2026-11-05", "2026-11-08")
    assert coordinator.data["totals"]["import_total"] == 96
    rows = await coordinator.writer.query(
        [coordinator.ids["import_total"]],
        datetime(2026, 11, 4, tzinfo=UTC),
        datetime(2026, 11, 9, tzinfo=UTC),
    )
    assert (
        len(rows[coordinator.ids["import_total"]]) == 73
    )  # 3 measured days + 1 daily snapshot.
    await coordinator.disable_manual()
    assert coordinator.data["totals"]["import_total"] == original_energy + 24
    assert coordinator.data["estimated_days"] == []
    assert coordinator.data["totals"]["cost_total"] > original_cost
    assert "odhady" not in manager.data["energy_sources"][0]["name"]
