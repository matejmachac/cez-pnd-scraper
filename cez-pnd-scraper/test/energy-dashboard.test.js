import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidates,
  ensureEnergyDashboardSource,
  hasStatistic,
} from "../src/energy-dashboard.js";

const statisticId = "cez_pnd:consumption_test";

test("merges consumption into a legacy grid without changing other sources", () => {
  const sources = [
    { type: "grid", flow_from: [{ stat_energy_from: "sensor.existing" }], flow_to: [], cost_adjustment_day: 2 },
    { type: "solar", stat_energy_from: "sensor.solar" },
  ];
  const [candidate] = buildCandidates(sources, statisticId, "ČEZ PND test");
  assert.equal(candidate.schema, "legacy");
  assert.deepEqual(candidate.sources[0].flow_from, [
    { stat_energy_from: "sensor.existing" },
    { stat_energy_from: statisticId },
  ]);
  assert.deepEqual(candidate.sources[1], sources[1]);
  assert.equal(candidate.sources[0].cost_adjustment_day, 2);
});

test("adds a separate source to the unified grid schema", () => {
  const sources = [{ type: "grid", stat_energy_from: "sensor.existing", cost_adjustment_day: 0 }];
  const [candidate] = buildCandidates(sources, statisticId, "ČEZ PND test");
  assert.equal(candidate.schema, "unified");
  assert.equal(candidate.sources.length, 2);
  assert.deepEqual(candidate.sources[1], {
    type: "grid",
    stat_energy_from: statisticId,
    cost_adjustment_day: 0,
    name: "ČEZ PND test",
  });
});

test("recognizes an existing statistic in both schemas", () => {
  assert.equal(hasStatistic([{ type: "grid", stat_energy_from: statisticId }], statisticId), true);
  assert.equal(hasStatistic([{ type: "grid", flow_from: [{ stat_energy_from: statisticId }] }], statisticId), true);
});

test("falls back from legacy to unified schema when an empty dashboard rejects it", async () => {
  const saved = [];
  const client = {
    getEnergyPreferences: async () => null,
    saveEnergySources: async (sources) => {
      saved.push(sources);
      if (saved.length === 1) throw Object.assign(new Error("legacy rejected"), { code: "invalid_format" });
      return { energy_sources: sources };
    },
    validateEnergyDashboard: async () => ({ energy_sources: [] }),
  };
  const result = await ensureEnergyDashboardSource(client, statisticId, "ČEZ PND test");
  assert.equal(result.schema, "unified");
  assert.equal(saved.length, 2);
});

test("is idempotent and does not save an existing source", async () => {
  let saves = 0;
  const client = {
    getEnergyPreferences: async () => ({
      energy_sources: [{ type: "grid", stat_energy_from: statisticId }],
    }),
    saveEnergySources: async () => { saves += 1; },
  };
  const result = await ensureEnergyDashboardSource(client, statisticId, "ČEZ PND test");
  assert.equal(result.changed, false);
  assert.equal(saves, 0);
});
