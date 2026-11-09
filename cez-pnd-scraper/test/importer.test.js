import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildHourlyStatistics, IncompleteDayError } from "../src/importer.js";

function completeProfile(date, zone = "Europe/Prague", powerKw = 1) {
  const start = DateTime.fromISO(date, { zone }).startOf("day");
  const end = start.plus({ days: 1 });
  const intervals = [];
  for (let cursor = start.plus({ minutes: 15 }); cursor <= end; cursor = cursor.plus({ minutes: 15 })) {
    intervals.push({ end: cursor.toISO(), endMs: cursor.toMillis(), powerKw });
  }
  return { targetDate: date, intervals };
}

test("aggregates 96 intervals into cumulative hourly statistics", () => {
  const result = buildHourlyStatistics(completeProfile("2026-08-01"), { baseSum: 10 });
  assert.equal(result.intervalCount, 96);
  assert.equal(result.hourCount, 24);
  assert.equal(result.energyKwh, 24);
  assert.equal(result.stats[0].sum, 11);
  assert.equal(result.stats.at(-1).sum, 34);
});

test("accepts DST days with 92 and 100 intervals", () => {
  const spring = buildHourlyStatistics(completeProfile("2026-03-29"));
  const autumn = buildHourlyStatistics(completeProfile("2026-10-25"));
  assert.equal(spring.intervalCount, 92);
  assert.equal(spring.hourCount, 23);
  assert.equal(autumn.intervalCount, 100);
  assert.equal(autumn.hourCount, 25);
});

test("rejects a day with a missing interval but accepts zero power", () => {
  const complete = completeProfile("2026-08-01", "Europe/Prague", 0);
  assert.equal(buildHourlyStatistics(complete).energyKwh, 0);
  complete.intervals.splice(20, 1);
  assert.throws(() => buildHourlyStatistics(complete), IncompleteDayError);
});

test("duplicate, negative and nonfinite intervals never reach Recorder", () => {
  for (const mutate of [
    (profile) => profile.intervals.push(profile.intervals[0]),
    (profile) => { profile.intervals[0].powerKw = -1; },
    (profile) => { profile.intervals[0].powerKw = NaN; },
  ]) {
    const profile = completeProfile("2026-11-01");
    mutate(profile);
    assert.throws(() => buildHourlyStatistics(profile), /duplicate|invalid/);
  }
});
