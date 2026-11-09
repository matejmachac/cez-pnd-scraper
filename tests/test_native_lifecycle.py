from datetime import date, datetime, UTC
import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.components.energy.data import async_get_manager
from custom_components.cez_pnd.api import PndTransport
from custom_components.cez_pnd.coordinator import PndCoordinator
from custom_components.cez_pnd.const import DOMAIN
from custom_components.cez_pnd.diagnostics import async_get_config_entry_diagnostics
from test_native_model import profile, registers


@pytest.mark.asyncio
async def test_native_setup_history_correction_restart_and_remove(hass, monkeypatch):
    correction = {"active": False}

    async def info(self):
        return {
            "protocol": 1,
            "writerMode": "native",
            "statisticId": "cez_pnd:existing",
        }

    async def get(self, path, **params):
        day = params["date"]
        elapsed = (date.fromisoformat(day) - date(2026, 11, 6)).days
        extra = 1 if correction["active"] and elapsed >= 1 else 0
        reads = registers(
            day, 24 * (elapsed + extra), 20 * (elapsed + extra), 4 * (elapsed + extra)
        )
        if path == "registers":
            return reads
        data = profile(
            day, power=2 if correction["active"] and day == "2026-11-07" else 1
        )
        data["registers"] = reads
        return data

    monkeypatch.setattr(PndTransport, "info", info)
    monkeypatch.setattr(PndTransport, "get", get)
    # Invoke the job explicitly so assertions never depend on wall-clock timing.
    monkeypatch.setattr(PndCoordinator, "start", lambda *args, **kwargs: None)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": "user"},
        data={
            "url": "http://synthetic:8099",
            "token": "synthetic-private-token",
            "supply_point": "test",
            "history_start": "2026-11-07",
            "statistic_id": "",
        },
    )
    assert result["type"] == "create_entry", result
    entry = result["result"]
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    coordinator = entry.runtime_data
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    assert coordinator.data["totals"]["import_total"] == 48
    assert coordinator.data["totals"]["import_vt"] == 8
    assert coordinator.data["totals"]["import_nt"] == 40
    assert coordinator.data["cost_quality"] == "daily_settlement"
    manager = await async_get_manager(hass)
    assert len(manager.data["energy_sources"]) == 1
    assert manager.data["energy_sources"][0]["stat_cost"] == "cez_pnd:test_cost_total"
    first_cost = coordinator.data["totals"]["cost_total"]
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    assert coordinator.data["totals"]["cost_total"] == first_cost
    correction["active"] = True
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    assert coordinator.data["totals"]["import_total"] == 72
    assert (
        coordinator.data["totals"]["import_vt"]
        + coordinator.data["totals"]["import_nt"]
        == 72
    )
    corrected_cost = coordinator.data["totals"]["cost_total"]
    assert corrected_cost > first_cost
    rows = await coordinator.writer.query(
        [coordinator.ids["import_total"]],
        datetime(2026, 11, 6, tzinfo=UTC),
        datetime(2026, 11, 9, tzinfo=UTC),
    )
    assert len(rows[coordinator.ids["import_total"]]) == 48
    diagnostics = await async_get_config_entry_diagnostics(hass, entry)
    assert "synthetic-private-token" not in str(diagnostics)
    assert "synthetic" not in str(diagnostics)
    assert (
        len(
            [
                state
                for state in hass.states.async_all("sensor")
                if state.entity_id.startswith("sensor.cez_pnd")
            ]
        )
        == 13
    )
    assert all(
        state.attributes.get("state_class") is None
        for state in hass.states.async_all("sensor")
        if state.entity_id.startswith("sensor.cez_pnd")
    )
    await hass.config_entries.async_reload(entry.entry_id)
    assert entry.state is ConfigEntryState.LOADED
    restarted = entry.runtime_data
    await restarted.synchronize("2026-11-07", "2026-11-08")
    assert restarted.data["totals"]["cost_total"] == corrected_cost
    await hass.config_entries.async_remove(entry.entry_id)
    assert manager.data["energy_sources"] == []
    remaining = await restarted.writer.query(
        [restarted.ids["import_total"]],
        datetime(2026, 11, 6, tzinfo=UTC),
        datetime(2026, 11, 9, tzinfo=UTC),
    )
    assert len(remaining[restarted.ids["import_total"]]) == 48


