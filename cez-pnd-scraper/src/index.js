import path from "node:path";
import { DateTime } from "luxon";
import { loadConfig } from "./config.js";
import { HomeAssistantClient } from "./home-assistant.js";
import { startHealthServer } from "./health.js";
import {
  buildHourlyStatistics,
  createStatisticMetadata,
  defaultStatisticId,
} from "./importer.js";
import { createLogger } from "./logger.js";
import { PndScraper } from "./scraper.js";
import { delay, millisecondsUntilDailyWindow, nextDailyRun } from "./scheduler.js";
import { StateStore } from "./state-store.js";

const config = await loadConfig();
const logger = createLogger(config.logLevel);
const status = { running: false, stopping: false, lastSuccess: null, lastError: null };
const healthServer = startHealthServer(config.healthPort, status);
const abortController = new AbortController();
const stateStore = new StateStore(path.join(config.dataDir, "state.json"));
const scraper = new PndScraper(config, logger);

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

logger.info("ČEZ PND delayed statistics importer started", {
  schedule: `${String(config.importHour).padStart(2, "0")}:${String(config.importMinute).padStart(2, "0")}`,
  retryMinutes: config.retryMinutes,
  elm: config.elm || "auto",
});

let retrying = false;
while (!status.stopping) {
  const windowWaitMs = millisecondsUntilDailyWindow(
    Date.now(),
    config.importHour,
    config.importMinute,
    config.timezone,
  );
  if (windowWaitMs > 0) {
    logger.debug("Waiting for today's safe import window", {
      seconds: Math.ceil(windowWaitMs / 1_000),
    });
    await delay(windowWaitMs, abortController.signal).catch(() => {});
    if (status.stopping) break;
  }

  status.running = true;
  try {
    const now = DateTime.now().setZone(config.timezone);
    const targetDate = now.minus({ days: 1 }).toISODate();
    const state = await stateStore.load();

    if (state.lastImportedDate === targetDate) {
      retrying = false;
      logger.debug("Yesterday is already imported", { targetDate });
    } else {
      const profile = await scraper.scrapeYesterday(now);
      const statisticId = config.statisticId || defaultStatisticId(profile.meterId);
      const client = new HomeAssistantClient({
        url: config.homeAssistantWebSocketUrl,
        token: config.supervisorToken,
        logger,
      });

      try {
        await client.connect();
        const dayStart = DateTime.fromISO(targetDate, { zone: config.timezone }).startOf("day");
        const baseSum = await client.getLatestSum(statisticId, dayStart.toUTC().toISO());
        const batch = buildHourlyStatistics(profile, { timezone: config.timezone, baseSum });
        await client.importStatistics(
          createStatisticMetadata(statisticId, `ČEZ PND consumption ${profile.meterId}`),
          batch.stats,
        );
        await stateStore.save({
          lastImportedDate: targetDate,
          statisticId,
          meterId: profile.meterId,
          cumulativeSum: batch.cumulativeSum,
          lastImportAt: new Date().toISOString(),
          lastDayEnergyKwh: batch.energyKwh,
        });
        logger.info("Imported complete PND day into Home Assistant statistics", {
          targetDate,
          statisticId,
          intervals: batch.intervalCount,
          hours: batch.hourCount,
          energyKwh: batch.energyKwh,
        });
      } finally {
        client.close();
      }
      retrying = false;
    }

    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
  } catch (error) {
    retrying = true;
    status.lastError = error.message;
    logger.error("Daily import failed; it will be retried", {
      error: error.message,
      retryMinutes: config.retryMinutes,
    });
  } finally {
    status.running = false;
  }

  const waitMs = retrying
    ? config.retryMinutes * 60_000
    : nextDailyRun(Date.now(), config.importHour, config.importMinute, config.timezone) - Date.now();
  logger.debug("Waiting for next import attempt", { seconds: Math.ceil(waitMs / 1_000), retrying });
  await delay(waitMs, abortController.signal).catch(() => {});
}

await new Promise((resolve) => healthServer.close(resolve));
logger.info("ČEZ PND importer stopped");

function stop(signal) {
  if (status.stopping) return;
  logger.info("Stopping importer", { signal });
  status.stopping = true;
  abortController.abort(new Error(signal));
}
