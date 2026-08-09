# ČEZ PND Scraper

This Home Assistant OS app imports delayed ČEZ Distribuce PND data into Home
Assistant long-term statistics. It does not create a live power sensor and does
not use MQTT.

On each attempt the app starts headless Chromium, signs in when necessary,
selects **Včera** in the dashboard window containing the `+A [kW]` table,
clicks **VYHLEDAT DATA**, reads every table page, and closes Chromium. The
lightweight Node.js scheduler remains idle between attempts.

## Requirements

- Home Assistant OS on an `amd64` machine, Core 2026.6 or newer.
- A working ČEZ Distribuce PND account.
- A PND dashboard window with a 15-minute `+A` column in `kW`.

No MQTT broker, custom integration, helper, external server, or long-lived
Home Assistant token is required. The app receives scoped Home Assistant API
access from Supervisor.

## Configuration

- `email`: PND login email.
- `password`: PND login password. It is a masked app option stored in the app's
  private `/data/options.json`, never in this Git repository.
- `elm`: Meter number used to select a column such as
  `+A/1234567890 [kW]`. Leave empty only if exactly one matching column exists.
- `import_hour`: Local hour of the normal daily attempt, default `6`.
- `import_minute`: Local minute of the normal daily attempt, default `30`.
- `retry_minutes`: Delay after incomplete PND data or another failure, default
  `60` minutes.
- `add_to_energy_dashboard`: Automatically add the imported statistic as grid
  consumption after the first successful import. Enabled by default.
- `statistic_id`: Optional stable external statistic ID. Leave empty to create
  `cez_pnd:consumption_<ELM>` automatically.
- `timezone`: Time zone of PND timestamps, default `Europe/Prague`.
- `log_level`: `debug`, `info`, `warn`, or `error`.

When started before the configured daily time, the app waits for that time;
when started later, it attempts the import immediately. This delay is important
because PND displays zero placeholders before measurements arrive. A successful
import is recorded in `/data/state.json`; restarting the app therefore does not
add the same day twice. The saved browser session is also private to `/data`.

## Validation and conversion

PND timestamps mark the end of each 15-minute interval. Every value in `kW` is
converted to energy using `kW × 0.25 = kWh`, then grouped into Home Assistant's
hourly long-term statistics.

The day is imported only when every expected timestamp is present:

- 96 intervals on a normal day,
- 92 when daylight saving time starts,
- 100 when daylight saving time ends.

A numeric zero is accepted as a real measurement. Missing timestamps trigger a
retry. Because a portal placeholder and a true zero have the same numeric value,
choose an import time late enough for PND to have finalized the previous day;
the default is 06:30 and can be moved later if needed.

## Energy dashboard

By default, the app automatically adds the statistic to grid consumption after
the first successful import. It reads the current Energy preferences first,
preserves every existing source, and makes no change when the same statistic is
already configured. The unified grid format introduced in HA 2026.6 is used;
older Home Assistant versions are intentionally unsupported.

If `add_to_energy_dashboard` is disabled, configure it manually:

1. Open **Settings → Dashboards → Energy**.
2. Add grid consumption.
3. Select the external statistic named **ČEZ PND consumption `<ELM>`**.

The statistic has unit `kWh`, energy unit class, and a cumulative sum. Imported
hours retain their original timestamps, so yesterday's energy appears on
yesterday rather than on the import date.

Automatic dashboard setup is deliberately non-fatal. If Home Assistant changes
its preferences schema or rejects the update, imported statistics remain saved
and the app writes a warning with the statistic ID to its log.

## Failure behavior

An incomplete day, expired credentials, changed portal markup, or unavailable
Home Assistant API leaves the day unmodified and schedules another attempt.
The most recent browser failure screenshot is stored as
`/data/last-error.png`. Credentials are never written to logs.

Version 0.2 imports only the immediately preceding calendar day. If the app is
stopped for more than one full day, older missed days are not backfilled
automatically yet.
