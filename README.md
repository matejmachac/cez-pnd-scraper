# ČEZ PND → Home Assistant Energy

The existing Playwright scraper remains the PND login and export transport.
Version 0.5 adds a native Home Assistant integration with Config/Options Flow,
entities, versioned pricing, resumable history, verified external Recorder
statistics, and automatic native Energy configuration with rollback.

The HAOS app still supports its original standalone `legacy` mode. In `native`
mode its old scheduler is disabled: the native integration is the sole statistics
writer. No MQTT, helpers, utility meters, or user-written YAML are required.

Measured total energy comes from quarter-hour profiles. Actual VT/NT registry
exports provide daily tariff totals; the integration does not invent hourly
tariff measurements. One grid source avoids counting total and tariff energy
twice. Daily variable costs and independent hourly fixed charges feed an external
CZK cost statistic. Unknown historical tariffs or prices remain explicitly unknown.

See [native adapter documentation](docs/NATIVE-ADAPTER.md) for architecture,
installation, price validity, data resolution, migration, and rollback. The
[original app documentation](cez-pnd-scraper/DOCS.md) describes standalone mode.
[Audit notes](docs/IMPLEMENTATION-AUDIT.md) record the original installation and
observed PND exports; they include the earlier, pre-native implementation stage.

## Development

```sh
npm --prefix cez-pnd-scraper ci
npm --prefix cez-pnd-scraper test
npm --prefix cez-pnd-scraper run check
npm --prefix cez-pnd-scraper run test:browser
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
.venv/bin/python -m pytest tests
```

Historické ceny a produkční ověření nativní verze 0.5.2: [doplnění podle faktury](docs/HISTORICAL-PRICES.md).

Nativní verze 0.6.0 doplňuje [import ručních odečtů z XLSX a označené denní odhady](docs/MANUAL-HISTORY.md), které respektují přednost naměřených PND dat.
