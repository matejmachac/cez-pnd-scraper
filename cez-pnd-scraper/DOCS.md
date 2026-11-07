# ČEZ PND Scraper

This Home Assistant OS app imports delayed ČEZ Distribuce PND data into Home
Assistant long-term statistics. It does not create a live power sensor and does
not use MQTT.

For each requested day the app starts headless Chromium, signs in when necessary,
selects **Včera** or a historical date range, clicks **VYHLEDAT DATA**, downloads
its CSV export after search requests have completed, and closes Chromium.
The lightweight Node.js scheduler remains idle between attempts.

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
- `backfill_from`: Optional inclusive historical start date in `YYYY-MM-DD`
  format. Empty by default (automatic catch-up from the last successful import).
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

## Historical backfill (0.4.0+)

**Automatic catch-up:** if the last successful import was October 25, the next
attempt imports October 26 through yesterday, oldest first. A fresh installation
without saved state imports only yesterday unless `backfill_from` is set.

**Repair an older gap:** in the add-on configuration set:

```yaml
backfill_from: "2026-10-26"
```

Save and restart the add-on. It observes the normal daily import time, then
downloads every day from that date through yesterday. If saved state indicates
an even earlier unimported day, catch-up starts there instead so it is not skipped.
Keep the existing meter, statistic ID, and `/data/state.json`.

All days must contain complete measured intervals before **any** statistics in
the range are written. A missing day or portal failure leaves HA statistics and
the checkpoint unchanged and retries the range later. No values are estimated.
Long ranges require more time and must still be available in the ČEZ portal.

The range is sent as one chronological HA import. Hours already present in HA
are replaced, not added twice. Replaying the later days is necessary to repair
their cumulative sums after filling an older gap. The cumulative baseline comes
from HA strictly before the first requested day, not from the saved latest sum.
If HA accepted an import but the connection or state save failed, retrying the
same range is safe.

A completed `backfill_from` value is remembered, so leaving it configured does
not replay the whole range every day. Normal automatic catch-up continues. You
can clear it after success. To deliberately replay the same date again, clear
it, restart and let one attempt run, then set the date and restart again.

Historical selection supports editable date-range fields and Flatpickr-backed
fields. Since 0.4.1, the requested range runs from the target day's midnight to
the following local midnight, including 23/25-hour DST days; identical midnight
boundaries do not represent a full day. Logs show `Searching PND data window`
with the actual selected period before each search.
An unsupported read-only picker fails explicitly rather than importing
the wrong day. Portal compatibility is covered by synthetic browser tests, not
live-account verification.

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
Home Assistant API prevents advancing the import checkpoint and schedules
another attempt. All requested CSV days are validated before any HA import.
Portal failures also trigger one immediate attempt in a clean browser session.
Incomplete measurements do not trigger repeated sign-ins: the app logs CSV row
counts, status counts, and the first/last exported timestamps, then waits for the
configured retry. Only rows marked `naměřená data OK` are accepted; unknown
placeholders are never converted to zero consumption.
The most recent browser failure screenshot is stored as
`/data/last-error.png`. Credentials are never written to logs.

Do not delete `/data/state.json` or the Home Assistant statistic to repair a gap;
use `backfill_from` instead.
