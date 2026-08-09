import test from "node:test";
import assert from "node:assert/strict";
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
