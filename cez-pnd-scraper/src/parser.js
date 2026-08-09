import { DateTime } from "luxon";

export function parseCzechNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePndTimestamp(value, zone = "Europe/Prague") {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [, date, hourText, minute, second = "00"] = match;
  const hour = Number(hourText);
  const adjustedHour = hour === 24 ? "00" : hourText;
  let parsed = DateTime.fromFormat(
    `${date} ${adjustedHour}:${minute}:${second}`,
    "dd.MM.yyyy HH:mm:ss",
    { zone },
  );
  if (hour === 24) parsed = parsed.plus({ days: 1 });
  return parsed.isValid ? parsed : null;
}

export function selectLatestMeasurement(candidates, { elm = "", timezone = "Europe/Prague" } = {}) {
  const matches = [];

  for (const candidate of candidates) {
    const columns = candidate?.data?.columns;
    const values = candidate?.data?.values;
    if (!Array.isArray(columns) || !Array.isArray(values)) continue;

    const dateColumn = columns.find((column) =>
      /datum|date/i.test(`${column.name ?? ""} ${column.id ?? ""}`),
    ) ?? columns[0];
    const powerColumns = columns.filter((column) => {
      const label = `${column.name ?? ""} ${column.unit ?? ""}`;
      return /\+A(?:\/|\b)/i.test(label) && /kW/i.test(label) && (!elm || label.includes(elm));
    });

    if (powerColumns.length === 0) continue;
    if (!elm && powerColumns.length > 1) {
      throw new Error("Multiple +A kW columns found; configure the ELM number");
    }

    const powerColumn = powerColumns[0];
    for (const row of values) {
      const timestampRaw = unwrapCell(row?.[dateColumn.id]);
      const powerRaw = unwrapCell(row?.[powerColumn.id]);
      const timestamp = parsePndTimestamp(timestampRaw, timezone);
      const powerKw = parseCzechNumber(powerRaw);
      if (!timestamp || powerKw === null) continue;
      matches.push({
        timestamp: timestamp.toISO(),
        timestampMs: timestamp.toMillis(),
        powerKw,
        column: `${powerColumn.name ?? powerColumn.id}`,
        source: "pnd-data-response",
      });
    }
  }

  if (matches.length === 0) {
    throw new Error("No valid +A kW measurements found in PND table responses");
  }

  return matches.sort((a, b) => b.timestampMs - a.timestampMs)[0];
}

export function domTableToCandidate(headers, rows) {
  const columns = headers.map((label, index) => {
    const unitMatch = String(label).match(/\[([^\]]+)\]\s*$/);
    return {
      id: String(index),
      name: String(label).replace(/\s*\[[^\]]+\]\s*$/, "").trim(),
      unit: unitMatch?.[1] ?? null,
    };
  });
  const values = rows.map((cells) =>
    Object.fromEntries(cells.map((value, index) => [String(index), { v: value }])),
  );
  return { data: { columns, values } };
}

function unwrapCell(value) {
  if (value && typeof value === "object" && "v" in value) return value.v;
  return value;
}
