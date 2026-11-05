import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";

test("loads backfill_from from add-on options and validates environment overrides", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pnd-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const optionsPath = path.join(directory, "options.json");
  const oldToken = process.env.SUPERVISOR_TOKEN;
  const oldFrom = process.env.BACKFILL_FROM;
  t.after(() => {
    for (const [key, value] of [["SUPERVISOR_TOKEN", oldToken], ["BACKFILL_FROM", oldFrom]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.SUPERVISOR_TOKEN = "synthetic";
  delete process.env.BACKFILL_FROM;
  const options = { email: "synthetic@example.com", password: "synthetic" };
  await writeFile(optionsPath, JSON.stringify(options));
  assert.equal((await loadConfig(optionsPath)).backfillFrom, "");
  await writeFile(optionsPath, JSON.stringify({ ...options, backfill_from: "2026-10-26" }));
  assert.equal((await loadConfig(optionsPath)).backfillFrom, "2026-10-26");
  process.env.BACKFILL_FROM = "2026-10-01";
  assert.equal((await loadConfig(optionsPath)).backfillFrom, "2026-10-01");
  process.env.BACKFILL_FROM = "2026-02-30";
  await assert.rejects(loadConfig(optionsPath), /Invalid import date/);
});
