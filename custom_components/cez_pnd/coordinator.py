"""Durable acquisition, correction replay, and native Recorder publication."""

import asyncio
from contextlib import suppress
from datetime import timedelta
from decimal import Decimal
import logging
import re
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util
from .api import (
    PndTransport,
    TransportError,
    TransportAuthError,
    IncompleteMeasurement,
    UnavailablePeriod,
)
from .const import DOMAIN, DEFAULT_PRICES
from .energy import EnergyConfiguration, EnergyConflictError
from .model import (
    PRAGUE,
    boundary,
    parse_date,
    normalise_profile,
    hourly_energy,
    daily_tariffs,
    validate_prices,
    price_for_day,
    fixed_hourly,
    daily_cost,
    MeasurementError,
    timestamp,
)
from .statistics import StatisticsWriter
from .storage import Archive

_LOGGER = logging.getLogger(__name__)


class PndCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry):
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name="ČEZ PND",
            update_interval=timedelta(hours=12),
        )
        self.entry = entry
        self.archive = Archive(hass, entry.entry_id)
        self.api = PndTransport(
            async_get_clientsession(hass), entry.data["url"], entry.data["token"]
        )
        self.writer = StatisticsWriter(hass)
        self.energy = EnergyConfiguration(hass, self.archive)
        self.lock = asyncio.Lock()
        self.task = None
        self.closed = False
        self.failures = 0
        self.monthly = False
        self.bundles = {}
        self.supply_point = entry.data["supply_point"]
        slug = re.sub(r"[^a-z0-9_]+", "_", self.supply_point.lower()).strip("_")
        self.ids = {
            key: f"{DOMAIN}:{slug}_{key}"
            for key in (
                "import_vt",
                "import_nt",
                "cost_vt",
                "cost_nt",
                "cost_fixed",
                "cost_total",
            )
        }
        self.ids["import_total"] = entry.data["statistic_id"]

    @property
    def prices(self):
        return validate_prices(self.entry.options.get("prices", DEFAULT_PRICES))

    async def async_initialize(self):
        await self.archive.load()
        if not self.archive.state.get("enabled", True):
            self._notify("disabled")
            return
        info = (
            await self.api.info()
        )  # Reject a still-running legacy writer before publication.
        self.monthly = "month" in info.get("capabilities", [])
        self._notify("idle")

    def _issue(self, key, active, message=None):
        issue_id = f"{self.entry.entry_id}_{key}"
        if active:
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                issue_id,
                is_fixable=key in ("energy_configuration", "price_data"),
                severity=ir.IssueSeverity.WARNING,
                translation_key=key,
                translation_placeholders={"detail": message or key},
                config_entry_id=self.entry.entry_id,
            )
        else:
            ir.async_delete_issue(self.hass, DOMAIN, issue_id)

    def _notify(self, status=None):
        state = self.archive.state
        if status:
            state["status"] = status
        self.async_set_updated_data({**state, "statistic_ids": self.ids})

    def start(self, start=None, end=None, *, refresh=True):
        if not self.archive.state.get("enabled", True) or self.closed:
            raise HomeAssistantError("The native PND import is disabled")
        if self.task and not self.task.done():
            raise HomeAssistantError("PND synchronization is already running")
        self.task = self.entry.async_create_background_task(
            self.hass,
            self._run_with_retry(start, end, refresh=refresh),
            "PND historical synchronization",
        )

    async def _run_with_retry(self, start, end, *, refresh):
        while not self.closed and self.archive.state.get("enabled", True):
            try:
                await self.synchronize(start, end, refresh=refresh)
                self.failures = 0
                return
            except TransportAuthError:
                self._notify("authentication_required")
                self._issue("authentication", True)
                self.entry.async_start_reauth(self.hass)
                await self.archive.save()
                return
            except asyncio.CancelledError:
                raise
            except (
                TransportError,
                OSError,
                ValueError,
                KeyError,
                TypeError,
                RuntimeError,
            ) as err:
                self.failures += 1
                self._notify("retrying")
                self._issue("synchronization", True, type(err).__name__)
                await self.archive.save()
                # Error messages from remote responses are intentionally excluded.
                _LOGGER.warning(
                    "PND synchronization failed (%s); retrying", type(err).__name__
                )
                await asyncio.sleep(min(60 * 2 ** min(self.failures - 1, 8), 21600))

    async def _async_update_data(self):
        if (
            not self.closed
            and self.archive.state.get("enabled", True)
            and (not self.task or self.task.done())
        ):
            self.start()
        return {**self.archive.state, "statistic_ids": self.ids}

    def _dates(self, start, end):
        first, last = parse_date(start), parse_date(end)
        return [
            (first + timedelta(days=index)).isoformat()
            for index in range((last - first).days + 1)
        ]

    async def _profile(self, day):
        if not self.monthly:
            return await self.api.get("profile", date=day)
        month = day[:7]
        if month not in self.bundles:
            if len(self.bundles) >= 2:
                self.bundles.pop(next(iter(self.bundles)))
            try:
                self.bundles[month] = await self.api.get("month", month=month)
            except UnavailablePeriod:
                self.bundles[month] = None
        if self.bundles[month] is None:
            raise UnavailablePeriod("PND month has no measured source")
        bundle = self.bundles[month]
        if not bundle["from"] <= day <= bundle["through"]:
            raise MeasurementError("PND month returned a different requested period")
        if day not in bundle["profiles"]:
            raise IncompleteMeasurement("PND month contains an incomplete day")
        profile = dict(bundle["profiles"][day])
        end = boundary(parse_date(day) + timedelta(days=1))
        profile["registers"] = [
            row for row in bundle["registers"] if timestamp(row["timestamp"]) == end
        ]
        return profile

    async def _registers(self, day):
        if self.monthly:
            for bundle in self.bundles.values():
                if bundle is not None and bundle["from"] <= day <= bundle["through"]:
                    end = boundary(parse_date(day) + timedelta(days=1))
                    return [
                        row
                        for row in bundle["registers"]
                        if timestamp(row["timestamp"]) == end
                    ]
        return await self.api.get("registers", date=day)

    async def synchronize(self, start=None, end=None, *, refresh=True):
        if self.lock.locked():
            raise HomeAssistantError("PND synchronization is already running")
        async with self.lock:
            if not self.archive.state.get("enabled", True):
                return
            await self.api.info()
            self.bundles.clear()  # Every new sync must observe source corrections.
            state = self.archive.state
            yesterday = dt_util.utcnow().astimezone(PRAGUE).date() - timedelta(days=1)
            end = end or yesterday.isoformat()
            if parse_date(end) > yesterday:
                raise HomeAssistantError(
                    "Only completed Prague calendar days may be imported"
                )
            if start:
                if parse_date(start) > parse_date(end):
                    raise HomeAssistantError("The backfill period is reversed")
                dates = self._dates(start, end)
            elif state.get("pending"):
                dates = state["pending"]["dates"]
            elif not state.get("days") and not state.get("last_checked_day"):
                dates = self._dates(
                    self.entry.options.get(
                        "history_start", self.entry.data["history_start"]
                    ),
                    end,
                )
                dates.reverse()  # Make recent data usable before a long first backfill completes.
            else:
                last = parse_date(state.get("last_checked_day") or max(state["days"]))
                first = max(
                    parse_date(min(state.get("days") or [last.isoformat()])),
                    last
                    - timedelta(days=self.entry.options.get("correction_days", 7) - 1),
                )
                dates = self._dates(first.isoformat(), end)
                # Prioritize recent gaps, so an empty pre-activation prefix
                # cannot starve actual outages within measured history.
                dates = sorted(set(dates + state.get("missing_days", [])[-14:]))
            if not dates:
                return
            pending = state.get("pending")
            if not pending or pending["dates"] != dates:
                pending = state["pending"] = {
                    "dates": dates,
                    "cursor": 0,
                    "dirty_from": None,
                }
            self._notify("acquiring")
            await self.archive.save()
            for index in range(pending["cursor"], len(dates)):
                if self.closed or not state.get("enabled", True):
                    return
                day = dates[index]
                try:
                    profile = await self._profile(day)
                    if profile.get("targetDate") != day:
                        raise MeasurementError("PND returned a different day")
                    intervals = normalise_profile(profile, self.supply_point)
                    previous_day = (parse_date(day) - timedelta(days=1)).isoformat()
                    previous = await self.archive.get(previous_day)
                    # A fresh month bundle is authoritative for both boundaries;
                    # archived opening values may predate a source correction.
                    opening = (
                        previous.get("registers", [])
                        if previous and not self.monthly
                        else []
                    )
                    if not opening:
                        try:
                            opening = await self._registers(previous_day)
                        except IncompleteMeasurement:
                            opening = []
                    registers = profile.get("registers", [])
                    physical = {interval["meter_id"] for interval in intervals}
                    if len(physical) == 1:
                        meter = next(iter(physical))
                        registers = [
                            row for row in registers if row["meterId"] == meter
                        ]
                        opening = [row for row in opening if row["meterId"] == meter]
                        if not opening:
                            try:
                                opening = [
                                    row
                                    for row in await self._registers(previous_day)
                                    if row["meterId"] == meter
                                ]
                            except IncompleteMeasurement:
                                opening = []
                        tariffs = daily_tariffs(
                            day,
                            opening,
                            registers,
                            sum(hourly_energy(intervals).values(), Decimal(0)),
                        )
                    else:
                        tariffs = {"quality": "meter_changed"}
                    changed = await self.archive.put(
                        day,
                        {
                            "intervals": intervals,
                            "registers": registers,
                            "opening_registers": opening,
                            "tariffs": tariffs,
                            "meter_id": profile["meterId"],
                        },
                    )
                    if changed or refresh:
                        pending["dirty_from"] = min(day, pending["dirty_from"] or day)
                    if day in state.get("missing_days", []):
                        state["missing_days"].remove(day)
                    if day in state.get("unavailable_days", []):
                        state["unavailable_days"].remove(day)
                    state["last_measurement"] = max(
                        intervals[-1]["end"],
                        state.get("last_measurement", intervals[-1]["end"]),
                    )
                except UnavailablePeriod:
                    unavailable = state.setdefault("unavailable_days", [])
                    if day not in unavailable:
                        unavailable.append(day)
                        unavailable.sort()
                    if day in state.get("missing_days", []):
                        state["missing_days"].remove(day)
                except IncompleteMeasurement:
                    missing = state.setdefault("missing_days", [])
                    if day not in missing:
                        missing.append(day)
                        missing.sort()
                    # Fixed fees accrue even if the measurement export is
                    # incomplete. The variable/total cost remains unknown.
                    pending["dirty_from"] = min(day, pending["dirty_from"] or day)
                pending["cursor"] = index + 1
                await self.archive.save()
                # Publish small durable batches rather than keep an entire
                # three-year backfill in memory or delay the first visible data.
                if (index + 1) % 7 == 0 or index == len(dates) - 1:
                    if pending["dirty_from"]:
                        self._notify("publishing")
                        await self.publish(
                            pending["dirty_from"], max([day, *state.get("days", [])])
                        )
                        pending["dirty_from"] = None
                        await self.archive.save()
                        self._notify("acquiring")
            # A restart after acquisition but before publication leaves cursor
            # at len(dates). The dirty range still must be published.
            if pending["dirty_from"]:
                await self.publish(
                    pending["dirty_from"], max([max(dates), *state.get("days", [])])
                )
            state.pop("pending", None)
            state["last_success"] = dt_util.utcnow().isoformat()
            state["last_checked_day"] = max(end, state.get("last_checked_day", end))
            self._issue(
                "missing_measurements",
                bool(state.get("missing_days")),
                str(len(state.get("missing_days", []))),
            )
            self._issue("synchronization", False)
            self._issue("authentication", False)
            self._notify("idle")
            await self.archive.save()

    async def publish(self, start, end):
        """Replay later cumulative sums in bounded, verified Recorder batches."""
        state = self.archive.state
        if not state.get("enabled", True) or self.closed:
            raise HomeAssistantError("The native PND import is disabled")
        await (
            self.api.info()
        )  # Recheck ownership even when measurements came from cache.
        baselines = await self.writer.baselines(self.ids.values(), boundary(start))
        increments = {key: {} for key in self.ids}
        cost_ready = False
        unknown_tariffs, unpriced, unknown_cost_days = [], [], []
        last_profile = None
        for day in self._dates(start, end):
            item = await self.archive.get(day)
            price = price_for_day(day, self.prices)
            fixed = fixed_hourly(day, price) if price else {}
            increments["cost_fixed"].update(fixed)
            if item is None:
                unknown_tariffs.append(day)
                if price:
                    unknown_cost_days.append(day)
                increments["cost_total"].update(fixed)
                continue
            energy = hourly_energy(item["intervals"])
            increments["import_total"].update(energy)
            last_profile = day
            tariffs = item["tariffs"]
            settlement = max(energy)
            # Actual daily snapshots, not an invented hourly tariff curve.
            if tariffs["quality"] == "measured":
                for tariff in ("vt", "nt"):
                    increments[f"import_{tariff}"][settlement] = Decimal(
                        tariffs[tariff]
                    )
            else:
                unknown_tariffs.append(day)
            charges = daily_cost(tariffs, price)
            if not price:
                unpriced.append(day)
            elif charges is None:
                unknown_cost_days.append(day)
            elif charges is not None:
                cost_ready = True
                for tariff in ("vt", "nt"):
                    increments[f"cost_{tariff}"][settlement] = charges[tariff]
                total = dict(fixed)
                total[settlement] += charges["vt"] + charges["nt"]
                increments["cost_total"].update(total)
            if price and charges is None:
                increments["cost_total"].update(fixed)
        # At most 744 hours per Recorder job. A crash leaves the acquisition
        # journal dirty; retry starts from the sum strictly before this range.
        for key, values in increments.items():
            ordered = sorted(values.items())
            for offset in range(0, len(ordered), 744):
                baselines[self.ids[key]] = await self.writer.write(
                    self.ids[key],
                    dict(ordered[offset : offset + 744]),
                    baselines[self.ids[key]],
                    cost=key.startswith("cost_"),
                )
        if last_profile:
            state["last_published"] = last_profile
        state["totals"] = {
            key: float(baselines[stat_id]) for key, stat_id in self.ids.items()
        }
        state["tariff_quality"] = (
            "daily_measured" if not unknown_tariffs else "incomplete"
        )
        # Cost attachment follows the latest completed price period. A gap in
        # an older price period must not hide a fully measured current period.
        coverage_end = max([end, *state.get("days", [])])
        current_price = price_for_day(coverage_end, self.prices)
        coverage_start = min([start, *state.get("days", [])])
        incomplete_cost_days = []
        for day in self._dates(coverage_start, coverage_end):
            if price_for_day(day, self.prices):
                item = await self.archive.get(day)
                if item is None or item["tariffs"]["quality"] != "measured":
                    incomplete_cost_days.append(day)
        state["incomplete_cost_days"] = incomplete_cost_days
        active_gaps = [
            day
            for day in incomplete_cost_days
            if current_price and day >= current_price["from"]
        ]
        state["cost_quality"] = (
            "daily_settlement"
            if current_price and cost_ready and not active_gaps
            else "incomplete"
        )
        # Repairs describe the entire retained history, not only the latest
        # correction batch. A recent priced day must not hide older unknown costs.
        state["unpriced_days"] = [
            day for day in state.get("days", []) if not price_for_day(day, self.prices)
        ]
        state["unpaired_tariff_days"] = [
            day
            for day in state.get("days", [])
            if (item := await self.archive.get(day))
            and item["tariffs"]["quality"] != "measured"
        ]
        await self.archive.save()  # All expected hours were read back from Recorder.
        self._issue(
            "tariff_data",
            bool(state["unpaired_tariff_days"]),
            str(len(state["unpaired_tariff_days"])),
        )
        self._issue(
            "price_data", bool(state["unpriced_days"]), str(len(state["unpriced_days"]))
        )
        try:
            if state.get("last_published"):
                await self.energy.configure(
                    self.ids["import_total"],
                    self.ids["cost_total"]
                    if state["cost_quality"] == "daily_settlement"
                    else None,
                    replace_source=self.entry.options.get("replace_source"),
                )
            self._issue("energy_configuration", False)
        except EnergyConflictError:
            self._issue("energy_configuration", True)

    async def reprice(self, start, end):
        if self.lock.locked():
            raise HomeAssistantError("PND synchronization is already running")
        async with self.lock:
            # All later cumulative cost sums must be replayed as well.
            await self.publish(start, max([end, *self.archive.state.get("days", [])]))
            self._notify("idle")

    async def shutdown(self):
        self.closed = True
        if self.task and not self.task.done():
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    async def rollback(self):
        self.archive.state["enabled"] = False
        await self.archive.save()
        await self.shutdown()
        await self.energy.rollback()
        self._notify("disabled")

    async def resume(self, start=None, end=None):
        info = await self.api.info()  # Never resume while the legacy writer is active.
        self.monthly = "month" in info.get("capabilities", [])
        self.archive.state["enabled"] = True
        self.closed = False
        await self.archive.save()
        self._notify("idle")
        self.start(start, end)
