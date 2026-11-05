import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { planImportDates, parseImportDate, runImport } from "../src/backfill.js";
import { syntheticProfile } from "./fixtures/pnd.js";

const now = DateTime.fromISO("2026-11-05T10:00:00", { zone: "Europe/Prague" });
const config = { timezone: "Europe/Prague", backfillFrom: "", addToEnergyDashboard: false };
const logger = { debug() {}, info() {}, warn() {} };

function fixture(initial = {}, options = {}) {
  let state = structuredClone(initial);
  let saved = 0;
  let imports = 0;
  let closed = 0;
  const requested = [];
  const rows = new Map(options.rows ?? []);
  const client = {
    async connect() {},
    async getLatestSum(id, end) {
      return [...rows.entries()].filter(([start]) => Date.parse(start) < Date.parse(end))
        .sort(([a], [b]) => Date.parse(a) - Date.parse(b)).at(-1)?.[1].sum ?? 0;
    },
    async importStatistics(metadata, stats) {
      imports += 1;
      for (const row of stats) rows.set(row.start, structuredClone(row));
      if (options.ambiguousFailure) {
        options.ambiguousFailure = false;
        throw new Error("Connection lost after HA committed the import");
      }
    },
    close() { closed += 1; },
  };
  const args = {
    config: { ...config, ...options.config },
    now, logger,
    stateStore: {
      async load() { return structuredClone(state); },
      async save(next) {
        if (options.saveFailure) { options.saveFailure = false; throw new Error("State write failed"); }
        saved += 1;
        state = structuredClone(next);
      },
    },
    scraper: {
      async scrapeDate(date) {
        requested.push(date);
        if (options.failDate === date) throw new Error("Portal unavailable");
        return syntheticProfile(date, {
          missing: options.incompleteDate === date ? 1 : -1,
          meterId: options.changedMeterDate === date ? "456" : "123",
        });
      },
    },
    createClient: () => client,
  };
  return { args, rows, requested, state: () => state, saved: () => saved, imports: () => imports, closed: () => closed, options };
}

test("first install imports yesterday only, not unbounded history", () => {
  assert.deepEqual(planImportDates({}, config, now), ["2026-11-04"]);
});

test("an explicit start never skips older days still pending automatic catch-up", () => {
  const dates = planImportDates({ lastImportedDate: "2026-11-01" }, { ...config, backfillFrom: "2026-11-04" }, now);
  assert.deepEqual(dates, ["2026-11-02", "2026-11-03", "2026-11-04"]);
});

test("rejects a profile for the wrong requested day before any HA writes", async () => {
  const f = fixture({ lastImportedDate: "2026-11-03" });
  f.args.scraper.scrapeDate = async () => syntheticProfile("2026-11-03");
  await assert.rejects(runImport(f.args), /different day/);
  assert.equal(f.imports(), 0);
});

test("a complete zero-consumption day is backfilled normally", async () => {
  const f = fixture({ lastImportedDate: "2026-11-03" });
  f.args.scraper.scrapeDate = async (date) => syntheticProfile(date, { powerKw: 0 });
  assert.equal((await runImport(f.args)).cumulativeSum, 0);
  assert.equal(f.rows.size, 24);
  assert.equal(f.state().lastImportedDate, "2026-11-04");
});

test("automatically catches up the October 26 outage in chronological order", async () => {
  const f = fixture({ lastImportedDate: "2026-10-25" });
  const result = await runImport(f.args);
  assert.equal(result.days, 10);
  assert.equal(result.hours, 240);
  assert.equal(f.requested[0], "2026-10-26");
  assert.equal(f.requested.at(-1), "2026-11-04");
  assert.equal(f.state().lastImportedDate, "2026-11-04");
  assert.equal(f.state().cumulativeSum, 240);
  assert.equal(f.imports(), 1);
  assert.equal(f.closed(), 1);
  await runImport(f.args);
  assert.equal(f.imports(), 1);
});

