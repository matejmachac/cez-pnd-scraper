import test from "node:test";
import assert from "node:assert/strict";
import {
  domTableToCandidate,
  parseCzechNumber,
  parsePndTimestamp,
  selectLatestMeasurement,
} from "../src/parser.js";

test("parses Czech decimal values", () => {
  assert.equal(parseCzechNumber("0,492"), 0.492);
  assert.equal(parseCzechNumber("1 234,56"), 1234.56);
  assert.equal(parseCzechNumber("-"), null);
});

test("normalizes PND 24:00 to the following midnight", () => {
  assert.equal(
    parsePndTimestamp("01.08.2026 24:00", "Europe/Prague").toISO(),
    "2026-08-02T00:00:00.000+02:00",
  );
});

test("selects the newest +A measurement for the configured ELM", () => {
  const candidates = [
    {
      data: {
        columns: [
          { id: "1001", name: "Datum" },
          { id: "2001", name: "+A/1234567890", unit: "kW" },
        ],
        values: [
          { "1001": { v: "01.08.2026 00:15" }, "2001": { v: "0,492" } },
          { "1001": { v: "01.08.2026 00:30" }, "2001": { v: "0,454" } },
        ],
      },
    },
  ];

  assert.deepEqual(
    selectLatestMeasurement(candidates, { elm: "1234567890", timezone: "Europe/Prague" }),
    {
      timestamp: "2026-08-01T00:30:00.000+02:00",
      timestampMs: 1785537000000,
      powerKw: 0.454,
      column: "+A/1234567890",
      source: "pnd-data-response",
    },
  );
});

test("requires ELM when multiple +A columns exist", () => {
  const candidates = [{ data: {
    columns: [
      { id: "date", name: "Datum" },
      { id: "a", name: "+A/1", unit: "kW" },
      { id: "b", name: "+A/2", unit: "kW" },
    ],
    values: [],
  } }];
  assert.throws(() => selectLatestMeasurement(candidates), /configure the ELM/);
});

test("converts the visible last table page to the PND response shape", () => {
  const candidate = domTableToCandidate(
    ["Datum", "+A/1234567890 [kW]"],
    [["09.08.2026 10:15", "0,321"]],
  );
  const measurement = selectLatestMeasurement([candidate], {
    elm: "1234567890",
    timezone: "Europe/Prague",
  });
  assert.equal(measurement.powerKw, 0.321);
  assert.equal(measurement.timestamp, "2026-08-09T10:15:00.000+02:00");
});
