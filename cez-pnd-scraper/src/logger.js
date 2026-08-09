const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, message, fields = {}) {
    if (LEVELS[name] < threshold) return;
    const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    console[name === "debug" ? "log" : name](`[${name.toUpperCase()}] ${message}${suffix}`);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
