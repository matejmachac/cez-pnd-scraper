import { DateTime } from "luxon";
import { parsePndCsv } from "../../src/parser.js";

export function syntheticCsv(date, { powerKw = 1, missing = -1, meterId = "123" } = {}) {
  const start = DateTime.fromISO(date, { zone: "Europe/Prague" });
  const end = start.plus({ days: 1 });
  const rows = ['"Datum";"+A/' + meterId + ' [kW]";"Status"'];
  let index = 0;
  for (let time = start.plus({ minutes: 15 }); time <= end; time = time.plus({ minutes: 15 })) {
    rows.push(`"${time.toFormat("dd.MM.yyyy HH:mm:ss")}";${powerKw};"${index === missing ? "neznama hodnota" : "namerena data OK"}"`);
    index += 1;
  }
  return rows.join("\n");
}

export function syntheticProfile(date, options) {
  return parsePndCsv(syntheticCsv(date, options), { timezone: "Europe/Prague", targetDate: date });
}
