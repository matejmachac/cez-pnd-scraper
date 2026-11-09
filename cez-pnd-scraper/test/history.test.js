import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryStore, normalizeProfile } from "../src/history.js";
import { syntheticProfile } from "./fixtures/pnd.js";

test("history survives restart, deduplicates and records corrections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cez-history-"));
  try {
    const store = new HistoryStore(dir, "supply");
    const profile = syntheticProfile("2026-11-01");
    assert.deepEqual(await store.saveProfile(profile), { changed: true, revision: 1 });
    assert.deepEqual(await store.saveProfile(profile), { changed: false, revision: 1 });
    const restarted = new HistoryStore(dir, "supply");
    assert.deepEqual(await restarted.loadProfile(profile.targetDate), profile);
    profile.intervals[0].powerKw = 2;
    assert.deepEqual(await restarted.saveProfile(profile), { changed: true, revision: 2 });
    assert.equal((await restarted.loadProfile(profile.targetDate)).intervals[0].powerKw, 2);
    assert.equal(await restarted.loadProfile("2026-11-02"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("normalization preserves physical meter and UTC without inventing tariff", () => {
  const spring = normalizeProfile(syntheticProfile("2026-03-29"), { supplyPointId: "supply" });
  assert.equal(spring.length, 92);
  assert.equal(spring[0].start, "2026-03-28T23:00:00.000Z");
  assert.equal(spring[0].meterId, "123");
  assert.equal(spring[0].tariff, null);
});

test("pending backfill resumes fetched days after a process restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cez-resume-"));
  try {
    const dates = ["2026-11-01", "2026-11-02"];
    let store = new HistoryStore(dir, "supply");
    await store.beginPlan(dates);
    await store.saveProfile(syntheticProfile(dates[0]));
    await store.checkpoint(dates[0]);
    store = new HistoryStore(dir, "supply");
    await store.beginPlan(dates);
    assert.equal((await store.loadPendingProfile(dates[0])).targetDate, dates[0]);
    assert.equal(await store.loadPendingProfile(dates[1]), null);
    await store.finishPlan();
    await store.beginPlan(dates);
    assert.equal(await store.loadPendingProfile(dates[0]), null, "a new backfill must refresh PND rather than reuse completed data");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
