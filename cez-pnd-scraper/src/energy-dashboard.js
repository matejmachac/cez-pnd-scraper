export class EnergyConflictError extends Error {}

export async function ensureEnergyDashboardSource(client, statisticId, name, { backupStore, costStatisticId } = {}) {
  const preferences = await client.getEnergyPreferences();
  const sources = preferences?.energy_sources ?? [];
  if (hasStatistic(sources, statisticId)) return { changed: false, validation: null };
  // A foreign import may represent this same physical supply. Without an
  // explicit migration mapping it cannot safely be counted a second time.
  if (sources.some((source) => source.type === "grid" &&
      (source.stat_energy_from || source.flow_from?.length))) {
    throw new EnergyConflictError("Existing grid import requires an explicit migration mapping before adding PND");
  }
  const energySources = addUnifiedGridSource(sources, statisticId, name, costStatisticId);
  const added = energySources.at(-1);
  if (backupStore) {
    const existing = await backupStore.load();
    if (!existing.preferences) await backupStore.save({ version: 1, preferences: preferences ?? { energy_sources: [] }, added, savedAt: new Date().toISOString() });
  }
  const saved = await client.saveEnergySources(energySources);
  try {
    const validation = await client.validateEnergyDashboard();
    if (hasValidationErrors(validation)) throw new Error("Energy configuration validation reported errors");
    return { changed: true, preferences: saved, validation };
  } catch (error) {
    // Restore only our exact addition, preserving any intervening user edits.
    await removeOwnedSource(client, added);
    throw error;
  }
}

function hasValidationErrors(value) {
  if (Array.isArray(value)) return value.some(hasValidationErrors);
  if (value && typeof value === "object") {
    if (typeof value.type === "string") return true;
    return Object.values(value).some(hasValidationErrors);
  }
  return false;
}

export async function rollbackEnergyDashboard(client, backupStore) {
  const backup = await backupStore.load();
  if (!backup.added) return { changed: false };
  return removeOwnedSource(client, backup.added);
}

async function removeOwnedSource(client, added) {
  const current = await client.getEnergyPreferences();
  const sources = current?.energy_sources ?? [];
  const index = sources.findIndex((source) => source.stat_energy_from === added.stat_energy_from);
  if (index < 0) return { changed: false };
  // HA populates default keys when saving; allow those, but refuse meaningful
  // edits (cost/source/name) made since our installation.
  if (Object.entries(sources[index]).some(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify(added[key]) && value !== null && value !== undefined)) {
    throw new EnergyConflictError("PND source was modified after installation; automatic rollback would discard user edits");
  }
  await client.saveEnergySources(sources.filter((_, position) => position !== index));
  return { changed: true };
}

export function hasStatistic(sources, statisticId) {
  return sources.some((source) => source?.stat_energy_from === statisticId ||
    source?.flow_from?.some((flow) => flow.stat_energy_from === statisticId));
}

export function addUnifiedGridSource(sources, statisticId, name, costStatisticId) {
  return [...sources, {
    type: "grid", stat_energy_from: statisticId, cost_adjustment_day: 0, name,
    ...(costStatisticId ? { stat_cost: costStatisticId } : {}),
  }];
}
