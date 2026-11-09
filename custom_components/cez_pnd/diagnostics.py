"""Diagnostics deliberately exclude tokens, URLs, meter IDs, and readings."""


async def async_get_config_entry_diagnostics(hass, entry):
    coordinator = entry.runtime_data
    state = coordinator.archive.state
    return {
        "integration_version": "0.5.0",
        "protocol": 1,
        "writer": "native",
        "status": state.get("status"),
        "enabled": state.get("enabled", True),
        "archived_days": len(state.get("days", [])),
        "missing_days": len(state.get("missing_days", [])),
        "pending_days": len(state.get("pending", {}).get("dates", [])),
        "pending_cursor": state.get("pending", {}).get("cursor"),
        "tariff_quality": state.get("tariff_quality"),
        "cost_quality": state.get("cost_quality"),
        "energy_backup_available": bool(state.get("energy_backup")),
        "retry_count": coordinator.failures,
    }