@pytest.mark.asyncio
async def test_incomplete_day_has_fixed_cost_but_never_invented_energy(
    hass, monkeypatch
):
    from custom_components.cez_pnd.api import IncompleteMeasurement

    async def info(self):
        return {
            "protocol": 1,
            "writerMode": "native",
            "statisticId": "cez_pnd:missing_test",
        }

    async def get(self, path, **params):
        day = params["date"]
        if path == "profile" and day == "2026-11-07":
            raise IncompleteMeasurement("incomplete")
        reads = registers(day, 0, 0, 0)
        if path == "registers":
            return reads
        return {**profile(day, power=0), "registers": reads}

    monkeypatch.setattr(PndTransport, "info", info)
    monkeypatch.setattr(PndTransport, "get", get)
    monkeypatch.setattr(PndCoordinator, "start", lambda *args, **kwargs: None)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": "user"},
        data={
            "url": "http://synthetic:8099",
            "token": "synthetic-token",
            "supply_point": "missing",
            "history_start": "2026-11-07",
            "statistic_id": "",
        },
    )
    entry = result["result"]
    await hass.async_block_till_done()
    coordinator = entry.runtime_data
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    assert coordinator.data["missing_days"] == ["2026-11-07"]
    assert coordinator.data["totals"]["import_total"] == 0
    assert abs(coordinator.data["totals"]["cost_fixed"] - 842 / 30 * 2) < 1e-8
    assert coordinator.data["cost_quality"] == "incomplete"
    manager = await async_get_manager(hass)
    assert not manager.data["energy_sources"][0].get("stat_cost")


@pytest.mark.asyncio
async def test_monthly_acquisition_reuses_one_export_and_keeps_daily_validation(
    hass, monkeypatch
):
    calls = []

    async def info(self):
        return {
            "protocol": 1,
            "writerMode": "native",
            "statisticId": "cez_pnd:monthly",
            "capabilities": ["month"],
        }

    async def get(self, path, **params):
        calls.append(path)
        assert path == "month"
        return {
            "from": "2026-11-06",
            "through": "2026-11-08",
            "profiles": {day: profile(day) for day in ["2026-11-07", "2026-11-08"]},
            "registers": sum(
                [
                    registers(day, 24 * index, 20 * index, 4 * index)
                    for index, day in enumerate(
                        ["2026-11-06", "2026-11-07", "2026-11-08"]
                    )
                ],
                [],
            ),
        }

    monkeypatch.setattr(PndTransport, "info", info)
    monkeypatch.setattr(PndTransport, "get", get)
    monkeypatch.setattr(PndCoordinator, "start", lambda *args, **kwargs: None)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": "user"},
        data={
            "url": "http://synthetic:8099",
            "token": "synthetic-token",
            "supply_point": "monthly",
            "history_start": "2026-11-07",
            "statistic_id": "",
        },
    )
    entry = result["result"]
    await hass.async_block_till_done()
    await entry.runtime_data.synchronize("2026-11-07", "2026-11-08")
    assert calls == ["month"]
    assert entry.runtime_data.data["totals"]["import_total"] == 48
    assert entry.runtime_data.data["tariff_quality"] == "daily_measured"


async def simple_entry(hass, monkeypatch, point):
    calls = []

    async def info(self):
        return {
            "protocol": 1,
            "writerMode": "native",
            "statisticId": f"cez_pnd:{point}_total",
        }

    async def get(self, path, **params):
        calls.append(path)
        day = params["date"]
        index = (date.fromisoformat(day) - date(2026, 11, 6)).days
        reads = registers(day, 24 * index, 20 * index, 4 * index)
        return reads if path == "registers" else {**profile(day), "registers": reads}

    monkeypatch.setattr(PndTransport, "info", info)
    monkeypatch.setattr(PndTransport, "get", get)
    monkeypatch.setattr(PndCoordinator, "start", lambda *args, **kwargs: None)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": "user"},
        data={
            "url": "http://synthetic:8099",
            "token": "synthetic-token",
            "supply_point": point,
            "history_start": "2026-11-07",
            "statistic_id": "",
        },
    )
    await hass.async_block_till_done()
    return result["result"], calls