test("explicit older backfill rewrites later sums and retains the preceding baseline", async () => {
  const baseline = { start: "2026-10-24T21:00:00.000Z", sum: 100, state: 100 };
  const f = fixture({ lastImportedDate: "2026-11-04", statisticId: "cez_pnd:consumption_123", meterId: "123" }, {
    config: { backfillFrom: "2026-10-25" },
    rows: [[baseline.start, baseline], ["2026-11-04T22:00:00.000Z", { sum: 110, state: 110 }]],
  });
  const result = await runImport(f.args);
  assert.equal(result.hours, 265); // 25-hour DST day + ten normal days
  assert.equal(result.cumulativeSum, 365);
  assert.deepEqual(f.rows.get(baseline.start), baseline);
  assert.equal(f.rows.size, 266);
  assert.equal(f.rows.get("2026-11-04T22:00:00.000Z").sum, 365);
  assert.equal(f.state().completedBackfillFrom, "2026-10-25");
  await runImport(f.args);
  assert.equal(f.imports(), 1, "completed explicit range is not replayed on every restart");
  f.args.now = now.plus({ days: 1 });
  await runImport(f.args);
  assert.equal(f.requested.at(-1), "2026-11-05");
  assert.equal(f.state().cumulativeSum, 389);
});

test("no history/state is modified when any day has incomplete measurements", async () => {
  const initial = { lastImportedDate: "2026-10-25", cumulativeSum: 50 };
  const f = fixture(initial, { incompleteDate: "2026-10-28" });
  await assert.rejects(runImport(f.args), /95\/96 intervals/);
  assert.equal(f.imports(), 0);
  assert.equal(f.saved(), 0);
  assert.deepEqual(f.state(), initial);
  f.options.incompleteDate = null;
  await runImport(f.args);
  assert.equal(f.state().lastImportedDate, "2026-11-04");
});

test("portal failure mid-range does not skip days or advance the checkpoint", async () => {
  const f = fixture({ lastImportedDate: "2026-10-25" }, { failDate: "2026-10-27" });
  await assert.rejects(runImport(f.args), /Portal unavailable/);
  assert.equal(f.imports(), 0);
  assert.equal(f.state().lastImportedDate, "2026-10-25");
});

for (const failure of ["ambiguousFailure", "saveFailure"]) {
  test(`retry after ${failure} is an idempotent upsert, not double counting`, async () => {
    const f = fixture({ lastImportedDate: "2026-11-03" }, { [failure]: true });
    await assert.rejects(runImport(f.args));
    assert.equal(f.state().lastImportedDate, "2026-11-03");
    assert.equal(f.rows.size, 24);
    await runImport(f.args);
    assert.equal(f.rows.size, 24);
    assert.equal(f.state().cumulativeSum, 24);
    assert.equal(f.imports(), 2);
    assert.equal(f.closed(), 2);
  });
}

test("handles spring DST and year boundaries as local calendar days", async () => {
  const f = fixture({ lastImportedDate: "2026-03-28" });
  f.args.now = DateTime.fromISO("2026-03-31", { zone: config.timezone });
  const result = await runImport(f.args);
  assert.equal(result.hours, 47);
  assert.equal(result.cumulativeSum, 47);
  assert.deepEqual(planImportDates({ lastImportedDate: "2025-12-30" }, config,
    DateTime.fromISO("2026-01-02", { zone: config.timezone })), ["2025-12-31", "2026-01-01"]);
});

test("rejects invalid/future dates before scraping or writing", () => {
  for (const date of ["2026-02-30", "26.10.2026", "2026-1-01", "2026-10-26T00:00:00"]) {
    assert.throws(() => parseImportDate(date), /Invalid import date/);
  }
  assert.throws(() => planImportDates({}, { ...config, backfillFrom: "2026-11-05" }, now), /yesterday or earlier/);
  assert.throws(() => planImportDates({ lastImportedDate: "2026-11-06" }, config, now), /ahead of yesterday/);
});

test("refuses to combine different meters or statistic IDs", async () => {
  const changed = fixture({ lastImportedDate: "2026-11-02" }, { changedMeterDate: "2026-11-04" });
  await assert.rejects(runImport(changed.args), /meter changed/);
  assert.equal(changed.imports(), 0);
  const mismatch = fixture({ lastImportedDate: "2026-11-03", statisticId: "cez_pnd:other" });
  await assert.rejects(runImport(mismatch.args), /differs from saved/);
  assert.equal(mismatch.imports(), 0);
});

test("abort during preparation prevents all HA writes", async () => {
  const f = fixture({ lastImportedDate: "2026-11-03" });
  f.args.signal = AbortSignal.abort(new Error("Stopping importer"));
  await assert.rejects(runImport(f.args), /Stopping importer/);
  assert.equal(f.imports(), 0);
});

test("clearing the explicit date rearms a later request for the same range", async () => {
  const f = fixture({ lastImportedDate: "2026-11-04", completedBackfillFrom: "2026-11-03" });
  await runImport(f.args);
  assert.equal(f.state().completedBackfillFrom, null);
  f.args.config.backfillFrom = "2026-11-03";
  assert.equal((await runImport(f.args)).days, 2);
});
