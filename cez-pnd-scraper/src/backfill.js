import { DateTime } from "luxon";
import { ensureEnergyDashboardSource } from "./energy-dashboard.js";
import { buildHourlyStatistics, createStatisticMetadata, defaultStatisticId } from "./importer.js";

export function parseImportDate(value, timezone = "Europe/Prague") {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? DateTime.fromISO(value, { zone: timezone }) : null;
  if (!date?.isValid || date.toISODate() !== value) throw new Error(`Invalid import date (expected YYYY-MM-DD): ${value}`);
  return date;
}

export function planImportDates(state, { backfillFrom = "", timezone = "Europe/Prague", correctionDays = 0 }, now) {
  const yesterday = now.setZone(timezone).startOf("day").minus({ days: 1 });
  const last = state.lastImportedDate ? parseImportDate(state.lastImportedDate, timezone) : null;
  if (last && last > yesterday) throw new Error("Saved import date is ahead of yesterday; refusing to overwrite newer statistics");
  const requested = backfillFrom ? parseImportDate(backfillFrom, timezone) : null;
  if (requested && requested > yesterday) throw new Error("backfill_from must be yesterday or earlier");
  let start = last ? last.plus({ days: 1 }) : yesterday;
  if (last && correctionDays > 0 && state.lastCorrectionThrough !== yesterday.toISODate()) {
    let correctionStart = last.minus({ days: correctionDays - 1 });
    const first = state.firstImportedDate ? parseImportDate(state.firstImportedDate, timezone) : last;
    if (correctionStart < first) correctionStart = first;
    if (correctionStart < start) start = correctionStart;
  }
  if (requested && state.completedBackfillFrom !== backfillFrom && requested < start) start = requested;
  const dates = [];
  for (let day = start; day <= yesterday; day = day.plus({ days: 1 })) dates.push(day.toISODate());
  return dates;
}

// Prepare the entire replacement range before writing anything. Replaying only
// the holes would leave later cumulative sums unchanged and create false drops.
const activeStores = new WeakSet();
export async function runImport(args) {
  if (activeStores.has(args.stateStore)) throw new Error("PND synchronization is already running");
  activeStores.add(args.stateStore);
  try {
    return await runImportLocked(args);
  } finally {
    activeStores.delete(args.stateStore);
  }
}

async function runImportLocked({ config, stateStore, historyStore, energyBackupStore, scraper, createClient, logger, now, signal }) {
  const state = await stateStore.load();
  const dates = planImportDates(state, config, now);
  if (dates.length === 0) {
    if (!config.backfillFrom && state.completedBackfillFrom) {
      await stateStore.save({ ...state, completedBackfillFrom: null });
    }
    logger.debug("All requested PND days are already imported");
    return { days: 0 };
  }
  logger.info("Preparing PND import range", { from: dates[0], through: dates.at(-1), days: dates.length });
  const profiles = [];
  await historyStore?.beginPlan(dates);
  let meterId;
  let statisticId;
  for (const targetDate of dates) {
    signal?.throwIfAborted();
    const profile = await historyStore?.loadPendingProfile(targetDate) ?? await scraper.scrapeDate(targetDate, now);
    if (profile.targetDate !== targetDate) throw new Error(`PND returned a different day than requested: ${targetDate}`);
    buildHourlyStatistics(profile, { timezone: config.timezone });
    await historyStore?.saveProfile(profile);
    await historyStore?.checkpoint(targetDate);
    const id = config.statisticId || defaultStatisticId(profile.meterId);
    if (profiles.length && (meterId !== profile.meterId || statisticId !== id)) {
      throw new Error("PND meter changed within the backfill range; no statistics were imported");
    }
    meterId = profile.meterId;
    statisticId = id;
    if ((state.statisticId && state.statisticId !== statisticId) || (state.meterId && state.meterId !== meterId)) {
      throw new Error("Configured statistic or meter differs from saved import state; refusing to mix energy histories");
    }
    profiles.push(profile);
    logger.info("Validated PND day for import", { targetDate, intervals: profile.intervals.length });
  }

  signal?.throwIfAborted();
  const client = createClient();
  try {
    await client.connect();
    const dayStart = parseImportDate(dates[0], config.timezone).toUTC().toISO();
    let cumulativeSum = await client.getLatestSum(statisticId, dayStart);
    const stats = [];
    let lastBatch;
    for (const profile of profiles) {
      lastBatch = buildHourlyStatistics(profile, { timezone: config.timezone, baseSum: cumulativeSum });
      stats.push(...lastBatch.stats);
      cumulativeSum = lastBatch.cumulativeSum;
    }
    signal?.throwIfAborted();
    await client.importStatistics(createStatisticMetadata(statisticId, `ČEZ PND consumption ${meterId}`), stats);
    // The import is an upsert by statistic ID/hour. If the process stops before
    // saving state, retrying this same range replaces rows instead of adding energy.
    let energyDashboardConfigured = state.energyDashboardConfigured ?? false;
    if (config.addToEnergyDashboard) {
      try {
        const dashboard = await ensureEnergyDashboardSource(client, statisticId, `ČEZ PND ${meterId}`, { backupStore: energyBackupStore });
        energyDashboardConfigured = true;
        if (dashboard.validationError) logger.warn("Energy dashboard validation failed", { error: dashboard.validationError });
      } catch (error) {
        logger.warn("Statistics were imported, but automatic Energy dashboard setup failed", { error: error.message, statisticId });
      }
    }
    await stateStore.save({
      ...state,
      lastImportedDate: dates.at(-1),
      firstImportedDate: state.firstImportedDate && state.firstImportedDate < dates[0] ? state.firstImportedDate : dates[0],
      statisticId,
      meterId,
      cumulativeSum,
      lastImportAt: new Date().toISOString(),
      lastDayEnergyKwh: lastBatch.energyKwh,
      energyDashboardConfigured,
      completedBackfillFrom: config.backfillFrom || null,
      lastCorrectionThrough: dates.at(-1),
    });
    await historyStore?.finishPlan();
    logger.info("Imported complete PND range into Home Assistant statistics", {
      from: dates[0], through: dates.at(-1), days: dates.length, hours: stats.length, statisticId,
    });
    return { days: dates.length, hours: stats.length, cumulativeSum };
  } finally {
    client.close();
  }
}
