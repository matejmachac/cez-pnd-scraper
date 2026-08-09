import { DateTime } from "luxon";

const INTERVAL_MS = 15 * 60_000;

export function buildHourlyStatistics(profile, {
  timezone = "Europe/Prague",
  baseSum = 0,
} = {}) {
  const dayStart = DateTime.fromISO(profile.targetDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  const expected = [];
  for (let cursor = dayStart.plus({ minutes: 15 }); cursor <= dayEnd; cursor = cursor.plus({ minutes: 15 })) {
    expected.push(cursor.toMillis());
  }

  const byEnd = new Map(profile.intervals.map((interval) => [interval.endMs, interval]));
  const missing = expected.filter((timestamp) => !byEnd.has(timestamp));
  if (missing.length > 0) {
    const preview = missing.slice(0, 4).map((timestamp) =>
      DateTime.fromMillis(timestamp, { zone: timezone }).toFormat("HH:mm ZZZZ"),
    );
    throw new IncompleteDayError(profile.targetDate, expected.length, byEnd.size, preview);
  }

  const hourlyEnergy = new Map();
  for (const endMs of expected) {
    const interval = byEnd.get(endMs);
    const hourStartMs = Math.floor((endMs - INTERVAL_MS) / 3_600_000) * 3_600_000;
    hourlyEnergy.set(hourStartMs, (hourlyEnergy.get(hourStartMs) ?? 0) + interval.powerKw * 0.25);
  }

  let cumulative = Number(baseSum);
  const stats = [...hourlyEnergy.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startMs, energyKwh]) => {
      cumulative = round(cumulative + energyKwh);
      return {
        start: DateTime.fromMillis(startMs, { zone: "utc" }).toISO(),
        state: cumulative,
        sum: cumulative,
      };
    });

  return {
    stats,
    intervalCount: expected.length,
    hourCount: stats.length,
    energyKwh: round(cumulative - Number(baseSum)),
    cumulativeSum: cumulative,
  };
}

export function createStatisticMetadata(statisticId, name) {
  return {
    has_sum: true,
    mean_type: 0,
    name,
    source: statisticId.split(":", 1)[0],
    statistic_id: statisticId,
    unit_class: "energy",
    unit_of_measurement: "kWh",
  };
}

export function defaultStatisticId(meterId) {
  const safe = String(meterId || "default").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `cez_pnd:consumption_${safe}`;
}

export class IncompleteDayError extends Error {
  constructor(date, expected, actual, missing) {
    super(`PND day ${date} is incomplete: ${actual}/${expected} intervals; missing ${missing.join(", ")}`);
    this.name = "IncompleteDayError";
  }
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1e9) / 1e9;
}
