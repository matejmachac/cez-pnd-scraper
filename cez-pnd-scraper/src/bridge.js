import { createHash, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";
import { NoDataSourcesError } from "./scraper.js";
import { IncompleteDayError } from "./importer.js";

// The transport never writes Recorder in native mode. The token authorizes only
// local measurement reads; it grants no access to PND credentials or HA APIs.
export function createBridge({ config, stateStore, scraper, status }) {
  let busy = false;
  const expected = createHash("sha256").update(config.bridgeToken).digest();
  return async (request, response) => {
    const send = (code, data) => {
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(data));
    };
    const supplied = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    const digest = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(digest, expected) || !config.bridgeToken) return send(401, { error: "invalid_auth" });
    if (request.method !== "GET") return send(405, { error: "method_not_allowed" });
    const url = new URL(request.url, "http://transport");
    if (url.pathname === "/v1/info") {
      const state = await stateStore.load();
      return send(200, { protocol: 1, capabilities: ["month"], writerMode: config.writerMode, statisticId: config.statisticId || state.statisticId || null,
        meterId: state.meterId ?? null, lastImportedDate: state.lastImportedDate ?? null, timezone: config.timezone });
    }
    if (!["/v1/profile", "/v1/registers", "/v1/month"].includes(url.pathname)) return send(404, { error: "not_found" });
    if (config.writerMode !== "native") return send(409, { error: "legacy_writer_active" });
    if (busy || status.stopping) return send(429, { error: "busy" });
    const month = url.searchParams.get("month");
    const monthly = url.pathname === "/v1/month";
    if (monthly && !/^\d{4}-\d{2}$/.test(month ?? "")) return send(400, { error: "invalid_month" });
    const date = monthly ? `${month}-01` : url.searchParams.get("date");
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? DateTime.fromISO(date, { zone: config.timezone }) : null;
    const now = DateTime.now().setZone(config.timezone);
    if (!parsed?.isValid || parsed.toISODate() !== date || date >= now.toISODate() || parsed < now.minus({ months: 37 }).startOf("day")) {
      return send(400, { error: "invalid_date" });
    }
    busy = true;
    status.running = true;
    try {
      const data = monthly ? await scraper.scrapeMonth(month, now) : url.pathname === "/v1/profile"
        ? await scraper.scrapeDate(date, now, { includeRegisters: true })
        : await scraper.scrapeRegistersDate(date, now);
      status.lastSuccess = new Date().toISOString();
      status.lastError = null;
      send(200, data);
    } catch (error) {
      if (error.name === "PndLoginRejectedError" || error.cause?.name === "PndLoginRejectedError") {
        status.lastError = "authentication_required";
        send(403, { error: "pnd_auth_required" });
      } else if (error instanceof NoDataSourcesError) {
        status.lastError = "no_data_sources";
        send(422, { error: "no_data_sources" });
      } else if (error instanceof IncompleteDayError) {
        status.lastError = "incomplete_measurement";
        send(422, { error: "incomplete_measurement" });
      } else {
        status.lastError = "source_unavailable_or_schema_changed";
        send(503, { error: "source_unavailable_or_schema_changed" });
      }
    } finally {
      status.running = false;
      busy = false;
    }
  };
}
