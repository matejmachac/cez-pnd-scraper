import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCzechNumber,
  parseDailyRows,
  parsePndCsv,
  parsePndTimestamp,
  parsePndTimestampVariants,
} from "../src/parser.js";

test("parses Czech decimal values and valid zero", () => {
  assert.equal(parseCzechNumber("0,492"), 0.492);
  assert.equal(parseCzechNumber("1 234,56"), 1234.56);
  assert.equal(parseCzechNumber("0,0"), 0);
  assert.equal(parseCzechNumber("-"), null);
});

test("normalizes PND 24:00 to the following midnight", () => {
  assert.equal(
    parsePndTimestamp("01.08.2026 24:00", "Europe/Prague").toISO(),
    "2026-08-02T00:00:00.000+02:00",
  );
});

test("returns both offsets for the repeated autumn hour", () => {
  assert.deepEqual(
    parsePndTimestampVariants("25.10.2026 02:15", "Europe/Prague").map((item) => item.toISO()),
    ["2026-10-25T02:15:00.000+02:00", "2026-10-25T02:15:00.000+01:00"],
  );
});

test("parses all daily rows and picks the configured ELM", () => {
  const profile = parseDailyRows(
    ["Datum", "+A/1234567890 [kW]"],
    [
      ["01.08.2026 00:15", "0,492"],
      ["01.08.2026 00:30", "0,0"],
      ["02.08.2026 00:15", "9,9"],
    ],
    { elm: "1234567890", timezone: "Europe/Prague", targetDate: "2026-08-01" },
  );
  assert.equal(profile.meterId, "1234567890");
  assert.equal(profile.intervals.length, 2);
  assert.equal(profile.intervals[1].powerKw, 0);
});

test("requires ELM when multiple +A columns exist", () => {
  assert.throws(
    () => parseDailyRows(
      ["Datum", "+A/1 [kW]", "+A/2 [kW]"],
      [],
      { targetDate: "2026-08-01" },
    ),
    /configure the ELM/,
  );
});

test("parses PND CSV and excludes unknown placeholder values", () => {
  const profile = parsePndCsv(
    '"Datum";"+A/1234567890 [kW]";"Status"\n"01.08.2026 00:15:00";0,492;"naměřená data OK"\n"01.08.2026 00:30:00";0;"neznámá hodnota"\n',
    { elm: "1234567890", timezone: "Europe/Prague", targetDate: "2026-08-01" },
  );
  assert.equal(profile.intervals.length, 1);
  assert.equal(profile.intervals[0].powerKw, 0.492);
  assert.deepEqual(profile.diagnostics, {
    exportedRows: 2,
    measuredRows: 1,
    targetDateIntervals: 1,
    firstTimestamp: "01.08.2026 00:15:00",
    lastTimestamp: "01.08.2026 00:30:00",
    statusCounts: { "namerena data ok": 1, "neznama hodnota": 1 },
  });
});
