import { readFile } from "node:fs/promises";

const DEFAULT_OPTIONS_PATH = "/data/options.json";

export async function loadConfig(optionsPath = process.env.OPTIONS_PATH ?? DEFAULT_OPTIONS_PATH) {
  let options = {};
  try {
    options = JSON.parse(await readFile(optionsPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const config = {
    email: process.env.PND_EMAIL ?? options.email,
    password: process.env.PND_PASSWORD ?? options.password,
    elm: String(process.env.PND_ELM ?? options.elm ?? "").trim(),
    intervalMinutes: toInteger(process.env.POLL_INTERVAL_MINUTES ?? options.interval_minutes, 15),
    offsetMinutes: toInteger(process.env.POLL_OFFSET_MINUTES ?? options.offset_minutes, 3),
    staleAfterMinutes: toInteger(process.env.STALE_AFTER_MINUTES ?? options.stale_after_minutes, 60),
    timezone: process.env.TZ ?? options.timezone ?? "Europe/Prague",
    logLevel: process.env.LOG_LEVEL ?? options.log_level ?? "info",
    dashboardUrl:
      process.env.PND_DASHBOARD_URL ??
      "https://pnd.cezdistribuce.cz/cezpnd2/external/dashboard/view",
    dataDir: process.env.DATA_DIR ?? "/data",
    healthPort: toInteger(process.env.HEALTH_PORT, 8099),
  };

  if (!config.email) throw new Error("Missing required PND email");
  if (!config.password) throw new Error("Missing required PND password");
  if (config.offsetMinutes >= config.intervalMinutes) {
    throw new Error("offset_minutes must be lower than interval_minutes");
  }
  if (!new Set(["debug", "info", "warn", "error"]).has(config.logLevel)) {
    throw new Error(`Unsupported log level: ${config.logLevel}`);
  }

  return config;
}

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got: ${value}`);
  return parsed;
}
