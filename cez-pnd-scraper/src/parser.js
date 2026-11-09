import { DateTime } from "luxon";

export function parseCzechNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const normalized = String(value)
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".");
  if (!normalized || normalized === "-") return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePndTimestamp(value, zone = "Europe/Prague") {
  return parsePndTimestampVariants(value, zone)[0] ?? null;
}

export function parsePndTimestampVariants(value, zone = "Europe/Prague") {
  if (!value) return [];
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return [];

  const [, date, hourText, minute, second = "00"] = match;
  const hour = Number(hourText);
  if (hour > 24 || Number(minute) > 59 || Number(second) > 59 ||
      (hour === 24 && (Number(minute) !== 0 || Number(second) !== 0))) return [];
  const adjustedHour = hour === 24 ? "00" : hourText;
  let parsed = DateTime.fromFormat(
    `${date} ${adjustedHour}:${minute}:${second}`,
    "dd.MM.yyyy HH:mm:ss",
    { zone },
  );
  if (hour === 24) parsed = parsed.plus({ days: 1 });
  if (!parsed.isValid) return [];
  // Luxon shifts nonexistent spring-transition times forward; reject those.
  if (hour !== 24 && parsed.toFormat("dd.MM.yyyy HH:mm:ss") !== `${date} ${hourText}:${minute}:${second}`) return [];
  return parsed.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis());
}

export function parseDailyRows(headers, rows, {
  elm = "",
  timezone = "Europe/Prague",
  targetDate,
} = {}) {
  const dateColumn = headers.findIndex((header) => /datum|date/i.test(header));
  const powerColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /\+A(?:\/|\b)/i.test(header) && /\[?kW\]?/i.test(header) && (!elm || header.includes(elm)));

  if (dateColumn < 0) throw new Error("PND table has no date column");
  if (powerColumns.length === 0) throw new Error("PND table has no matching +A column in kW");
  if (!elm && powerColumns.length > 1) {
    throw new Error("Multiple +A kW columns found; configure the ELM number");
  }

  const powerColumn = powerColumns[0];
  const occurrences = new Map();
  const intervals = [];

  for (const cells of rows) {
    const timestampRaw = cells[dateColumn];
    const variants = parsePndTimestampVariants(timestampRaw, timezone);
    const powerKw = parseCzechNumber(cells[powerColumn.index]);
    if (variants.length === 0 || powerKw === null) continue;

    const occurrence = occurrences.get(timestampRaw) ?? 0;
    occurrences.set(timestampRaw, occurrence + 1);
    const timestamp = variants[Math.min(occurrence, variants.length - 1)];
    intervals.push({
      end: timestamp.toISO(),
      endMs: timestamp.toMillis(),
      powerKw,
    });
  }

  const dayStart = DateTime.fromISO(targetDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });
  return {
    targetDate,
    meterId: extractMeterId(powerColumn.header),
    column: powerColumn.header,
    intervals: intervals
      .filter(({ endMs }) => endMs > dayStart.toMillis() && endMs <= dayEnd.toMillis())
      .sort((left, right) => left.endMs - right.endMs),
  };
}

export function parsePndCsv(csv, options) {
  let [headers = [], ...rows] = parseCsv(csv);
  const selected = headers.map((header, index) => ({ header, index }))
    .filter(({ header }) => /\+A(?:\/|\b)/i.test(header) && /\[?kW\]?/i.test(header) && (!options?.elm || header.includes(options.elm)));
  if (selected.length === 1) {
    const index = selected[0].index;
    const dateIndex = /datum|date/i.test(headers[index - 1] ?? "") ? index - 1 : headers.findIndex((header) => /datum|date/i.test(header));
    const statusIndex = /status/i.test(headers[index + 1] ?? "") ? index + 1 : -1;
    // Every channel has its own date and quality in actual multi-channel CSVs.
    // A different meter's status must never authorize this meter's sample.
    const indices = [dateIndex, index, ...(statusIndex < 0 ? [] : [statusIndex])];
    rows = rows.map((row) => indices.map((column) => row[column] ?? ""));
    headers = indices.map((column) => headers[column]);
  }
  const statusColumn = headers.findIndex((header) => /status/i.test(header));
  const measuredRows = statusColumn < 0
    ? rows
    : rows.filter((cells) => normalizeStatus(cells[statusColumn]).trim() === "namerena data ok");
  const profile = parseDailyRows(headers, measuredRows, options);
  const statusCounts = new Map();
  for (const cells of rows) {
    const status = normalizeStatus(cells[statusColumn]) || "(no status)";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const dateColumn = headers.findIndex((header) => /datum|date/i.test(header));
  profile.diagnostics = {
    exportedRows: rows.length,
    measuredRows: measuredRows.length,
    targetDateIntervals: profile.intervals.length,
    firstTimestamp: rows[0]?.[dateColumn] ?? null,
    lastTimestamp: rows.at(-1)?.[dateColumn] ?? null,
    statusCounts: Object.fromEntries(statusCounts),
  };
  return profile;
}

export function parsePndMultiMeterCsv(csv, options) {
  const [headers = []] = parseCsv(csv);
  const meters = [...new Set(headers.filter((header) => /\+A\/.*\[kW\]/i.test(header)).map(extractMeterId))];
  if (!meters.length) throw new Error("PND table has no matching +A column in kW");
  const byEnd = new Map();
  for (const meterId of meters) {
    const profile = parsePndCsv(csv, { ...options, elm: meterId });
    for (const interval of profile.intervals) {
      if (byEnd.has(interval.endMs)) throw new Error("Overlapping physical meters or supply points require an explicit selection");
      byEnd.set(interval.endMs, { ...interval, meterId });
    }
  }
  const intervals = [...byEnd.values()].sort((a, b) => a.endMs - b.endMs);
  const active = [...new Set(intervals.map((interval) => interval.meterId))];
  return { targetDate: options.targetDate, meterId: active.length === 1 ? active[0] : "multiple", intervals };
}

export function domTableRows(headers, rows) {
  return {
    headers: headers.map(normalizeText),
    rows: rows.map((cells) => cells.map(normalizeText)),
  };
}

function extractMeterId(header) {
  return String(header).match(/\+A\/([^\s\[]+)/i)?.[1] ?? "default";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase();
}

export function parseCsv(value) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(value ?? "").replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ";") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) rows.push([...row, field.replace(/\r$/, "")]);
  return rows;
}
