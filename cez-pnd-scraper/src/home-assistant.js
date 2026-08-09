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
    });
    const rows = result?.[statisticId] ?? [];
    return rows.length > 0 && Number.isFinite(rows.at(-1)?.sum) ? rows.at(-1).sum : 0;
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
      else pending.reject(new Error(`Home Assistant ${message.type ?? "command"} failed: ${message.error?.message ?? "unknown error"}`));
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
