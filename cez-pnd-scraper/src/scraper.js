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
      const tableId = await this.findConsumptionTable(page);
      await this.selectYesterdayAndSearch(page, tableId, targetDate);
      const { headers, rows } = await this.readAllPages(page, tableId);
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

  async findConsumptionTable(page) {
    const result = await pollForValue(page, async () => page.evaluate(({ elm }) => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      for (const table of document.querySelectorAll('table[id*="table-data"]')) {
        const headers = [...table.querySelectorAll("thead th")].map((header) => normalize(header.textContent));
        const matches = headers.some((header) => {
          const lower = header.toLowerCase();
          return /\+a(?:\/|\b)/i.test(header)
            && lower.includes("[kw]")
            && (!elm || header.includes(`+A/${elm}`));
        });
        if (matches && table.id) return table.id;
      }
      return null;
    }, { elm: this.config.elm }), 30_000);

    if (!result) throw new Error("No PND table with a matching +A kW column was found");
    return result;
  }

  async selectYesterdayAndSearch(page, tableId, targetDate) {
    const controls = await page.evaluate(({ id }) => {
      const table = document.getElementById(id);
      if (!table) return { error: "PND consumption table disappeared" };
      const scope = table.closest(".pnd-window") ?? document.body;
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const leaves = [...scope.querySelectorAll("*")].filter((element) =>
        visible(element)
        && normalize(element.textContent) === "Včera"
        && ![...element.children].some((child) => normalize(child.textContent) === "Včera"),
      );
      const text = leaves[0];
      const periodControl = text?.closest('label, button, [role="radio"], [role="button"]') ?? text;
      if (!periodControl) return { error: 'The period option "Včera" was not found near the PND table' };
      periodControl.click();

      const search = [...scope.querySelectorAll('button, [role="button"], input[type="submit"], a')]
        .find((element) => visible(element) && /VYHLEDAT DATA/i.test(normalize(element.textContent || element.value)));
      if (!search) return { error: 'The button "VYHLEDAT DATA" was not found near the PND table' };
      search.click();
      return { ok: true };
    }, { id: tableId });
    if (controls.error) throw new Error(controls.error);

    const expectedPrefix = DateTime.fromISO(targetDate).toFormat("dd.MM.yyyy");
    await page.waitForTimeout(500);
    const found = await pollForValue(page, async () => page.evaluate(({ id, expected }) => {
      const table = document.getElementById(id);
      return [...(table?.querySelectorAll("tbody tr td:first-child") ?? [])]
        .some((cell) => cell.textContent?.trim().startsWith(expected)) || null;
    }, { id: tableId, expected: expectedPrefix }), 60_000);
    if (!found) throw new Error(`PND table did not load the period Včera (${targetDate})`);
  }

  async readAllPages(page, tableId) {
    const initial = await readPageState(page, tableId);
    const pagination = parsePaginationInfo(initial.pageInfo);
    const lastPage = pagination?.lastPage ?? 1;
    const rows = [];

    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      let state = await readPageState(page, tableId);
      if (state.hasPagination && state.currentPage !== pageNumber) {
        await switchPage(page, tableId, pageNumber);
        const expectedStart = (pageNumber - 1) * (pagination?.pageSize ?? 100) + 1;
        const switched = await pollForValue(page, async () => {
          const current = await readPageState(page, tableId);
          return parsePaginationInfo(current.pageInfo)?.start === expectedStart ? current : null;
        }, 10_000);
        if (!switched) throw new Error(`PND table did not switch to page ${pageNumber}`);
        state = switched;
      }
      rows.push(...state.rows);
    }
    return domTableRows(initial.headers, rows);
  }
}

async function readPageState(page, tableId) {
  const state = await page.evaluate(({ id }) => {
    const table = document.getElementById(id);
    if (!table) return null;
    const wrapper = table.closest(".pnd-table") ?? table.parentElement;
    const pageInput = wrapper?.querySelector("input.pnd-pagination-number");
    const pageInfo = wrapper?.querySelector(".pnd-pagination-info");
    return {
      headers: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent ?? ""),
      rows: [...table.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
      ),
      hasPagination: Boolean(pageInput && pageInfo),
      currentPage: Number(pageInput?.value ?? 1),
      pageInfo: pageInfo?.textContent ?? "",
    };
  }, { id: tableId });
  if (!state) throw new Error("PND consumption table disappeared");
  return state;
}

async function switchPage(page, tableId, pageNumber) {
  const changed = await page.evaluate(({ id, wanted }) => {
    const table = document.getElementById(id);
    const wrapper = table?.closest(".pnd-table") ?? table?.parentElement;
    const input = wrapper?.querySelector("input.pnd-pagination-number");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, String(wanted));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));
    }
    return true;
  }, { id: tableId, wanted: pageNumber });
  if (!changed) throw new Error("PND pagination input was not found");
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
