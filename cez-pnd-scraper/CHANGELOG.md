# 0.5.1

- Parse registry decimals using the export browser locale, including Czech decimal commas below 1000 kWh.
- Refresh both daily registry boundaries from the same new monthly export when repairing historical readings.
- Recognize authoritative PND no-source periods without resetting credentials or retrying indefinitely; cache unavailable months separately from incomplete measured days.
- Allow an explicit backfill to safely resume a rolled-back native importer after verifying writer ownership.
- Add real Chromium locale/no-source and HA historical correction regressions.
- Keep historical unknown-price warnings after recent corrections, expose cost coverage, and add English native settings labels.

# 0.5.0

- Add native HA Core 2026.11 integration, configuration/options/reauth flows and diagnostic entities.
- Keep existing CAS/Playwright login and standalone operation; native transport mode disables the legacy writer.
- Add authenticated monthly profile and daily tariff-register exports, resumable versioned measurement archives and verified Recorder batches.
- Import authoritative daily VT/NT snapshots, versioned daily variable costs and exact hourly fixed charges without estimated tariff curves.
- Configure one native grid source, preserve existing history and foreign sources, provide explicit migration and rollback.
- Add real HA Recorder/Energy lifecycle tests and a Chromium monthly-export regression.

# Changelog

## 0.4.1

- Fix zero-length historical ranges: request the target midnight through the
  following local midnight instead of using the same start and end date.
- Preserve time-bearing editable range formats and handle 23/25-hour DST days.
- Log the selected portal period before searching to diagnose empty exports.
- Correct the synthetic portal fixture to return empty CSV for zero-length
  timestamp ranges, and add DST/year-boundary regression coverage.

## 0.4.0

- Automatically catch up every day after the last successful import through yesterday.
- Add `backfill_from` to replay older history and repair gaps before already imported days.
- Select historical PND date ranges through editable inputs or Flatpickr.
- Validate the entire range before writing and rebuild cumulative sums chronologically
  from HA's preceding baseline in one idempotent import.
- Save completion only after HA accepts the import; retries safely replace existing hours.
- Include synthetic end-to-end Chromium/PND/HA WebSocket tests for historical selection,
  DST, cumulative total repair, and restart idempotency.
- Include the portal recovery and export timing fixes from 0.3.6.

## 0.3.6

- Find the data window even when CSV export is not available until after searching.
- Wait for the selected period to update before clicking Search, then wait for
  search requests to finish before exporting instead of sleeping for one second.
- Retry portal failures (including missing dashboard windows) once with a clean
  browser session, not just explicit login rejections.
- Wait for CAS to reveal its login form before deciding whether sign-in is needed.
- Log CSV row/status counts and exported timestamps when measurements are incomplete.
- Keep rejecting incomplete days; historical backfill is not included in this release.

## 0.3.5

- Detect PND redirects to `/login?error` as rejected sign-ins.
- Delete the saved browser session and retry once in a clean browser context.
- Report a clear credentials/manual-login error when the clean retry is also rejected.

## 0.3.4

- Download the daily CSV export instead of reading the dashboard table and its pagination.
- Select `Včera` from the dashboard's interval Vue multiselect.
- Exclude CSV rows whose status is not `naměřená data OK` so PND placeholders trigger a retry.

## 0.3.3

- Select the 15-minute PND interval type through the dashboard's Vue multiselect before locating its table.

## 0.3.2

- Avoid Playwright's selector engine on the PND dashboard.
- Use native DOM evaluation for login, table discovery, period selection, and pagination.
- Fix `SelectorEvaluatorImpl` crashes caused by PND-modified browser globals.

## 0.3.1

- Require Home Assistant 2026.6 or newer.
- Remove the legacy Energy grid preferences fallback.
- Use only the current unified grid source schema.

## 0.3.0

- Optionally adds the imported statistic to the Home Assistant Energy dashboard.
- Preserves existing energy sources and avoids duplicate configuration.
- Targets the unified Energy grid schema in Home Assistant 2026.6 and newer.
- Treats dashboard setup failures as non-fatal after a successful statistics import.

## 0.2.0

- Replaced 15-minute MQTT publishing with delayed daily statistics import.
- Selects the PND period `Včera` before reading the `+A [kW]` table.
- Validates 96/92/100 intervals, including daylight-saving transitions.
- Converts quarter-hour power samples into cumulative hourly kWh statistics.
- Imports historical timestamps through the Home Assistant WebSocket API.
- Retries incomplete days without treating zero consumption as missing data.

## 0.1.0

- Initial private release.
- Headless Playwright login with persistent session state.
- Direct last-page navigation through the default table pagination field.
- 15-minute aligned scheduler with retry backoff.
- MQTT service discovery through the Home Assistant Supervisor.
- MQTT Discovery power sensor and app health endpoint.
