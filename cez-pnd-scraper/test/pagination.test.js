import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPndLoginErrorUrl } from "../src/scraper.js";
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

test("recognizes the PND rejected-login redirect", () => {
  assert.equal(isPndLoginErrorUrl("https://pnd.cezdistribuce.cz/cezpnd2/login?error"), true);
  assert.equal(isPndLoginErrorUrl("https://pnd.cezdistribuce.cz/cezpnd2/login?error=bad"), true);
  assert.equal(isPndLoginErrorUrl("https://pnd.cezdistribuce.cz/cezpnd2/login"), false);
  assert.equal(
    isPndLoginErrorUrl("https://pnd.cezdistribuce.cz/cezpnd2/external/dashboard/view"),
    false,
  );
});

test("scraper clears saved state and retries a rejected login only once", async () => {
  const source = await readFile(new URL("../src/scraper.js", import.meta.url), "utf8");
  assert.match(source, /attempt < 2/);
  assert.match(source, /rm\(this\.storageStatePath, \{ force: true \}\)/);
  assert.match(source, /clean-session retry/);
});
