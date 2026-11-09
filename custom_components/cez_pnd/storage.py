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
        self.manual_months = {}

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

    async def measured(self, day):
        return (await self.month(day)).get(day)

    async def manual_month(self, day):
        key = day[:7]
        if key not in self.manual_months:
            self.manual_months[key] = (
                await Store(self.hass, 1, f"{self.key}.manual.{key}").async_load() or {}
            )
        return self.manual_months[key]

    async def get(self, day):
        measured = await self.measured(day)
        manual = (await self.manual_month(day)).get(day)
        if measured:
            if manual and measured["tariffs"]["quality"] != "measured":
                from .model import hourly_energy
                from decimal import Decimal

                total = sum(hourly_energy(measured["intervals"]).values(), Decimal(0))
                if abs(total - Decimal(manual["daily_kwh"])) <= Decimal("0.000000001"):
                    return {
                        **measured,
                        "tariffs": manual["tariffs"],
                        "estimated_tariff_provenance": manual["provenance"],
                    }
            return measured
        return manual

    async def replace_manual(self, days):
        old_days = self.state.get("manual_days", [])
        changed = []
        for month in sorted({day[:7] for day in [*old_days, *days]}):
            old = await self.manual_month(month + "-01")
            new = {day: item for day, item in days.items() if day.startswith(month)}
            changed.extend(
                day for day in set(old) | set(new) if old.get(day) != new.get(day)
            )
            if old != new:
                await Store(self.hass, 1, f"{self.key}.manual.{month}").async_save(new)
                self.manual_months[month] = new
        measured = [
            day for day in self.state.get("days", []) if await self.measured(day)
        ]
        self.state["pnd_days"] = measured
        self.state["manual_days"] = sorted(days)
        self.state["days"] = sorted(set(measured) | set(days))
        await self.save()
        return min(changed) if changed else None

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
