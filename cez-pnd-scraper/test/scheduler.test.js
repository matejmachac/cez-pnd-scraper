import test from "node:test";
import assert from "node:assert/strict";
import { nextAlignedRun, retryDelayMs } from "../src/scheduler.js";

test("aligns runs to three minutes after each quarter", () => {
  const now = Date.parse("2026-08-09T10:04:00Z");
  assert.equal(
    new Date(nextAlignedRun(now, 15, 3)).toISOString(),
    "2026-08-09T10:18:00.000Z",
  );
});

test("caps exponential retries at the normal interval", () => {
  assert.equal(retryDelayMs(1, 15), 60_000);
  assert.equal(retryDelayMs(4, 15), 480_000);
  assert.equal(retryDelayMs(10, 15), 900_000);
});
