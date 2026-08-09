import test from "node:test";
import assert from "node:assert/strict";
import { millisecondsUntilDailyWindow, nextDailyRun } from "../src/scheduler.js";

test("schedules the same local day before the configured time", () => {
  const now = Date.parse("2026-08-09T03:00:00Z");
  assert.equal(
    new Date(nextDailyRun(now, 6, 30, "Europe/Prague")).toISOString(),
    "2026-08-09T04:30:00.000Z",
  );
});

test("schedules tomorrow after the configured time", () => {
  const now = Date.parse("2026-08-09T07:00:00Z");
  assert.equal(
    new Date(nextDailyRun(now, 6, 30, "Europe/Prague")).toISOString(),
    "2026-08-10T04:30:00.000Z",
  );
});

test("does not allow an immediate startup import before the daily window", () => {
  assert.equal(
    millisecondsUntilDailyWindow(Date.parse("2026-08-09T00:00:00Z"), 6, 30, "Europe/Prague"),
    4.5 * 60 * 60_000,
  );
  assert.equal(
    millisecondsUntilDailyWindow(Date.parse("2026-08-09T07:00:00Z"), 6, 30, "Europe/Prague"),
    0,
  );
});
