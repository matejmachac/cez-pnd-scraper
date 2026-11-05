import WebSocket from "ws";

export class HomeAssistantClient {
  constructor({ url, token, logger, timeoutMs = 20_000 }) {
    this.url = url;
    this.token = token;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(this.url);
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () => this.rejectAll(new Error("Home Assistant WebSocket closed")));

    await this.waitForMessage("auth_required");
    this.socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
    const auth = await this.waitForAnyMessage(["auth_ok", "auth_invalid"]);
    if (auth.type !== "auth_ok") throw new Error(`Home Assistant authentication failed: ${auth.message ?? "invalid token"}`);
  }

  async importStatistics(metadata, stats) {
    return this.command({ type: "recorder/import_statistics", metadata, stats });
  }

  async getEnergyPreferences() {
    try {
      return await this.command({ type: "energy/get_prefs" });
    } catch (error) {
      if (error instanceof HomeAssistantCommandError && error.code === "not_found") return null;
      throw error;
    }
  }

  async saveEnergySources(energySources) {
    return this.command({ type: "energy/save_prefs", energy_sources: energySources });
  }

  async validateEnergyDashboard() {
    return this.command({ type: "energy/validate" });
  }

  async getLatestSum(statisticId, endTime, lookbackDays = 400) {
    const end = new Date(endTime);
    const start = new Date(end.getTime() - lookbackDays * 86_400_000);
    const result = await this.command({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [statisticId],
      period: "hour",
      types: ["sum"],
      units: { energy: "kWh" },
    });
    const rows = result?.[statisticId] ?? [];
    // Explicitly exclude the replacement range, even if the API includes its
    // boundary row. A retry must never use its own first imported hour as base.
    const previous = rows.map((row) => ({
      startMs: typeof row.start === "number" ? row.start : Date.parse(row.start),
      sum: row.sum,
    })).filter((row) => Number.isFinite(row.startMs) && row.startMs < end.getTime() && Number.isFinite(row.sum))
      .sort((left, right) => left.startMs - right.startMs);
    return previous.at(-1)?.sum ?? 0;
  }

  command(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Home Assistant WebSocket is not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant command timed out: ${payload.type}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, ...payload }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      this.logger?.warn("Ignored invalid Home Assistant WebSocket message", { error: error.message });
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.success) pending.resolve(message.result);
      else pending.reject(new HomeAssistantCommandError(
        message.error?.message ?? "unknown error",
        message.error?.code,
      ));
      return;
    }
    this.messageWaiters?.forEach((waiter) => waiter(message));
  }

  waitForMessage(type) {
    return this.waitForAnyMessage([type]);
  }

  waitForAnyMessage(types) {
    this.messageWaiters ??= new Set();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageWaiters.delete(listener);
        reject(new Error(`Timed out waiting for Home Assistant message: ${types.join(" or ")}`));
      }, this.timeoutMs);
      const listener = (message) => {
        if (!types.includes(message.type)) return;
        clearTimeout(timer);
        this.messageWaiters.delete(listener);
        resolve(message);
      };
      this.messageWaiters.add(listener);
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class HomeAssistantCommandError extends Error {
  constructor(message, code) {
    super(`Home Assistant command failed: ${message}`);
    this.name = "HomeAssistantCommandError";
    this.code = code;
  }
}
