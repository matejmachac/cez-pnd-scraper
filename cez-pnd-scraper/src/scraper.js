import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import { domTableRows, parseDailyRows } from "./parser.js";

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
      page.setDefaultTimeout(20_000);

      await page.goto(this.config.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.loginIfRequired(page);
      await page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await context.storageState({ path: this.storageStatePath });
      await chmod(this.storageStatePath, 0o600);

      const table = await this.findConsumptionTable(page);
      await this.selectYesterdayAndSearch(page, table, targetDate);
      const { headers, rows } = await this.readAllPages(table);
      return parseDailyRows(headers, rows, {
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
    const emailInput = page.locator('input[placeholder="Zadejte svůj e-mail"], input[type="email"]').first();
    const passwordInput = page.locator('input[placeholder="Zadejte své heslo"], input[type="password"]').first();
    if (!(await emailInput.isVisible().catch(() => false))) return;

    this.logger.info("PND session expired; signing in again");
    const cookieConsent = page.locator("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection");
    if (await cookieConsent.isVisible().catch(() => false)) await cookieConsent.click();
    await emailInput.fill(this.config.email);
    await passwordInput.fill(this.config.password);
    await Promise.all([
      page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, { timeout: 60_000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
  }

  async findConsumptionTable(page) {
    const expectedHeader = this.config.elm
      ? new RegExp(`\\+A/${escapeRegExp(this.config.elm)}.*\\[kW\\]`, "i")
      : /\+A(?:\/|\b).*\[kW\]/i;
    const tables = page.locator('table[id*="table-data"]');
    await tables.first().waitFor({ state: "attached", timeout: 30_000 });

    for (let index = 0; index < await tables.count(); index += 1) {
      const table = tables.nth(index);
      const headers = (await table.locator("thead th").allTextContents()).map(normalizeText);
      if (headers.some((header) => expectedHeader.test(header))) return table;
    }
    throw new Error("No PND table with a matching +A kW column was found");
  }

  async selectYesterdayAndSearch(page, table, targetDate) {
    const window = table.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' pnd-window ')][1]");
    const scope = await window.count() ? window : page.locator("body");
    const yesterday = scope.getByText("Včera", { exact: true }).first();
    if (!(await yesterday.isVisible().catch(() => false))) {
      throw new Error('The period option "Včera" was not found near the PND table');
    }

    await yesterday.click();
    const search = scope.getByRole("button", { name: /VYHLEDAT DATA/i }).first();
    await search.click();
    const expectedPrefix = DateTime.fromISO(targetDate).toFormat("dd.MM.yyyy");
    await page.waitForFunction(
      ({ tableId, expected }) => {
        const currentTable = document.getElementById(tableId);
        return [...(currentTable?.querySelectorAll("tbody tr td:first-child") ?? [])]
          .some((cell) => cell.textContent?.trim().startsWith(expected));
      },
      { tableId: await table.getAttribute("id"), expected: expectedPrefix },
      { timeout: 60_000 },
    );
  }

  async readAllPages(table) {
    const wrapper = table.locator("xpath=ancestor::div[contains(@class, 'pnd-table')][1]");
    const pageInput = wrapper.locator("input.pnd-pagination-number").first();
    const pageInfoLocator = wrapper.locator(".pnd-pagination-info").first();
    const hasPagination = await pageInput.count() > 0 && await pageInfoLocator.count() > 0;
    const initialInfo = hasPagination ? parsePaginationInfo(await pageInfoLocator.innerText()) : null;
    const lastPage = initialInfo?.lastPage ?? 1;
    const headers = (await table.locator("thead th").allTextContents()).map(normalizeText);
    const rows = [];

    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      if (hasPagination) {
        const current = Number(await pageInput.inputValue());
        if (current !== pageNumber) {
          await pageInput.fill(String(pageNumber));
          await pageInput.press("Enter");
          await waitForPaginationPage(
            table.page(),
            pageInfoLocator,
            pageNumber,
            initialInfo?.pageSize ?? 100,
          );
        }
      }
      rows.push(...await table.locator("tbody tr").evaluateAll((elements) =>
        elements.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")),
      ));
    }
    return domTableRows(headers, rows);
  }
}

async function waitForPaginationPage(page, pageInfo, pageNumber, pageSize) {
  const expectedStart = (pageNumber - 1) * pageSize + 1;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = parsePaginationInfo(await pageInfo.innerText());
    if (info?.start === expectedStart) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`PND table did not switch to page ${pageNumber}`);
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
