# ČEZ PND Scraper

Private Home Assistant OS app (add-on) that imports delayed 15-minute ČEZ
Distribuce PND consumption into Home Assistant's long-term energy statistics.

The app reads the completed **Včera** table with headless Playwright, validates
all expected intervals, converts `kW` samples to hourly `kWh`, and imports them
with their historical timestamps through the Supervisor-proxied Home Assistant
WebSocket API. MQTT and an external server are not needed.

After the first import, the app can also add its external statistic to the
Energy dashboard automatically without replacing existing sources. This is
enabled by default and targets the unified grid schema in HA 2026.6 and newer.

Only a lightweight Node.js scheduler stays alive. Chromium starts for a daily
attempt (and retries while yesterday is incomplete) and is closed immediately
afterward. PND credentials and browser state live only in the app's private
`/data` volume.

The app is in [`cez-pnd-scraper/`](./cez-pnd-scraper/). Installation,
configuration, validation rules, and Energy dashboard setup are documented in
[`DOCS.md`](./cez-pnd-scraper/DOCS.md).

## Development

```bash
cd cez-pnd-scraper
npm ci
npm test
npm run check
```

Build the same image that HAOS builds:

```bash
docker build \
  --build-arg BUILD_VERSION=0.3.5 \
  --build-arg BUILD_ARCH=amd64 \
  -t cez-pnd-scraper:dev \
  cez-pnd-scraper
```
