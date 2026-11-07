import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PndScraper } from "../src/scraper.js";

// Optional real-browser regressions: npm run test:browser
const browserTest = (name, fn) => test(name, { skip: process.env.PND_BROWSER_TESTS !== "1" }, fn);

browserTest("historical ranges end at the following local midnight, including DST and year boundaries", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: "Europe/Prague" });
  const scraper = new PndScraper({ dataDir: ".", timezone: "Europe/Prague" }, {});
  scraper.searchAndWait = async () => {};
  for (const [targetDate, start, end, hours] of [
    ["2026-10-26", "26.10.2026", "27.10.2026", 24],
    ["2026-10-25", "25.10.2026", "26.10.2026", 25],
    ["2026-03-29", "29.03.2026", "30.03.2026", 23],
    ["2026-12-31", "31.12.2026", "01.01.2027", 24],
  ]) {
    for (const time of ["", " 00:00", " 00:00:00"]) {
      await page.setContent(`<div class="pnd-window">
        <input id="meter-intervalType">
        <input id="meter-interval" value="04.11.2026${time} ~ 05.11.2026${time}">
      </div>`);
      await scraper.selectHistoricalAndSearch(page, "meter-intervalType", targetDate);
      assert.equal(await page.evaluate(() => document.getElementById("meter-interval").value),
        `${start}${time} ~ ${end}${time}`);
    }
    await page.setContent(`<div class="pnd-window">
      <input id="meter-intervalType"><input id="meter-interval" readonly>
      </div><script>
        document.getElementById('meter-interval')._flatpickr = {
          setDate(dates) {
            window.durationHours = (dates[1] - dates[0]) / 3600000;
            document.getElementById('meter-interval').value = dates.map(d =>
              [String(d.getDate()).padStart(2, '0'), String(d.getMonth()+1).padStart(2, '0'), d.getFullYear()].join('.')
            ).join(' - ');
          },
          close() {}
        };
      </script>`);
    await scraper.selectHistoricalAndSearch(page, "meter-intervalType", targetDate);
    assert.equal(await page.evaluate(() => document.getElementById("meter-interval").value), `${start} - ${end}`);
    assert.equal(await page.evaluate(() => window.durationHours), hours);
  }
});

browserTest("unsupported read-only historical pickers fail without searching the wrong day", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div class="pnd-window">
      <input id="meter-intervalType">
      <input id="meter-interval" readonly value="04.11.2026 - 04.11.2026">
      <button onclick="window.searched = true">Vyhledat data</button>
    </div>`);
  const scraper = new PndScraper({ dataDir: "." }, {});
  await assert.rejects(scraper.selectHistoricalAndSearch(page, "meter-intervalType", "2026-10-26"), /unsupported/);
  assert.equal(await page.evaluate(() => Boolean(window.searched)), false);
});

browserTest("commits the Vue-style period update and waits for a slow search before exporting", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://pnd.test/**", async (route) => {
    if (route.request().url().endsWith("/data")) {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      await route.fulfill({ contentType: "text/plain", body: "finished CSV" });
    } else {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `
        <div class="pnd-window">
          <input id="meter-intervalType">
          <input id="meter-interval" value="25.10.2026 - 25.10.2026">
          <div class="multiselect__option">Včera</div>
          <button> VYHLEDAT   DATA </button>
        </div>
        <script>
          let committed = false;
          document.querySelector('.multiselect__option').onclick = () => {
            Promise.resolve().then(() => {
              committed = true;
              document.getElementById('meter-interval').value = '26.10.2026 - 26.10.2026';
            });
          };
          document.querySelector('button').onclick = async () => {
            if (!committed) throw new Error('Search ran before Vue committed the period');
            const csv = await (await fetch('/data')).text();
            const link = document.createElement('a');
            link.textContent = 'CSV';
            link.download = 'data.csv';
            link.href = URL.createObjectURL(new Blob([csv]));
            document.querySelector('.pnd-window').append(link);
          };
        </script>` });
    }
  });
  await page.goto("https://pnd.test/cezpnd2/external/dashboard/view");
  const scraper = new PndScraper({ dataDir: "." }, { info() {}, warn() {} });
  // No CSV link exists until after the search has completed.
  const id = await scraper.findExportWindow(page);
  assert.equal(id, "meter-intervalType");
  await scraper.selectYesterdayAndSearch(page, id, "2026-10-26");
  assert.equal(await scraper.downloadCsv(page, id), "finished CSV");
});

browserTest("waits for the CAS login form to become visible after DOMContentLoaded", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://pnd.test/**", async (route) => {
    if (route.request().url().endsWith("/dashboard/view")) {
      await route.fulfill({ contentType: "text/html", body: "Dashboard" });
    } else {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `
        <form style="display:none" action="/cezpnd2/external/dashboard/view">
          <input name="email" placeholder="Zadejte svůj e-mail">
          <input name="password" type="password">
          <button type="submit">Přihlásit se</button>
        </form>
        <script>setTimeout(() => document.querySelector('form').style.display = 'block', 300);</script>` });
    }
  });
  await page.goto("https://pnd.test/cas/login");
  const scraper = new PndScraper({ dataDir: ".", email: "test@example.com", password: "test" }, { info() {} });
  await scraper.loginIfRequired(page);
  assert.equal(new URL(page.url()).pathname, "/cezpnd2/external/dashboard/view");
});
