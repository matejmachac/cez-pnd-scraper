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
    importHour: toInteger(process.env.IMPORT_HOUR ?? options.import_hour, 6),
    importMinute: toInteger(process.env.IMPORT_MINUTE ?? options.import_minute, 30),
    retryMinutes: toInteger(process.env.RETRY_MINUTES ?? options.retry_minutes, 60),
    addToEnergyDashboard: toBoolean(
      process.env.ADD_TO_ENERGY_DASHBOARD ?? options.add_to_energy_dashboard,
      true,
    ),
    statisticId: String(process.env.STATISTIC_ID ?? options.statistic_id ?? "").trim(),
    timezone: process.env.TZ ?? options.timezone ?? "Europe/Prague",
    logLevel: process.env.LOG_LEVEL ?? options.log_level ?? "info",
    dashboardUrl:
      process.env.PND_DASHBOARD_URL ??
      "https://pnd.cezdistribuce.cz/cezpnd2/external/dashboard/view",
    dataDir: process.env.DATA_DIR ?? "/data",
    healthPort: toInteger(process.env.HEALTH_PORT, 8099),
    homeAssistantWebSocketUrl:
      process.env.HA_WEBSOCKET_URL ?? "ws://supervisor/core/websocket",
    supervisorToken: process.env.SUPERVISOR_TOKEN,
  };

  if (!config.email) throw new Error("Missing required PND email");
  if (!config.password) throw new Error("Missing required PND password");
  if (config.importHour < 0 || config.importHour > 23) throw new Error("import_hour must be 0-23");
  if (config.importMinute < 0 || config.importMinute > 59) throw new Error("import_minute must be 0-59");
  if (!config.supervisorToken) throw new Error("SUPERVISOR_TOKEN is missing");
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

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  throw new Error(`Expected a boolean, got: ${value}`);
}
