# Changelog

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
