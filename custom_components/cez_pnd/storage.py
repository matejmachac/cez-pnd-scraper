"""Versioned HA Store archive; no direct Recorder or Energy storage writes."""

import hashlib
import json
from homeassistant.helpers.storage import Store
from .const import DOMAIN


class Archive:
    def __init__(self, hass, entry_id):
        self.hass = hass
        self.key = f"{DOMAIN}.{entry_id}"
        self.state_store = Store(hass, 1, f"{self.key}.state")
        self.state = {}
        self.months = {}

    async def load(self):
        self.state = await self.state_store.async_load() or {
            "version": 1,
            "enabled": True,
            "days": [],
            "missing_days": [],
        }
        return self.state

    async def save(self):
        await self.state_store.async_save(self.state)

    async def month(self, day):
        key = day[:7]
        if key not in self.months:
            self.months[key] = (
                await Store(self.hass, 1, f"{self.key}.history.{key}").async_load()
                or {}
            )
        return self.months[key]

    async def get(self, day):
        return (await self.month(day)).get(day)

    async def put(self, day, data):
        month = await self.month(day)
        digest = hashlib.sha256(
            json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        previous = month.get(day)
        if previous and previous.get("digest") == digest:
            return False
        from homeassistant.util import dt as dt_util

        month[day] = {
            "digest": digest,
            "revision": (previous or {}).get("revision", 0) + 1,
            "fetched_at": dt_util.utcnow().isoformat(),
            "source_corrected_at": None,
            **data,
        }
        await Store(self.hass, 1, f"{self.key}.history.{day[:7]}").async_save(month)
        days = self.state.setdefault("days", [])
        if day not in days:
            days.append(day)
            days.sort()
        await self.save()
        return True

    async def export(self, start, end):
        return {
            day: await self.get(day)
            for day in self.state.get("days", [])
            if start <= day <= end
        }
