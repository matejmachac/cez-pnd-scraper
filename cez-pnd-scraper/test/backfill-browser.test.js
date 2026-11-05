import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";
import { DateTime } from "luxon";
import { PndScraper } from "../src/scraper.js";
import { HomeAssistantClient } from "../src/home-assistant.js";
import { StateStore } from "../src/state-store.js";
import { runImport } from "../src/backfill.js";
import { syntheticCsv } from "./fixtures/pnd.js";

for (const picker of ["editable", "flatpickr"]) {
  test(`synthetic end-to-end historical backfill using ${picker} dates, Chromium, HA WebSocket and disk state`, {
    skip: process.env.PND_BROWSER_TESTS !== "1",
  }, async (t) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "pnd-backfill-browser-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const searched = [];
    const portal = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/data") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        searched.push({ from, to });
        if (from !== to || !/^\d{2}\.\d{2}\.\d{4}$/.test(from)) {
          response.writeHead(400).end();
          return;
        }
        const date = DateTime.fromFormat(from, "dd.MM.yyyy").toISODate();
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(syntheticCsv(date));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`
        <div class="pnd-window">
          <input id="meter-intervalType">
          <div class="multiselect__option" id="yesterday">Včera</div>
          <div class="multiselect__option" id="custom">Vlastní období</div>
          <input id="meter-interval" readonly value="26.10.2026 - 26.10.2026">
          <button>Vyhledat data</button>
        </div>
        <script>
          const input = document.getElementById('meter-interval');
          let range = ['26.10.2026', '26.10.2026'];
          document.getElementById('yesterday').onclick = () => queueMicrotask(() => {
            range = ['26.10.2026', '26.10.2026'];
            input.value = range.join(' - ');
          });
          document.getElementById('custom').onclick = () => queueMicrotask(() => {
            input.readOnly = ${picker === "flatpickr"};
          });
          input.onchange = () => queueMicrotask(() => { range = input.value.split(' - '); });
          ${picker === "flatpickr" ? `input._flatpickr = {
            setDate(dates, triggerChange) {
              if (!triggerChange) throw new Error('Date changes must reach the Vue model');
              range = dates.map(d => [String(d.getDate()).padStart(2,'0'), String(d.getMonth()+1).padStart(2,'0'), d.getFullYear()].join('.'));
              input.value = range.join(' - ');
              input.dispatchEvent(new Event('change', {bubbles:true}));
            },
            close() {}
          };` : ""}
          document.querySelector('button').onclick = async () => {
            const csv = await (await fetch('/data?from=' + range[0] + '&to=' + range[1])).text();
            document.querySelector('a')?.remove();
            const link = document.createElement('a');
            link.textContent = 'CSV';
            link.download = 'data.csv';
            link.href = URL.createObjectURL(new Blob([csv]));
            document.querySelector('.pnd-window').append(link);
          };
        </script>`);
    });
    await new Promise((resolve) => portal.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => portal.close(resolve)));
    const ha = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => ha.once("listening", resolve));
    t.after(() => new Promise((resolve) => ha.close(resolve)));
    const baseline = { start: "2026-10-23T21:00:00.000Z", sum: 100, state: 100 };
    const rows = new Map([[baseline.start, baseline], ["2026-10-26T22:00:00.000Z", { sum: 110, state: 110 }]]);
    let importCount = 0;
    ha.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (data) => {
        const message = JSON.parse(data);
        if (message.type === "auth") {
          socket.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        let result = null;
        if (message.type === "recorder/statistics_during_period") {
          // Include boundary/later rows deliberately: the client must not use
          // any existing hour from the range it is about to replace as a base.
          result = { [message.statistic_ids[0]]: [...rows].map(([start, row]) => ({ start: Date.parse(start), sum: row.sum })) };
        } else if (message.type === "recorder/import_statistics") {
          importCount += 1;
          for (const row of message.stats) rows.set(row.start, row);
        } else {
          throw new Error(`Unexpected synthetic HA command: ${message.type}`);
        }
        socket.send(JSON.stringify({ id: message.id, type: "result", success: true, result }));
      });
    });
    const config = {
      dataDir, timezone: "Europe/Prague", backfillFrom: "2026-10-24", addToEnergyDashboard: false,
      dashboardUrl: `http://127.0.0.1:${portal.address().port}/cezpnd2/external/dashboard/view`,
    };
    const stateStore = new StateStore(path.join(dataDir, "state.json"));
    await stateStore.save({ lastImportedDate: "2026-10-26", statisticId: "cez_pnd:consumption_123", meterId: "123" });
    const logger = { debug() {}, info() {}, warn() {} };
    const args = {
      config, stateStore, logger,
      scraper: new PndScraper(config, logger),
      now: DateTime.fromISO("2026-10-27T10:00:00", { zone: config.timezone }),
      createClient: () => new HomeAssistantClient({ url: `ws://127.0.0.1:${ha.address().port}`, token: "synthetic" }),
    };
    const result = await runImport(args);
    assert.equal(result.days, 3);
    assert.equal(result.hours, 73);
    assert.equal(result.cumulativeSum, 173);
    assert.deepEqual(searched, ["24.10.2026", "25.10.2026", "26.10.2026"].map((date) => ({ from: date, to: date })));
    assert.equal(rows.size, 74);
    assert.equal(rows.get("2026-10-26T22:00:00.000Z").sum, 173);
    assert.deepEqual(rows.get(baseline.start), baseline);
    assert.equal((await stateStore.load()).lastImportedDate, "2026-10-26");
    assert.equal((await stateStore.load()).completedBackfillFrom, "2026-10-24");
    await runImport(args);
    assert.equal(importCount, 1);
  });
}
