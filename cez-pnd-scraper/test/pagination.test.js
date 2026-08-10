import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("scraper uses native DOM APIs for PND dashboard interaction", async () => {
  const source = await readFile(new URL("../src/scraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(?:locator|getByText|getByRole|getByLabel)\s*\(/);
});

test("scraper selects yesterday and exports CSV from the PND data window", async () => {
  const source = await readFile(new URL("../src/scraper.js", import.meta.url), "utf8");
  assert.match(source, /input\[id\$="-intervalType"\]/);
  assert.match(source, /multiselect__option.*Včera/s);
  assert.match(source, /link\.textContent\?\.trim\(\) === "CSV"/);
});
