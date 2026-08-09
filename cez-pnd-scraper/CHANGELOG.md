# Changelog

## 0.3.0

- Optionally adds the imported statistic to the Home Assistant Energy dashboard.
- Preserves existing energy sources and avoids duplicate configuration.
- Supports both legacy and unified Home Assistant grid preference schemas.
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
