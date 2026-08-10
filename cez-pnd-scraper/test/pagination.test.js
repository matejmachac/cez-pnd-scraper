import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePaginationInfo } from "../src/scraper.js";

test("calculates the last PND table page from the visible counter", () => {
  assert.deepEqual(parsePaginationInfo("1 - 100 z 2976"), {
    start: 1,
    end: 100,
    total: 2976,
    pageSize: 100,
    lastPage: 30,
  });
});

test("handles a single-page PND table", () => {
  assert.equal(parsePaginationInfo("1 - 42 z 42").lastPage, 1);
});

test("scraper avoids the Playwright selector engine broken by the PND dashboard", async () => {
  const source = await readFile(new URL("../src/scraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(?:locator|getByText|getByRole|getByLabel)\s*\(/);
});

test("scraper selects the PND 15-minute interval from its multiselect input", async () => {
  const source = await readFile(new URL("../src/scraper.js", import.meta.url), "utf8");
  assert.match(source, /input\[id\$="-intervalType"\]/);
  assert.match(source, /multiselect__option/);
});
