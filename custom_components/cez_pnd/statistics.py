"""One writer: official Recorder external hourly statistics API, with readback."""

from datetime import datetime, UTC, timedelta
from decimal import Decimal
import asyncio
from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.models import StatisticMeanType
from homeassistant.components.recorder.statistics import (
    async_add_external_statistics,
    statistics_during_period,
)
from .model import cumulative_rows


class RecorderMismatchError(RuntimeError):
    """Recorder did not persist the expected statistics."""


class StatisticsWriter:
    def __init__(self, hass):
        self.hass = hass

    async def query(self, ids, start, end):
        return await get_instance(self.hass).async_add_executor_job(
            statistics_during_period,
            self.hass,
            start,
            end,
            set(ids),
            "hour",
            None,
            {"sum", "state"},
        )

    async def baselines(self, ids, before):
        rows = await self.query(ids, datetime(1970, 1, 1, tzinfo=UTC), before)
        result = {}
        for stat_id in ids:
            prior = [
                row
                for row in rows.get(stat_id, [])
                if row["start"] < before.timestamp() and row.get("sum") is not None
            ]
            result[stat_id] = Decimal(str(prior[-1]["sum"])) if prior else Decimal(0)
        return result

    async def write(
        self, statistic_id, increments, baseline, *, cost=False, estimated=False
    ):
        if not increments:
            return baseline
        rows = cumulative_rows(increments, baseline)
        metadata = {
            "has_sum": True,
            "mean_type": StatisticMeanType.NONE,
            "name": f"ČEZ PND {statistic_id.split(':')[1]}"
            + (" (včetně denních odhadů)" if estimated else ""),
            "source": "cez_pnd",
            "statistic_id": statistic_id,
            "unit_class": None if cost else "energy",
            "unit_of_measurement": "CZK" if cost else "kWh",
        }
        async_add_external_statistics(self.hass, metadata, rows)
        await get_instance(self.hass).async_block_till_done()
        # A queue can be empty while an external import is still executing in
        # its separate transaction. Bounded readback also covers that commit
        # visibility race; never advance a checkpoint based on queueing alone.
        deadline = asyncio.get_running_loop().time() + 10
        while True:
            observed = await self.query(
                [statistic_id], rows[0]["start"], rows[-1]["start"] + timedelta(hours=1)
            )
            actual = {row["start"]: row for row in observed.get(statistic_id, [])}
            if all(
                (row := actual.get(expected["start"].timestamp())) is not None
                and row.get("sum") is not None
                and abs(row["sum"] - expected["sum"]) <= 1e-6
                for expected in rows
            ):
                break
            if asyncio.get_running_loop().time() >= deadline:
                raise RecorderMismatchError(
                    "Recorder readback did not match an imported hour"
                )
            await asyncio.sleep(0.1)
        return Decimal(str(rows[-1]["sum"]))
