import path from "node:path";
import { DateTime } from "luxon";
import { loadConfig } from "./config.js";
import { runImport } from "./backfill.js";
import { HomeAssistantClient } from "./home-assistant.js";
import { startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { PndScraper } from "./scraper.js";
import { delay, millisecondsUntilDailyWindow, nextDailyRun } from "./scheduler.js";
import { StateStore } from "./state-store.js";
import { HistoryStore } from "./history.js";
import { createBridge } from "./bridge.js";

const config = await loadConfig();
const logger = createLogger(config.logLevel);
const status = { running: false, stopping: false, lastSuccess: null, lastError: null };
const abortController = new AbortController();
const stateStore = new StateStore(path.join(config.dataDir, "state.json"));
const scraper = new PndScraper(config, logger);
const historyStore = new HistoryStore(path.join(config.dataDir, "history"), config.elm || "default", config.timezone);
const healthServer = startHealthServer(config.healthPort, status,
  config.writerMode === "native" ? createBridge({ config, stateStore, scraper, status }) : null);

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

logger.info("ČEZ PND delayed statistics importer started", {
  schedule: `${String(config.importHour).padStart(2, "0")}:${String(config.importMinute).padStart(2, "0")}`,
  retryMinutes: config.retryMinutes,
  elm: config.elm || "auto",
  backfillFrom: config.backfillFrom || "automatic catch-up",
});

let retrying = false;
let failures = 0;
if (config.writerMode === "native") {
  logger.info("Native HA adapter owns statistics; legacy scheduler is disabled");
  await new Promise((resolve) => abortController.signal.addEventListener("abort", resolve, { once: true }));
}
while (!status.stopping && config.writerMode === "legacy") {
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
    await runImport({
      config,
      stateStore,
      historyStore,
      energyBackupStore: new StateStore(path.join(config.dataDir, "energy-backup.json")),
      scraper,
      logger,
      now: DateTime.now().setZone(config.timezone),
      signal: abortController.signal,
      createClient: () => new HomeAssistantClient({
        url: config.homeAssistantWebSocketUrl,
        token: config.supervisorToken,
        logger,
      }),
    });
    retrying = false;
    failures = 0;
    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
  } catch (error) {
    retrying = true;
    failures += 1;
    status.lastError = error.message;
    logger.error("Daily import failed; it will be retried", {
      error: error.message,
      retryMinutes: config.retryMinutes,
    });
  } finally {
    status.running = false;
  }

  const waitMs = retrying
    ? Math.min(config.retryMinutes * 60_000 * 2 ** Math.min(failures - 1, 8), 6 * 3_600_000)
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
