export async function ensureEnergyDashboardSource(client, statisticId, name) {
  const preferences = await client.getEnergyPreferences();
  const sources = preferences?.energy_sources ?? [];

  if (hasStatistic(sources, statisticId)) {
    return { changed: false, validation: null };
  }

  const energySources = addUnifiedGridSource(sources, statisticId, name);
  const saved = await client.saveEnergySources(energySources);
  try {
    const validation = await client.validateEnergyDashboard();
    return { changed: true, preferences: saved, validation };
  } catch (error) {
    return {
      changed: true,
      preferences: saved,
      validation: null,
      validationError: error.message,
    };
  }
}

export function hasStatistic(sources, statisticId) {
  return sources.some((source) => source?.stat_energy_from === statisticId);
}

export function addUnifiedGridSource(sources, statisticId, name) {
  return [...sources, {
    type: "grid",
    stat_energy_from: statisticId,
    cost_adjustment_day: 0,
    name,
  }];
}
