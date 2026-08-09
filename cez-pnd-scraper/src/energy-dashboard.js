export async function ensureEnergyDashboardSource(client, statisticId, name) {
  const preferences = await client.getEnergyPreferences();
  const sources = preferences?.energy_sources ?? [];

  if (hasStatistic(sources, statisticId)) {
    return { changed: false, schema: detectSchema(sources), validation: null };
  }

  const candidates = buildCandidates(sources, statisticId, name);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    let saved;
    try {
      saved = await client.saveEnergySources(candidate.sources);
    } catch (error) {
      if (index < candidates.length - 1 && error.code === "invalid_format") continue;
      throw error;
    }

    try {
      const validation = await client.validateEnergyDashboard();
      return { changed: true, schema: candidate.schema, preferences: saved, validation };
    } catch (error) {
      return {
        changed: true,
        schema: candidate.schema,
        preferences: saved,
        validation: null,
        validationError: error.message,
      };
    }
  }
  throw new Error("No compatible Home Assistant Energy dashboard schema found");
}

export function hasStatistic(sources, statisticId) {
  return sources.some((source) =>
    source?.stat_energy_from === statisticId
    || source?.flow_from?.some((flow) => flow.stat_energy_from === statisticId),
  );
}

export function buildCandidates(sources, statisticId, name) {
  const gridIndex = sources.findIndex((source) => source?.type === "grid");
  if (gridIndex >= 0) {
    const grid = sources[gridIndex];
    if (Array.isArray(grid.flow_from)) {
      const updated = [...sources];
      updated[gridIndex] = {
        ...grid,
        flow_from: [...grid.flow_from, { stat_energy_from: statisticId }],
      };
      return [{ schema: "legacy", sources: updated }];
    }
    return [{
      schema: "unified",
      sources: [...sources, unifiedGrid(statisticId, name)],
    }];
  }

  return [
    {
      schema: "legacy",
      sources: [...sources, {
        type: "grid",
        flow_from: [{ stat_energy_from: statisticId }],
        flow_to: [],
        cost_adjustment_day: 0,
      }],
    },
    {
      schema: "unified",
      sources: [...sources, unifiedGrid(statisticId, name)],
    },
  ];
}

function detectSchema(sources) {
  const grid = sources.find((source) => source?.type === "grid");
  return Array.isArray(grid?.flow_from) ? "legacy" : grid ? "unified" : "unknown";
}

function unifiedGrid(statisticId, name) {
  return {
    type: "grid",
    stat_energy_from: statisticId,
    cost_adjustment_day: 0,
    name,
  };
}
