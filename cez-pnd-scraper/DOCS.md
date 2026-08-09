# ČEZ PND Scraper

This Home Assistant OS app reads the data already loaded by the default PND
table and it does not download CSV files. Playwright finds the default data
table, reads pagination text such as `1–100 z 2976`, calculates the last page,
enters that page number into the adjacent numeric field, presses Enter, and
selects the newest valid `+A` value in `kW` from the final page.

## Prerequisites

- Home Assistant OS on an `amd64` machine.
- The Mosquitto broker app installed and configured.
- A working ČEZ Distribuce PND account.
- A dashboard window containing the default data table and a `+A` column in
  `kW`. No particular date range or table page is required.

## Configuration

- `email`: PND login email.
- `password`: PND login password. Home Assistant stores this as a password
  option in `/data/options.json`; it is not part of the Git repository.
- `elm`: Meter number used to choose a column such as `+A/1234567890 [kW]`.
  Leave empty only if exactly one matching column exists.
- `interval_minutes`: Regular polling interval, default `15`.
- `offset_minutes`: Delay after each interval boundary, default `3`.
- `stale_after_minutes`: Reject older portal data, default `60`.
- `timezone`: Time zone of PND timestamps, default `Europe/Prague`.
- `log_level`: `debug`, `info`, `warn`, or `error`.

The browser login session is saved in the app's persistent `/data` volume. A
new headless Chromium process is still started and closed for every poll. When
the saved session expires, the app signs in again and refreshes it.

## Home Assistant entities

MQTT Discovery creates `sensor.cez_pnd_<elm>_power` with:

- unit `kW`
- device class `power`
- state class `measurement`
- forced updates, so equal consecutive 15-minute values remain measurements

Create an **Integral** helper in Home Assistant:

- input sensor: the ČEZ PND power sensor
- method: `Left`
- integration time: `Hours`
- metric prefix: none (the source is already in `kW`)
- max sub-interval: `15 minutes`

The resulting `kWh` entity can be selected in the Energy dashboard.

## Failure behavior

The app publishes MQTT availability `offline` when login, scraping, parsing, or
staleness validation fails. It retries with exponential backoff up to the normal
poll interval. A screenshot of the most recent browser failure is stored as
`/data/last-error.png` inside the app data volume. Credentials are never logged.
