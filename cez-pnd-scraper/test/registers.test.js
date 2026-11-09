import test from "node:test";
import assert from "node:assert/strict";
import { parseRegisterCsv, deriveDailyTariffs } from "../src/registers.js";

// Actual report-17 layout and values observed 2026-11-09. Physical ID anonymized.
const header = '"Datum";"+E/test [kWh]";"Status";"Datum";"-E/test [kWh]";"Status";"Datum";"+E_NT/test [kWh]";"Status";"Datum";"+E_VT/test [kWh]";"Status";';
const row = (date, total, nt, vt) => `"${date} 24:00:00";${total};"naměřená data OK";"${date} 24:00:00";0.938;"naměřená data OK";"${date} 24:00:00";${nt};"naměřená data OK";"${date} 24:00:00";${vt};"naměřená data OK";`;
const previous = () => parseRegisterCsv(`${header}\n${row("07.11.2026", "2,236.796", "1,870.517", "366.279")}`);
const current = () => parseRegisterCsv(`${header}\n${row("08.11.2026", "2,288.142", "1,916.703", "371.439")}`);

test("real registry CSV has repeated date/status columns and US thousands", () => {
  const samples = current();
  assert.equal(samples.length, 3);
  assert.equal(samples[0].kwh, 2288.142);
  assert.equal(samples[0].timestamp, "2026-11-08T23:00:00.000Z");
  const result = deriveDailyTariffs(previous(), samples, { profileKwh: 51.346 });
  assert.equal(result.quality, "measured");
  assert.equal(result.total, 51.346);
  assert.equal(result.vt, 5.16);
  assert.equal(result.nt, 46.186);
  assert.equal(result.resolution, "day");
});
test("a replacement meter or reset cannot create negative consumption", () => {
  const replacement = current().map((sample) => ({ ...sample, meterId: "replacement" }));
  assert.equal(deriveDailyTariffs(previous(), replacement).quality, "meter_changed");
  assert.equal(deriveDailyTariffs(previous(), current().map((sample) => ({ ...sample, kwh: 0 }))).quality, "register_reset");
});
test("partial tariff and failed reconciliation remain explicitly unavailable", () => {
  assert.equal(deriveDailyTariffs(previous(), current().slice(0, 1)).quality, "tariff_unavailable");
  assert.equal(deriveDailyTariffs(previous(), current(), { profileKwh: 100 }).quality, "reconciliation_failed");
  assert.equal(parseRegisterCsv(`${header}\n${row("08.11.2026", "-", "-", "-").replaceAll("naměřená data OK", "neplatná data")}`).length, 0);
});
test("day boundaries follow Prague DST and cannot bridge missing days", () => {
  const a = parseRegisterCsv(`${header}\n${row("28.03.2026", "1", "1", "0")}`);
  const b = parseRegisterCsv(`${header}\n${row("29.03.2026", "2", "2", "0")}`);
  const result = deriveDailyTariffs(a, b);
  assert.equal((Date.parse(result.end) - Date.parse(result.start)) / 3600000, 23);
  assert.throws(() => deriveDailyTariffs(a, current()), /one Prague calendar day/);
});

test("browser cs-CZ decimal commas below 1000 are never treated as US thousands", () => {
  const before = parseRegisterCsv(`${header}\n${row("07.11.2026", "2\u00a0236,796", "1\u00a0870,517", "366,279")}`, { numericLocale: 'cs-CZ' });
  const after = parseRegisterCsv(`${header}\n${row("08.11.2026", "2\u00a0288,142", "1\u00a0916,703", "371,439")}`, { numericLocale: 'cs-CZ' });
  assert.equal(after.find(sample => sample.register === 'vt').kwh, 371.439);
  assert.equal(deriveDailyTariffs(before, after, { profileKwh: 51.34575 }).quality, 'measured');
  assert.equal(deriveDailyTariffs(before, after).vt, 5.16);
  assert.equal(deriveDailyTariffs(before, after).nt, 46.186);
});
