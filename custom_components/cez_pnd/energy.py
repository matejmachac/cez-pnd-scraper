"""Idempotent migration through EnergyManager with owned-field rollback."""

from copy import deepcopy
from homeassistant.components.energy.data import async_get_manager, ENERGY_SOURCE_SCHEMA
from homeassistant.components.energy.validate import async_validate


class EnergyConflictError(RuntimeError):
    """An automatic edit could double-count or overwrite user changes."""


class EnergyConfiguration:
    def __init__(self, hass, archive):
        self.hass = hass
        self.archive = archive

    async def configure(self, energy_id, cost_id=None, *, replace_source=None):
        manager = await async_get_manager(self.hass)
        preferences = deepcopy(manager.data or manager.default_preferences())
        sources = deepcopy(preferences["energy_sources"])
        matches = [
            index
            for index, source in enumerate(sources)
            if source.get("stat_energy_from") == energy_id
        ]
        if not matches and replace_source and replace_source != "none":
            matches = [
                index
                for index, source in enumerate(sources)
                if source.get("type") == "grid"
                and source.get("stat_energy_from") == replace_source
            ]
            if len(matches) != 1:
                raise EnergyConflictError(
                    "The explicitly selected old grid source was not found"
                )
        if len(matches) > 1:
            raise EnergyConflictError(
                "The PND statistic is already counted more than once"
            )
        if not matches and any(
            source.get("type") == "grid"
            and (source.get("stat_energy_from") or source.get("flow_from"))
            for source in sources
        ):
            raise EnergyConflictError(
                "An existing grid source needs an explicit migration mapping"
            )
        index = matches[0] if matches else len(sources)
        old = deepcopy(sources[index]) if matches else None
        desired = deepcopy(
            old
            or {
                "type": "grid",
                "name": "ČEZ PND Dubnice",
                "stat_energy_from": energy_id,
                "cost_adjustment_day": 0,
            }
        )
        desired["stat_energy_from"] = energy_id
        if cost_id:
            desired.update(
                stat_cost=cost_id,
                entity_energy_price=None,
                number_energy_price=None,
                cost_adjustment_day=0,
            )
        desired = ENERGY_SOURCE_SCHEMA([desired])[0]
        if old == desired:
            return
        backup = self.archive.state.get("energy_backup")
        if backup is None:
            backup = {
                "preferences": preferences,
                "old": old,
                "applied": desired,
                "energy_id": energy_id,
            }
            self.archive.state["energy_backup"] = backup
        else:
            backup["applied"] = desired
        await self.archive.save()  # Must precede every external configuration mutation.
        if matches:
            sources[index] = desired
        else:
            sources.append(desired)
        await manager.async_update({"energy_sources": sources})
        validation = await async_validate(self.hass)
        if validation.energy_sources[index].issues:
            # Restore only the exact source version written above, not the full
            # preference snapshot: unrelated user changes must survive.
            await self._restore(desired, old, energy_id)
            raise EnergyConflictError(
                "Energy validation reported issues for the PND source"
            )

    async def _restore(self, applied, old, energy_id):
        manager = await async_get_manager(self.hass)
        sources = deepcopy((manager.data or {}).get("energy_sources", []))
        indices = [
            index
            for index, source in enumerate(sources)
            if source.get("stat_energy_from") == energy_id
        ]
        if not indices:
            return
        if len(indices) != 1 or sources[indices[0]] != applied:
            raise EnergyConflictError(
                "PND Energy source has been edited since migration"
            )
        index = indices[0]
        if old is None:
            sources.pop(index)
        else:
            sources[index] = old
        await manager.async_update({"energy_sources": sources})

    async def rollback(self):
        backup = self.archive.state.get("energy_backup")
        if backup:
            await self._restore(backup["applied"], backup["old"], backup["energy_id"])
