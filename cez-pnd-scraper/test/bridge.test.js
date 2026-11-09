import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { DateTime } from "luxon";
import { startHealthServer } from "../src/health.js";
import { createBridge } from "../src/bridge.js";
import { IncompleteDayError } from "../src/importer.js";
const token = "synthetic-bridge-token-with-32-chars";

async function fixture(t, overrides = {}) {
  const status = { stopping: false, running: false };
  const scraper = { scrapeDate: async (date, now, options) => ({ date, options }), scrapeRegistersDate: async () => [] , ...overrides };
  const server = startHealthServer(0, status, createBridge({ config: {
    writerMode: "native", bridgeToken: token, timezone: "Europe/Prague",
  }, stateStore: { load: async () => ({ statisticId: "cez_pnd:existing", meterId: "synthetic" }) }, scraper, status }));
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { get: (path, headers = { Authorization: `Bearer ${token}` }) => fetch(url + path, { headers }), status };
}

test("bridge requires a token, reports ownership, and never exports credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('/v1/info', {})).status, 401);
  const info = await (await f.get('/v1/info')).json();
  assert.equal(info.writerMode, 'native');
  assert.equal(info.statisticId, 'cez_pnd:existing');
  assert.equal(info.token, undefined);
  assert.equal(info.password, undefined);
  assert.equal((await f.get('/health', {})).status, 200);
});
test("bridge validates dates and serializes Chromium acquisition", async (t) => {
  let release;
  let entered;
  const called = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { scrapeDate: async () => { entered(); await pending; return { ok: true }; } });
  const day = DateTime.now().setZone('Europe/Prague').minus({ days: 1 }).toISODate();
  const first = f.get(`/v1/profile?date=${day}`);
  await called;
  assert.equal((await f.get(`/v1/profile?date=${day}`)).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(f.status.running, false);
  assert.equal((await f.get('/v1/profile?date=2099-01-01')).status, 400);
  assert.equal((await f.get('/v1/profile?date=../secret')).status, 400);
});
test("bridge distinguishes incomplete data and auth while suppressing raw errors", async (t) => {
  const day = DateTime.now().setZone('Europe/Prague').minus({ days: 1 }).toISODate();
  const f = await fixture(t, { scrapeDate: async () => { throw new IncompleteDayError(day, 96, 95, []); } });
  assert.equal((await f.get(`/v1/profile?date=${day}`)).status, 422);
  const auth = await fixture(t, { scrapeDate: async () => { const error = new Error('secret'); error.name = 'PndLoginRejectedError'; throw error; } });
  const response = await auth.get(`/v1/profile?date=${day}`);
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes('secret'), false);
});
