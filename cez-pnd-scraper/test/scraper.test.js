import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { IncompleteDayError } from "../src/importer.js";
import { PndScraper, waitForSearch } from "../src/scraper.js";

const logger = { info() {}, warn() {} };

function searchPage() {
  const page = new EventEmitter();
  page.waitForTimeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return page;
}

test("waits for a slow search response and removes request listeners", async () => {
  const page = searchPage();
  const request = { resourceType: () => "xhr" };
  let completed = false;
  await waitForSearch(page, async () => {
    page.emit("request", request);
    setTimeout(() => {
      completed = true;
      page.emit("requestfinished", request);
    }, 150);
  }, { quietMs: 10, timeoutMs: 1_000 });
  assert.equal(completed, true);
  assert.deepEqual(page.eventNames(), []);
});

test("rejects failed HTTP searches instead of downloading stale CSV", async () => {
  const page = searchPage();
  const request = { resourceType: () => "fetch" };
  await assert.rejects(waitForSearch(page, async () => {
    page.emit("request", request);
    page.emit("response", { request: () => request, status: () => 503 });
    page.emit("requestfinished", request);
  }), /HTTP 503/);
  assert.deepEqual(page.eventNames(), []);
});

test("bounds searches that never finish and cleans up listeners", async () => {
  const page = searchPage();
  await assert.rejects(waitForSearch(page, async () => {
    page.emit("request", { resourceType: () => "xhr" });
  }, { timeoutMs: 50 }), /timeout/);
  assert.deepEqual(page.eventNames(), []);
});

test("propagates search click failures without leaving listeners", async () => {
  const page = searchPage();
  await assert.rejects(waitForSearch(page, async () => {
    throw new Error("Search disabled");
  }), /Search disabled/);
  assert.deepEqual(page.eventNames(), []);
});

async function sessionFixture(t, error) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pnd-session-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "browser-state.json"), "{}");
  const contexts = [];
  let browserClosed = false;
  const browserType = {
    async launch() {
      return {
        async newContext(options) {
          const context = {
            options,
            closed: false,
            storageStateCalls: 0,
            async newPage() {
              return {
                async goto() {},
                async waitForURL() {},
                async screenshot() {},
              };
            },
            async storageState({ path: file }) {
              this.storageStateCalls += 1;
              await writeFile(file, "{}");
            },
            async close() { this.closed = true; },
          };
          contexts.push(context);
          return context;
        },
        async close() { browserClosed = true; },
      };
    },
  };
  const scraper = new PndScraper({ dataDir, timezone: "Europe/Prague" }, logger, browserType);
  scraper.loginIfRequired = async () => {};
  scraper.findExportWindow = async () => {
    if (contexts.length === 1 || error.always) throw error;
    return "data-intervalType";
  };
  scraper.selectYesterdayAndSearch = async () => {};
  scraper.downloadCsv = async () => {
    const start = DateTime.fromISO("2026-10-26", { zone: "Europe/Prague" });
    return '"Datum";"+A/123 [kW]";"Status"\n' + Array.from({ length: 96 }, (_, i) =>
      `"${start.plus({ minutes: (i + 1) * 15 }).toFormat("dd.MM.yyyy HH:mm:ss")}";1;"naměřená data OK"`,
    ).join("\n");
  };
  return { scraper, contexts, dataDir, browserClosed: () => browserClosed };
}

test("a dashboard with missing windows gets exactly one clean-session retry", async (t) => {
  const fixture = await sessionFixture(t, new Error("No PND data window"));
  const profile = await fixture.scraper.scrapeYesterday(DateTime.fromISO("2026-10-27"));
  assert.equal(profile.intervals.length, 96);
  assert.ok(fixture.contexts[0].options.storageState);
  assert.equal(fixture.contexts[1].options.storageState, undefined);
  assert.ok(fixture.contexts.every((context) => context.closed));
  assert.equal(fixture.browserClosed(), true);
  assert.equal(await readFile(path.join(fixture.dataDir, "browser-state.json"), "utf8"), "{}");
});

test("a permanent portal failure does not cause an unlimited login loop", async (t) => {
  const error = Object.assign(new Error("No PND data window"), { always: true });
  const fixture = await sessionFixture(t, error);
  await assert.rejects(fixture.scraper.scrapeYesterday(), /No PND data window/);
  assert.equal(fixture.contexts.length, 2);
  assert.ok(fixture.contexts.every((context) => context.closed));
  assert.equal(fixture.browserClosed(), true);
});

test("genuinely incomplete measurements do not trigger another sign-in", async (t) => {
  const fixture = await sessionFixture(t, new IncompleteDayError("2026-10-26", 96, 1, ["00:30"]));
  await assert.rejects(fixture.scraper.scrapeYesterday(), IncompleteDayError);
  assert.equal(fixture.contexts.length, 1);
  assert.equal(fixture.browserClosed(), true);
});

test("partial CSV is rejected before saving a browser session", async (t) => {
  const fixture = await sessionFixture(t, new Error("unused"));
  fixture.scraper.findExportWindow = async () => "data-intervalType";
  fixture.scraper.downloadCsv = async () => '"Datum";"+A/123 [kW]";"Status"\n"26.10.2026 00:15";1;"naměřená data OK"';
  await assert.rejects(
    fixture.scraper.scrapeYesterday(DateTime.fromISO("2026-10-27")),
    /1\/96 intervals/,
  );
  assert.equal(fixture.contexts.length, 1);
  assert.equal(fixture.contexts[0].storageStateCalls, 0);
});
