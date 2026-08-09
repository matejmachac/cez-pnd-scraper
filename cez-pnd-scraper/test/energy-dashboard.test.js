import test from "node:test";
import assert from "node:assert/strict";
import {
  addUnifiedGridSource,
  ensureEnergyDashboardSource,
  hasStatistic,
} from "../src/energy-dashboard.js";

const statisticId = "cez_pnd:consumption_test";

test("adds a unified grid source without changing existing sources", () => {
  const sources = [
    { type: "grid", stat_energy_from: "sensor.existing", cost_adjustment_day: 2 },
    { type: "solar", stat_energy_from: "sensor.solar" },
  ];
  const updated = addUnifiedGridSource(sources, statisticId, "ČEZ PND test");
  assert.deepEqual(updated.slice(0, 2), sources);
  assert.deepEqual(updated[2], {
    type: "grid",
    stat_energy_from: statisticId,
    cost_adjustment_day: 0,
    name: "ČEZ PND test",
  });
});

test("recognizes an existing unified grid statistic", () => {
  assert.equal(hasStatistic([{ type: "grid", stat_energy_from: statisticId }], statisticId), true);
  assert.equal(hasStatistic([{ type: "grid", stat_energy_from: "sensor.other" }], statisticId), false);
});

test("saves and validates a new source", async () => {
  let saved;
  const client = {
    getEnergyPreferences: async () => ({ energy_sources: [{ type: "solar", stat_energy_from: "sensor.solar" }] }),
    saveEnergySources: async (sources) => {
      saved = sources;
      return { energy_sources: sources };
    },
    validateEnergyDashboard: async () => ({ energy_sources: [] }),
  };
  const result = await ensureEnergyDashboardSource(client, statisticId, "ČEZ PND test");
  assert.equal(result.changed, true);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].stat_energy_from, statisticId);
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
