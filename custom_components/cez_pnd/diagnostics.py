"""Diagnostics deliberately exclude tokens, URLs, meter IDs, and readings."""


async def async_get_config_entry_diagnostics(hass, entry):
    coordinator = entry.runtime_data
    state = coordinator.archive.state
    return {
        "integration_version": "0.6.0",
        "protocol": 1,
        "writer": "native",
        "status": state.get("status"),
        "enabled": state.get("enabled", True),
        "incomplete_priced_days": len(state.get("incomplete_cost_days", [])),
        "unpriced_measured_days": len(state.get("unpriced_days", [])),
        "unpaired_measured_days": len(state.get("unpaired_tariff_days", [])),
        "estimated_days": len(state.get("estimated_days", [])),
        "manual_conflicts": len(state.get("manual_conflicts", [])),
        "archived_days": len(state.get("days", [])),
        "unavailable_days": len(state.get("unavailable_days", [])),
        "missing_days": len(state.get("missing_days", [])),
        "pending_days": len(state.get("pending", {}).get("dates", [])),
        "pending_cursor": state.get("pending", {}).get("cursor"),
        "tariff_quality": state.get("tariff_quality"),
        "cost_quality": state.get("cost_quality"),
        "energy_backup_available": bool(state.get("energy_backup")),
        "retry_count": coordinator.failures,
    }
