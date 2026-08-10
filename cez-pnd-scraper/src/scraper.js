import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import { parsePndCsv } from "./parser.js";

export class PndScraper {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.storageStatePath = path.join(config.dataDir, "browser-state.json");
    this.errorScreenshotPath = path.join(config.dataDir, "last-error.png");
  }

  async scrapeYesterday(now = DateTime.now().setZone(this.config.timezone)) {
    const targetDate = now.minus({ days: 1 }).toISODate();
    await mkdir(this.config.dataDir, { recursive: true });
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    let page;

    try {
      const contextOptions = {
        locale: "cs-CZ",
        timezoneId: this.config.timezone,
        viewport: { width: 1440, height: 1000 },
      };
      if (await fileExists(this.storageStatePath)) contextOptions.storageState = this.storageStatePath;

      const context = await browser.newContext(contextOptions);
      page = await context.newPage();
      await page.goto(this.config.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.loginIfRequired(page);
      await page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await context.storageState({ path: this.storageStatePath });
      await chmod(this.storageStatePath, 0o600);

      // PND modifies browser globals in a way that breaks Playwright's selector
      // evaluator. Keep all dashboard interaction on native DOM APIs instead of
      // selector-based Playwright calls.
      const intervalInputId = await this.findExportWindow(page);
      await this.selectYesterdayAndSearch(page, intervalInputId, targetDate);
      const csv = await this.downloadCsv(page, intervalInputId);
      return parsePndCsv(csv, {
        elm: this.config.elm,
        timezone: this.config.timezone,
        targetDate,
      });
    } catch (error) {
      if (page) await page.screenshot({ path: this.errorScreenshotPath, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await browser.close();
    }
  }

  async loginIfRequired(page) {
    const loginVisible = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Zadejte svůj e-mail"], input[type="email"]');
      if (!input) return false;
      const style = getComputedStyle(input);
      return style.display !== "none" && style.visibility !== "hidden" && input.getClientRects().length > 0;
    });
    if (!loginVisible) return;

    this.logger.info("PND session expired; signing in again");
    await Promise.all([
      page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, { timeout: 60_000 }),
      page.evaluate(({ email, password }) => {
        document.querySelector("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection")?.click();
        const emailInput = document.querySelector('input[placeholder="Zadejte svůj e-mail"], input[type="email"]');
        const passwordInput = document.querySelector('input[placeholder="Zadejte své heslo"], input[type="password"]');
        const submit = document.querySelector('button[type="submit"]');
        if (!emailInput || !passwordInput || !submit) throw new Error("PND login form is incomplete");
        setNativeInputValue(emailInput, email);
        setNativeInputValue(passwordInput, password);
        submit.click();

        function setNativeInputValue(input, value) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, { email: this.config.email, password: this.config.password }),
    ]);
  }

  async findExportWindow(page) {
    const inputId = await pollForValue(page, async () => page.evaluate(() => {
      for (const window of document.querySelectorAll(".pnd-window")) {
        const input = window.querySelector('input[id$="-intervalType"]');
        const search = [...window.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Vyhledat data");
        const csv = [...window.querySelectorAll("a")]
          .find((link) => link.textContent?.trim() === "CSV");
        if (input?.id && search && csv) return input.id;
      }
      return null;
    }), 30_000);
    if (!inputId) throw new Error("No PND data window with CSV export was found");
    return inputId;
  }

  async selectYesterdayAndSearch(page, intervalInputId, targetDate) {
    const controls = await page.evaluate(({ id }) => {
      const input = document.getElementById(id);
      if (!input) return { error: "PND data window disappeared" };
      const scope = input.closest(".pnd-window") ?? document.body;
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      input.click();
      const yesterday = [...scope.querySelectorAll(".multiselect__option")]
        .find((option) => normalize(option.textContent) === "Včera");
      if (!yesterday) return { error: 'The period option "Včera" was not found in the PND interval menu' };
      yesterday.click();

      const search = [...scope.querySelectorAll("button")]
        .find((button) => /VYHLEDAT DATA/i.test(normalize(button.textContent)));
      if (!search) return { error: 'The button "VYHLEDAT DATA" was not found in the PND data window' };
      search.click();
      return { ok: true };
    }, { id: intervalInputId });
    if (controls.error) throw new Error(controls.error);

    const expectedPrefix = DateTime.fromISO(targetDate).toFormat("dd.MM.yyyy");
    const selected = await pollForValue(page, async () => page.evaluate(({ id, expected }) => {
      const input = document.getElementById(id);
      const scope = input?.closest(".pnd-window");
      const period = scope?.querySelector('input[id$="-interval"]');
      return period?.value.startsWith(expected) || null;
    }, { id: intervalInputId, expected: expectedPrefix }), 10_000);
    if (!selected) throw new Error(`PND did not select yesterday (${targetDate})`);
    await page.waitForTimeout(1_000);
  }

  async downloadCsv(page, intervalInputId) {
    const download = page.waitForEvent("download", { timeout: 60_000 });
    const clicked = await page.evaluate(({ id }) => {
      const input = document.getElementById(id);
      const scope = input?.closest(".pnd-window");
      const csv = [...(scope?.querySelectorAll("a") ?? [])]
        .find((link) => link.textContent?.trim() === "CSV");
      csv?.click();
      return Boolean(csv);
    }, { id: intervalInputId });
    if (!clicked) throw new Error("PND CSV export option was not found");
    return readDownload(await download);
  }
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("PND CSV download has no readable body");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  // PND declares UTF-8 but exports Czech status text in Windows-1250.
  return new TextDecoder("windows-1250").decode(Buffer.concat(chunks));
}

async function pollForValue(page, operation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await page.waitForTimeout(100);
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
