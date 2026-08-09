import path from "node:path";
import { loadConfig } from "./config.js";
import { startHealthServer } from "./health.js";
import { createLogger } from "./logger.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { PndScraper } from "./scraper.js";
import { delay, nextAlignedRun, retryDelayMs } from "./scheduler.js";
import { StateStore } from "./state-store.js";
import { getMqttService } from "./supervisor.js";

const config = await loadConfig();
const logger = createLogger(config.logLevel);
const status = {
  running: false,
  stopping: false,
  lastSuccess: null,
  lastError: null,
};
const healthServer = startHealthServer(config.healthPort, status);
const abortController = new AbortController();
const stateStore = new StateStore(path.join(config.dataDir, "state.json"));
const mqttService = await getMqttService();
const publisher = new MqttPublisher(mqttService, {
  elm: config.elm,
  staleAfterMinutes: config.staleAfterMinutes,
  logger,
});
const scraper = new PndScraper(config, logger);

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

await publisher.connect();
logger.info("ČEZ PND scraper started", {
  intervalMinutes: config.intervalMinutes,
  offsetMinutes: config.offsetMinutes,
  elm: config.elm || "auto",
});

let failures = 0;
let firstRun = true;
let publishedThisProcess = false;

while (!status.stopping) {
  if (!firstRun) {
    const waitMs = failures
      ? retryDelayMs(failures, config.intervalMinutes)
      : nextAlignedRun(Date.now(), config.intervalMinutes, config.offsetMinutes) - Date.now();
    logger.debug("Waiting for next scrape", { seconds: Math.ceil(waitMs / 1_000), failures });
    await delay(waitMs, abortController.signal).catch(() => {});
    if (status.stopping) break;
  }
  firstRun = false;
  status.running = true;

  try {
    const measurement = await scraper.scrape();
    const previous = await stateStore.load();

    if (!publishedThisProcess || previous.timestamp !== measurement.timestamp) {
      await publisher.publishMeasurement(measurement);
      publishedThisProcess = true;
      await stateStore.save({
        timestamp: measurement.timestamp,
        powerKw: measurement.powerKw,
        publishedAt: new Date().toISOString(),
      });
      logger.info("Published new PND measurement", {
        timestamp: measurement.timestamp,
        powerKw: measurement.powerKw,
      });
    } else {
      await publisher.publishAvailability(true);
      logger.info("PND has no newer measurement yet", { timestamp: measurement.timestamp });
    }

    failures = 0;
    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
  } catch (error) {
    failures += 1;
    status.lastError = error.message;
    await publisher.publishAvailability(false).catch(() => {});
    logger.error("Scrape failed", { error: error.message, failures });
  } finally {
    status.running = false;
  }
}

await publisher.publishAvailability(false).catch(() => {});
await publisher.close();
await new Promise((resolve) => healthServer.close(resolve));
logger.info("ČEZ PND scraper stopped");

function stop(signal) {
  if (status.stopping) return;
  logger.info("Stopping scraper", { signal });
  status.stopping = true;
  abortController.abort(new Error(signal));
}
