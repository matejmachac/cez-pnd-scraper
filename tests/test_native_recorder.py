from datetime import datetime, UTC, timedelta
from decimal import Decimal
import pytest
from homeassistant.components.energy.data import async_get_manager
from custom_components.cez_pnd.statistics import StatisticsWriter
from custom_components.cez_pnd.storage import Archive
from custom_components.cez_pnd.energy import EnergyConfiguration, EnergyConflictError


@pytest.mark.asyncio
async def test_actual_recorder_upsert_correction_and_baseline(hass):
    writer = StatisticsWriter(hass)
    first = datetime(2026, 11, 1, tzinfo=UTC)
    increments = {first + timedelta(hours=index): Decimal("1") for index in range(48)}
    assert await writer.write("cez_pnd:test_import_total", increments, Decimal(0)) == 48
    assert await writer.write("cez_pnd:test_import_total", increments, Decimal(0)) == 48
    increments[first] = Decimal("2")
    assert await writer.write("cez_pnd:test_import_total", increments, Decimal(0)) == 49
    rows = await writer.query(
        ["cez_pnd:test_import_total"], first, first + timedelta(hours=48)
    )
    assert len(rows["cez_pnd:test_import_total"]) == 48
    baseline = await writer.baselines(
        ["cez_pnd:test_import_total"], first + timedelta(hours=24)
    )
    assert baseline["cez_pnd:test_import_total"] == 25


@pytest.mark.asyncio
async def test_actual_energy_migration_and_rollback_preserve_other_sources(hass):
    writer = StatisticsWriter(hass)
    instant = datetime(2026, 11, 1, tzinfo=UTC)
    await writer.write("cez_pnd:existing", {instant: Decimal("1")}, Decimal(0))
    await writer.write(
        "cez_pnd:test_cost_total", {instant: Decimal("5")}, Decimal(0), cost=True
    )
    manager = await async_get_manager(hass)
    existing = {
        "type": "grid",
        "name": "Old PND",
        "stat_energy_from": "cez_pnd:existing",
        "cost_adjustment_day": 0,
    }
    solar = {"type": "solar", "stat_energy_from": "cez_pnd:unrelated_solar"}
    await manager.async_update({"energy_sources": [existing, solar]})
    archive = Archive(hass, "test")
    await archive.load()
    energy = EnergyConfiguration(hass, archive)
    await energy.configure("cez_pnd:existing", "cez_pnd:test_cost_total")
    assert manager.data["energy_sources"][0]["stat_cost"] == "cez_pnd:test_cost_total"
    assert manager.data["energy_sources"][1] == solar
    later = {"type": "solar", "stat_energy_from": "cez_pnd:later_solar"}
    await manager.async_update(
        {"energy_sources": [*manager.data["energy_sources"], later]}
    )
    await energy.rollback()
    assert manager.data["energy_sources"] == [existing, solar, later]


@pytest.mark.asyncio
async def test_existing_foreign_grid_is_not_duplicated(hass):
    manager = await async_get_manager(hass)
    original = [
        {"type": "grid", "stat_energy_from": "sensor.foreign", "cost_adjustment_day": 0}
    ]
    await manager.async_update({"energy_sources": original})
    archive = Archive(hass, "test")
    await archive.load()
    with pytest.raises(EnergyConflictError):
        await EnergyConfiguration(hass, archive).configure("cez_pnd:new")
    assert manager.data["energy_sources"] == original


@pytest.mark.asyncio
async def test_explicit_old_source_mapping_is_reversible(hass):
    writer = StatisticsWriter(hass)
    instant = datetime(2026, 11, 1, tzinfo=UTC)
    await writer.write("cez_pnd:replacement", {instant: Decimal("1")}, Decimal(0))
    manager = await async_get_manager(hass)
    old = {
        "type": "grid",
        "stat_energy_from": "sensor.explicit_old_pnd",
        "cost_adjustment_day": 0,
    }
    solar = {"type": "solar", "stat_energy_from": "sensor.unrelated_solar"}
    await manager.async_update({"energy_sources": [old, solar]})
    archive = Archive(hass, "mapping")
    await archive.load()
    energy = EnergyConfiguration(hass, archive)
    await energy.configure(
        "cez_pnd:replacement", replace_source="sensor.explicit_old_pnd"
    )
    assert (
        manager.data["energy_sources"][0]["stat_energy_from"] == "cez_pnd:replacement"
    )
    assert manager.data["energy_sources"][1] == solar
    await energy.rollback()
    assert manager.data["energy_sources"] == [old, solar]
