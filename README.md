# ČEZ PND Scraper

Private Home Assistant OS app (add-on) that opens the last page of the default
ČEZ Distribuce PND table, reads the newest 15-minute `+A` power measurement,
and publishes it to Home Assistant through MQTT Discovery.

The app keeps only a lightweight Node.js scheduler alive. Headless Chromium is
started for each polling cycle and closed immediately afterwards. An encrypted
transport is used whenever the MQTT service reports TLS support. PND credentials
are stored in the Home Assistant app options and are never committed to Git.

The actual app is in [`cez-pnd-scraper/`](./cez-pnd-scraper/). Installation and
configuration are documented in [`DOCS.md`](./cez-pnd-scraper/DOCS.md).

## Development

```bash
cd cez-pnd-scraper
npm ci
npm test
```

Build the same image that HAOS builds:

```bash
docker build \
  --build-arg BUILD_VERSION=0.1.0 \
  --build-arg BUILD_ARCH=amd64 \
  -t cez-pnd-scraper:dev \
  cez-pnd-scraper
```
