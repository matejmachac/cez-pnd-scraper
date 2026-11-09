"""ČEZ PND: native Energy integration with existing browser transport."""

from datetime import timedelta
import probatio as vol
from homeassistant.const import Platform
from homeassistant.core import SupportsResponse
from homeassistant.exceptions import (
    ConfigEntryAuthFailed,
    ConfigEntryNotReady,
    HomeAssistantError,
)
from homeassistant.util import dt as dt_util
from .api import TransportAuthError, TransportError
from .const import DOMAIN
from .coordinator import PndCoordinator
from .energy import EnergyConfiguration
from .model import PRAGUE, parse_date
from .storage import Archive


async def async_setup_entry(hass, entry):
    coordinator = PndCoordinator(hass, entry)
    try:
        await coordinator.async_initialize()
    except TransportAuthError as err:
        raise ConfigEntryAuthFailed(
            "PND transport authentication requires attention"
        ) from err
    except TransportError as err:
        raise ConfigEntryNotReady("PND transport is unavailable") from err
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.SENSOR])
    entry.async_on_unload(entry.add_update_listener(_options_updated))
    _register_services(hass)
    if coordinator.archive.state.get("enabled", True):
        coordinator.start()
    return True


async def _options_updated(hass, entry):
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass, entry):
    await entry.runtime_data.shutdown()
    return await hass.config_entries.async_unload_platforms(entry, [Platform.SENSOR])


async def async_remove_entry(hass, entry):
    archive = Archive(hass, entry.entry_id)
    await archive.load()
    archive.state["enabled"] = False
    await archive.save()
    # Retain historical measurements and all Recorder data for export/reinstall.
    await EnergyConfiguration(hass, archive).rollback()


async def async_migrate_entry(hass, entry):
    # Version 1 is the initial native schema. Never reinterpret an unknown newer
    # version or delete stored measurements during integration upgrades.
    return entry.version == 1


def _register_services(hass):
    if hass.services.has_service(DOMAIN, "backfill"):
        return
    schema = vol.Schema(
        {
            vol.Optional("entry_id"): str,
            vol.Optional("start"): str,
            vol.Optional("end"): str,
        }
    )

    def coordinator_for(call):
        entries = [
            entry
            for entry in hass.config_entries.async_loaded_entries(DOMAIN)
            if getattr(entry, "runtime_data", None)
        ]
        if call.data.get("entry_id"):
            entries = [
                entry for entry in entries if entry.entry_id == call.data["entry_id"]
            ]
        if len(entries) != 1:
            raise HomeAssistantError("Select exactly one loaded ČEZ PND integration")
        return entries[0].runtime_data

    def period(call, coordinator):
        end = call.data.get(
            "end",
            (
                dt_util.utcnow().astimezone(PRAGUE).date() - timedelta(days=1)
            ).isoformat(),
        )
        start = call.data.get(
            "start",
            coordinator.entry.options.get(
                "history_start", coordinator.entry.data["history_start"]
            ),
        )
        if (
            parse_date(start) > parse_date(end)
            or parse_date(end) >= dt_util.utcnow().astimezone(PRAGUE).date()
        ):
            raise HomeAssistantError("Select a valid completed-day period")
        return start, end

    async def backfill(call):
        coordinator = coordinator_for(call)
        start, end = period(call, coordinator)
        if coordinator.archive.state.get("enabled", True):
            coordinator.start(start, end)
        else:
            await coordinator.resume(start, end)

    async def reprice(call):
        coordinator = coordinator_for(call)
        await coordinator.reprice(*period(call, coordinator))

    async def rollback(call):
        await coordinator_for(call).rollback()

    async def resume(call):
        await coordinator_for(call).resume()

    async def export_history(call):
        coordinator = coordinator_for(call)
        start, end = period(call, coordinator)
        return {
            "schema_version": 1,
            "days": await coordinator.archive.export(start, end),
        }

    hass.services.async_register(DOMAIN, "backfill", backfill, schema=schema)
    hass.services.async_register(DOMAIN, "recalculate_costs", reprice, schema=schema)
    hass.services.async_register(
        DOMAIN, "rollback", rollback, schema=vol.Schema({vol.Optional("entry_id"): str})
    )
    hass.services.async_register(
        DOMAIN, "resume", resume, schema=vol.Schema({vol.Optional("entry_id"): str})
    )
    hass.services.async_register(
        DOMAIN,
        "export_history",
        export_history,
        schema=schema,
        supports_response=SupportsResponse.ONLY,
    )
