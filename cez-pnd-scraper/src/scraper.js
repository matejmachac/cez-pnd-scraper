import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { domTableToCandidate, selectLatestMeasurement } from "./parser.js";

export class PndScraper {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.storageStatePath = path.join(config.dataDir, "browser-state.json");
    this.errorScreenshotPath = path.join(config.dataDir, "last-error.png");
  }

  async scrape() {
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
      if (await fileExists(this.storageStatePath)) {
        contextOptions.storageState = this.storageStatePath;
      }

      const context = await browser.newContext(contextOptions);
      page = await context.newPage();
      page.setDefaultTimeout(20_000);

      await page.goto(this.config.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.loginIfRequired(page);
      await page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await context.storageState({ path: this.storageStatePath });
      await chmod(this.storageStatePath, 0o600);

      await page.locator("table tbody tr").first().waitFor({ state: "attached", timeout: 30_000 });
      const measurement = await this.readLastTablePage(page);
      this.validateFreshness(measurement);
      return measurement;
    } catch (error) {
      if (page) {
        await page.screenshot({ path: this.errorScreenshotPath, fullPage: true }).catch(() => {});
      }
      throw error;
    } finally {
      await browser.close();
    }
  }

  async loginIfRequired(page) {
    const emailInput = page.locator('input[placeholder="Zadejte svůj e-mail"], input[type="email"]').first();
    const passwordInput = page.locator('input[placeholder="Zadejte své heslo"], input[type="password"]').first();

    if (!(await emailInput.isVisible().catch(() => false))) return;

    this.logger.info("PND session expired; signing in again");
    const cookieConsent = page.locator("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection");
    if (await cookieConsent.isVisible().catch(() => false)) {
      await cookieConsent.click();
    }
    await emailInput.fill(this.config.email);
    await passwordInput.fill(this.config.password);
    await page.locator('button[type="submit"]').first().click();
  }

  async readLastTablePage(page) {
    const expectedHeader = this.config.elm
      ? new RegExp(`\\+A/${escapeRegExp(this.config.elm)}.*\\[kW\\]`, "i")
      : /\+A(?:\/|\b).*\[kW\]/i;
    const tables = page.locator('table[id*="table-data"]');
    const count = await tables.count();

    for (let index = 0; index < count; index += 1) {
      const table = tables.nth(index);
      const headers = (await table.locator("thead th").allTextContents()).map(normalizeText);
      if (!headers.some((header) => expectedHeader.test(header))) continue;

      const wrapper = table.locator("xpath=ancestor::div[contains(@class, 'pnd-table')][1]");
      const pageInput = wrapper.locator("input.pnd-pagination-number").first();
      const pageInfo = normalizeText(await wrapper.locator(".pnd-pagination-info").innerText());
      const pagination = parsePaginationInfo(pageInfo);
      const maxPage = Number(await pageInput.getAttribute("max"));
      const lastPage = pagination?.lastPage ?? maxPage;

      if (Number.isFinite(lastPage) && lastPage > 1) {
          await pageInput.fill(String(lastPage));
          await pageInput.press("Enter");
          await page.waitForTimeout(500);
      }

      const rows = await table.locator("tbody tr").evaluateAll((elements) =>
        elements.map((row) =>
          Array.from(row.querySelectorAll("td")).map((cell) =>
            (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
          ),
        ),
      );
      const measurement = selectLatestMeasurement([domTableToCandidate(headers, rows)], {
        elm: this.config.elm,
        timezone: this.config.timezone,
      });
      return { ...measurement, source: "pnd-last-table-page" };
    }

    throw new Error("No default PND table with a matching +A kW column was found");
  }

  validateFreshness(measurement) {
    const ageMs = Date.now() - measurement.timestampMs;
    if (ageMs < -5 * 60_000) {
      throw new Error(`Newest PND measurement is unexpectedly in the future: ${measurement.timestamp}`);
    }
    if (ageMs > this.config.staleAfterMinutes * 60_000) {
      throw new Error(
        `Newest PND measurement is stale (${Math.round(ageMs / 60_000)} minutes old): ${measurement.timestamp}`,
      );
    }
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePaginationInfo(value) {
  const match = String(value).match(/(\d+)\s*-\s*(\d+)\s*z\s*(\d+)/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  const pageSize = end - start + 1;
  if (pageSize < 1 || total < 1) return null;
  return { start, end, total, pageSize, lastPage: Math.ceil(total / pageSize) };
}
