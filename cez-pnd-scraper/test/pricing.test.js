import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { priceDay, validatePrices, DUBNICE_PRICES } from "../src/pricing.js";
import { normalizeProfile } from "../src/history.js";
import { syntheticProfile } from "./fixtures/pnd.js";

for (const month of ["2026-10-01", "2026-11-01", "2026-12-01"]) {
  test(`fixed charges sum to exactly 842 CZK for ${month}`, () => {
    const start = DateTime.fromISO(month);
    let nano = 0;
    for (let day = start; day.month === start.month; day = day.plus({ days: 1 })) {
      const result = priceDay(day.toISODate(), []);
      for (const hour of result.hours) nano += Math.round(hour.fixed * 1e9);
    }
    assert.equal(nano, 842e9);
  });
}
test("DST allocation is 23/25 hours and still sums to the monthly amount", () => {
  const prices = [{ ...DUBNICE_PRICES[0], from: "2026-01-01" }];
  assert.equal(priceDay("2026-03-29", [], prices).hours.length, 23);
  assert.equal(priceDay("2026-10-25", []).hours.length, 25);
});
test("unknown tariffs and unknown historic prices cannot become confirmed totals", () => {
  assert.equal(priceDay("2025-10-01", []).quality, "price_unavailable");
  assert.equal(priceDay("2027-01-01", []).quality, "price_unavailable");
  const intervals = normalizeProfile(syntheticProfile("2026-11-01"), { supplyPointId: "test" });
  assert.ok(priceDay("2026-11-01", intervals).hours.every((row) => row.total === null));
});
test("zero measured consumption still incurs fixed cost", () => {
  const intervals = normalizeProfile(syntheticProfile("2026-11-01", { powerKw: 0 }), { supplyPointId: "test" })
    .map((row) => ({ ...row, tariff: "nt" }));
  const result = priceDay("2026-11-01", intervals);
  assert.equal(result.quality, "measured");
  assert.ok(result.hours.every((row) => row.total > 0 && row.nt === 0));
});
test("price changes preserve previous dates and reject overlaps", () => {
  const prices = [{ ...DUBNICE_PRICES[0], until: "2026-11-15" },
    { ...DUBNICE_PRICES[0], version: "new", from: "2026-11-15", nt: "5.00" }];
  const cost = (date) => priceDay(date, normalizeProfile(syntheticProfile(date), { supplyPointId: "test" }).map((row) => ({ ...row, tariff: "nt" })), prices).hours[0].nt;
  assert.equal(cost("2026-11-14"), 3.42314);
  assert.equal(cost("2026-11-15"), 5);
  assert.throws(() => validatePrices([DUBNICE_PRICES[0], { ...DUBNICE_PRICES[0], version: "overlap" }]), /Overlapping/);
});

test("authoritative daily tariffs produce daily costs without a fictional hourly split", async () => {
  const { priceDailyTariffs } = await import("../src/pricing.js");
  const result = priceDailyTariffs({ quality: "measured", resolution: "day",
    start: "2026-11-07T23:00:00.000Z", end: "2026-11-08T23:00:00.000Z", vt: 5.16, nt: 46.186, total: 51.346 });
  assert.equal(result.resolution, "day");
  assert.equal(result.vt, 21.6484704);
  assert.equal(result.nt, 158.10114404);
  assert.ok(Math.abs(result.total - (result.vt + result.nt + result.fixed)) < 1e-8);
  assert.equal(result.hours, undefined);
});
