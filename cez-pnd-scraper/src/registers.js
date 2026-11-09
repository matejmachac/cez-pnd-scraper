import { DateTime } from "luxon";
import { parseCsv, parseCzechNumber, parsePndTimestamp } from "./parser.js";

function exportNumber(raw) {
  const value = String(raw ?? "").trim();
  // Actual PND registry CSV uses US thousands grouping despite Czech DOM text.
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) return Number(value.replaceAll(",", ""));
  return parseCzechNumber(value);
}

export function parseRegisterCsv(csv, { elm = "", timezone = "Europe/Prague", allowMultiple = false } = {}) {
  const [headers = [], ...rows] = parseCsv(csv);
  const columns = headers.map((header, index) => ({ index, match: header.match(/^\+E(_NT|_VT)?\/([^\s]+)\s+\[kWh\]$/i) }))
    .filter(({ match }) => match && (!elm || match[2] === elm));
  if (!columns.length) throw new Error("PND registry schema has no matching import register in kWh");
  const meters = new Set(columns.map(({ match }) => match[2]));
  if (meters.size !== 1 && !allowMultiple) throw new Error("Multiple registry meters require an explicit ELM");
  const samples = [];
  const keys = new Set();
  for (const cells of rows) {
    if (cells.every((value) => !value.trim())) continue;
    for (const { index, match } of columns) {
      if (!/^Datum$/i.test(headers[index - 1]) || !/^Status$/i.test(headers[index + 1])) throw new Error("Unexpected PND register date/status layout");
      const status = String(cells[index + 1] ?? "").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase();
      if (status.trim() !== "namerena data ok") continue;
      const timestamp = parsePndTimestamp(cells[index - 1], timezone);
      const kwh = exportNumber(cells[index]);
      if (!timestamp || timestamp.toMillis() !== timestamp.startOf("day").toMillis() || kwh === null || kwh < 0) throw new Error("Invalid daily register reading");
      const register = match[1]?.toLowerCase().replace("_", "") ?? "total";
      const key = `${match[2]}/${timestamp.toMillis()}/${register}`;
      if (keys.has(key)) throw new Error("Duplicate PND register reading");
      keys.add(key);
      samples.push({ meterId: match[2], timestamp: timestamp.toUTC().toISO(), register, kwh,
        source: "pnd_daily_register_csv", quality: "measured", resolution: "day" });
    }
  }
  return samples;
}

export function deriveDailyTariffs(previous, current, { profileKwh, toleranceKwh = 0.01 } = {}) {
  const byRegister = (samples) => new Map(samples.map((row) => [row.register, row]));
  const before = byRegister(previous);
  const after = byRegister(current);
  if (!["total", "vt", "nt"].every((key) => before.has(key) && after.has(key))) return { quality: "tariff_unavailable" };
  if (before.size !== previous.length || after.size !== current.length) throw new Error("Exactly one reading per register is required");
  const all = [...previous, ...current];
  if (new Set(all.map((row) => row.meterId)).size !== 1) return { quality: "meter_changed" };
  if (all.some((row) => row.quality !== "measured" || !Number.isFinite(row.kwh) || row.kwh < 0)) throw new Error("Unverified registry input");
  const start = DateTime.fromISO(before.get("total").timestamp, { setZone: true }).setZone("Europe/Prague");
  const end = DateTime.fromISO(after.get("total").timestamp, { setZone: true }).setZone("Europe/Prague");
  if (!start.isValid || !end.isValid || start.toMillis() !== start.startOf("day").toMillis() || end.toMillis() !== start.plus({ days: 1 }).toMillis() ||
      previous.some((row) => Date.parse(row.timestamp) !== start.toMillis()) || current.some((row) => Date.parse(row.timestamp) !== end.toMillis())) throw new Error("Registry readings must bound one Prague calendar day");
  const delta = Object.fromEntries(["total", "vt", "nt"].map((key) => [key, Math.round((after.get(key).kwh - before.get(key).kwh) * 1e6) / 1e6]));
  if (Object.values(delta).some((value) => value < 0)) return { quality: "register_reset" };
  if (Math.abs(delta.total - delta.vt - delta.nt) > toleranceKwh ||
      (profileKwh !== undefined && Math.abs(profileKwh - delta.total) > toleranceKwh)) return { quality: "reconciliation_failed", ...delta };
  return { quality: "measured", resolution: "day", start: start.toUTC().toISO(), end: end.toUTC().toISO(), meterId: all[0].meterId, ...delta };
}
