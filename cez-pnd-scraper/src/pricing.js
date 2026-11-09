import { DateTime } from "luxon";

// Half-open validity periods. No claim about prices before the current billing
// period or about unannounced 2027 regulated charges.
export const DUBNICE_PRICES = Object.freeze([Object.freeze({
  version: "dubnice-2026-billing", from: "2026-10-01", until: "2027-01-01",
  vt: "4.19544", nt: "3.42314", fixed: "842.00", currency: "CZK",
})]);
const SCALE = 1_000_000_000n;

function amount(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw new Error("Price must be a nonnegative decimal with at most 9 places");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, "0"));
}
const number = (value) => Number(value) / Number(SCALE);

export function validatePrices(prices) {
  const versions = new Set();
  const sorted = [...prices].sort((a, b) => a.from.localeCompare(b.from));
  for (const [index, price] of sorted.entries()) {
    if (!price.version || versions.has(price.version)) throw new Error("Price versions must be unique");
    versions.add(price.version);
    for (const date of [price.from, price.until]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || DateTime.fromISO(date).toISODate() !== date) throw new Error("Invalid price validity date");
    }
    if (price.from >= price.until || (index && sorted[index - 1].until > price.from)) throw new Error("Overlapping or empty price validity");
    if (price.currency !== "CZK") throw new Error("Only CZK pricing is supported");
    for (const key of ["vt", "nt", "fixed"]) amount(price[key]);
  }
  return sorted;
}

// Returns independently usable hourly increments; caller supplies the historical
// baseline when exporting cumulative statistics. Unknown tariffs remain unknown.
export function priceDay(date, intervals, prices = DUBNICE_PRICES) {
  const schedule = validatePrices(prices);
  const day = DateTime.fromISO(date, { zone: "Europe/Prague" }).startOf("day");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid || day.toISODate() !== date) throw new Error("Invalid billing date");
  const price = schedule.find((item) => item.from <= date && date < item.until);
  if (!price) return { date, quality: "price_unavailable", hours: [] };
  const hours = new Map();
  const hoursInDay = day.plus({ days: 1 }).diff(day, "hours").hours;
  const days = BigInt(day.daysInMonth);
  const monthly = amount(price.fixed);
  // Integer boundary differences preserve the exact monthly total, including
  // 23/25-hour days, rather than repeatedly rounding a daily/hourly quotient.
  const daily = monthly * BigInt(day.day) / days - monthly * BigInt(day.day - 1) / days;
  for (let index = 0; index < hoursInDay; index++) {
    const start = day.plus({ hours: index }).toUTC().toISO();
    hours.set(start, { start, fixed: number(daily * BigInt(index + 1) / BigInt(hoursInDay) - daily * BigInt(index) / BigInt(hoursInDay)), vt: 0, nt: 0, total: null });
  }
  let unknown = false;
  const seen = new Set();
  for (const interval of intervals) {
    const start = DateTime.fromISO(interval.start, { setZone: true });
    const end = DateTime.fromISO(interval.end, { setZone: true });
    if (!start.isValid || !end.isValid || start < day || end > day.plus({ days: 1 }) || end <= start ||
        start.startOf("hour").toMillis() !== end.minus({ milliseconds: 1 }).startOf("hour").toMillis() ||
        !Number.isFinite(interval.kwh) || interval.kwh < 0 || seen.has(start.toMillis())) throw new Error("Invalid or duplicate billing interval");
    seen.add(start.toMillis());
    const row = hours.get(start.toUTC().startOf("hour").toISO());
    if (!["vt", "nt"].includes(interval.tariff) || interval.quality !== "measured") {
      unknown = true;
    } else {
      row[interval.tariff] += number(amount(interval.kwh) * amount(price[interval.tariff]) / SCALE);
    }
  }
  // Partial days must not be represented as a complete cost measurement.
  const ordered = [...intervals].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let cursor = day.toMillis();
  for (const interval of ordered) {
    if (Date.parse(interval.start) !== cursor) unknown = true;
    cursor = Date.parse(interval.end);
  }
  if (cursor !== day.plus({ days: 1 }).toMillis()) unknown = true;
  for (const row of hours.values()) {
    if (!unknown) row.total = row.fixed + row.vt + row.nt;
  }
  return { date, priceVersion: price.version, quality: unknown ? "tariff_or_measurement_unavailable" : "measured", hours: [...hours.values()] };
}

// Daily tariff registers provide exact daily billing, without inventing an
// hourly tariff profile. Keep this resolution when presenting/exporting it.
export function priceDailyTariffs(day, prices = DUBNICE_PRICES) {
  if (day.quality !== "measured" || day.resolution !== "day") return { quality: "tariff_unavailable" };
  const start = DateTime.fromISO(day.start, { setZone: true }).setZone("Europe/Prague");
  const end = DateTime.fromISO(day.end, { setZone: true }).setZone("Europe/Prague");
  if (!start.isValid || !end.isValid || start.toMillis() !== start.startOf("day").toMillis() || end.toMillis() !== start.plus({ days: 1 }).toMillis()) throw new Error("Invalid daily billing interval");
  if (![day.vt, day.nt, day.total].every((value) => Number.isFinite(value) && value >= 0) || Math.abs(day.vt + day.nt - day.total) > 0.01) throw new Error("Invalid tariff totals");
  const date = start.toISODate();
  const schedule = validatePrices(prices);
  const price = schedule.find((item) => item.from <= date && date < item.until);
  if (!price) return { quality: "price_unavailable" };
  const fixed = priceDay(date, [], schedule).hours.reduce((total, row) => total + amount(row.fixed.toFixed(9)), 0n);
  const vt = amount(day.vt) * amount(price.vt) / SCALE;
  const nt = amount(day.nt) * amount(price.nt) / SCALE;
  return { start: day.start, end: day.end, quality: "measured", resolution: "day", priceVersion: price.version,
    currency: price.currency, vt: number(vt), nt: number(nt), fixed: number(fixed), total: number(vt + nt + fixed) };
}