@pytest.mark.asyncio
async def test_restart_after_acquisition_replays_dirty_checkpoint_without_refetch(
    hass, monkeypatch
):
    entry, calls = await simple_entry(hass, monkeypatch, "checkpoint")

    async def fail(*args, **kwargs):
        raise RuntimeError("Interrupted before Recorder commit")

    monkeypatch.setattr(entry.runtime_data.writer, "write", fail)
    with pytest.raises(RuntimeError):
        await entry.runtime_data.synchronize("2026-11-07", "2026-11-08")
    assert entry.runtime_data.archive.state["pending"]["cursor"] == 2
    assert calls.count("profile") == 2
    await hass.config_entries.async_reload(entry.entry_id)
    await entry.runtime_data.synchronize()
    assert calls.count("profile") == 2
    assert entry.runtime_data.data["totals"]["import_total"] == 48
    assert "pending" not in entry.runtime_data.archive.state


@pytest.mark.asyncio
async def test_options_price_change_preserves_prior_day_and_reprices_later_sums(
    hass, monkeypatch
):
    entry, _ = await simple_entry(hass, monkeypatch, "prices")
    coordinator = entry.runtime_data
    await coordinator.synchronize("2026-11-07", "2026-11-08")
    old = await coordinator.writer.query(
        [coordinator.ids["cost_total"]],
        datetime(2026, 11, 6, 23, tzinfo=UTC),
        datetime(2026, 11, 7, 23, tzinfo=UTC),
    )
    old_day = old[coordinator.ids["cost_total"]]
    options = await hass.config_entries.options.async_init(
        entry.entry_id,
        data={
            "history_start": "2026-11-07",
            "correction_days": 7,
            "update_price": True,
            "price_from": "2026-11-08",
            "price_until": "2026-12-01",
            "price_vt": "5",
            "price_nt": "4",
            "price_fixed": "900",
        },
    )
    assert options["type"] == "create_entry"
    await hass.async_block_till_done()
    coordinator = entry.runtime_data
    await coordinator.reprice("2026-11-07", "2026-11-08")
    again = await coordinator.writer.query(
        [coordinator.ids["cost_total"]],
        datetime(2026, 11, 6, 23, tzinfo=UTC),
        datetime(2026, 11, 7, 23, tzinfo=UTC),
    )
    assert again[coordinator.ids["cost_total"]] == old_day
    # The second day is 4*5 + 20*4 CZK variable plus 900/30 fixed.
    assert (
        abs(coordinator.data["totals"]["cost_total"] - old_day[-1]["sum"] - 130) < 1e-8
    )


@pytest.mark.asyncio
async def test_source_auth_failure_creates_native_reauth_flow(hass, monkeypatch):
    from custom_components.cez_pnd.api import TransportAuthError

    entry, _ = await simple_entry(hass, monkeypatch, "auth")

    async def rejected(*args, **kwargs):
        raise TransportAuthError("Rejected")

    monkeypatch.setattr(PndTransport, "get", rejected)
    await entry.runtime_data._run_with_retry("2026-11-07", "2026-11-08", refresh=True)
    assert entry.runtime_data.data["status"] == "authentication_required"
    await hass.async_block_till_done()
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert any(flow["context"].get("source") == "reauth" for flow in flows)


@pytest.mark.asyncio
async def test_rollback_stays_disabled_when_legacy_transport_resumes(hass, monkeypatch):
    from custom_components.cez_pnd.api import TransportError

    entry, _ = await simple_entry(hass, monkeypatch, "rollback")
    await entry.runtime_data.synchronize("2026-11-07", "2026-11-08")
    await entry.runtime_data.rollback()

    async def legacy(*args, **kwargs):
        raise TransportError("Legacy writer is active; native endpoint is unavailable")

    monkeypatch.setattr(PndTransport, "info", legacy)
    await hass.config_entries.async_reload(entry.entry_id)
    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.data["status"] == "disabled"
    assert entry.runtime_data.archive.state["enabled"] is False
