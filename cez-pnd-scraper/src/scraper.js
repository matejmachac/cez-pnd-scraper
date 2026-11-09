import { access, chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import { parsePndCsv, parsePndMultiMeterCsv } from "./parser.js";
import { buildHourlyStatistics, IncompleteDayError } from "./importer.js";
import { parseRegisterCsv } from "./registers.js";

export class PndScraper {
  constructor(config, logger, browserType = chromium) {
    this.config = config;
    this.logger = logger;
    this.browserType = browserType;
    this.storageStatePath = path.join(config.dataDir, "browser-state.json");
    this.errorScreenshotPath = path.join(config.dataDir, "last-error.png");
  }

  async scrapeYesterday(now = DateTime.now().setZone(this.config.timezone)) {
    return this.scrapeDate(now.minus({ days: 1 }).toISODate(), now);
  }

  async scrapeRegistersDate(targetDate, now = DateTime.now().setZone(this.config.timezone)) {
    return this.scrapeDate(targetDate, now, { report: "daily_registers" });
  }

  async scrapeMonth(month, now = DateTime.now().setZone(this.config.timezone)) {
    const first = DateTime.fromISO(`${month}-01`, { zone: this.config.timezone });
    if (!/^\d{4}-\d{2}$/.test(month) || !first.isValid) throw new Error("Invalid month");
    const from = first.minus({ days: 1 }); // Opening register for the month's first day.
    const end = DateTime.min(first.plus({ months: 1 }), now.setZone(this.config.timezone).startOf("day"));
    return this.scrapeDate(from.toISODate(), now, { rangeEnd: end.toISODate() });
  }

  async scrapeDate(targetDate, now = DateTime.now().setZone(this.config.timezone), { report = "profile", includeRegisters = false, rangeEnd = null } = {}) {
    const date = DateTime.fromISO(targetDate, { zone: this.config.timezone });
    if (!date.isValid || date.toISODate() !== targetDate || targetDate >= now.setZone(this.config.timezone).toISODate()) {
      throw new Error(`PND import date must be a completed calendar day: ${targetDate}`);
    }
    await mkdir(this.config.dataDir, { recursive: true });
    const browser = await this.browserType.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const contextOptions = {
          locale: "cs-CZ",
          timezoneId: this.config.timezone,
          viewport: { width: 1440, height: 1000 },
        };
        if (attempt === 0 && await fileExists(this.storageStatePath)) {
          contextOptions.storageState = this.storageStatePath;
        }

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        try {
          await page.goto(this.config.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await this.loginIfRequired(page);
          await page.waitForURL(/\/cezpnd2\/external\/dashboard\/view/, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          // PND modifies browser globals in a way that breaks Playwright's selector
          // evaluator. Keep all dashboard interaction on native DOM APIs instead of
          // selector-based Playwright calls.
          const intervalInputId = await this.findExportWindow(page);
          if (!rangeEnd && targetDate === now.setZone(this.config.timezone).minus({ days: 1 }).toISODate()) {
            await this.selectYesterdayAndSearch(page, intervalInputId, targetDate);
          } else {
            await this.selectHistoricalAndSearch(page, intervalInputId, targetDate, rangeEnd);
          }
          if (this.config.writerMode === "native") {
            await this.selectReport(page, intervalInputId, /^01\s+Profil spotřeby/);
          }
          if (report === "daily_registers") {
            try {
              await this.selectReport(page, intervalInputId, /^17\s+Registry za den/);
              const csv = await this.downloadCsv(page, intervalInputId);
              const samples = parseRegisterCsv(csv, { elm: this.config.elm, timezone: this.config.timezone, allowMultiple: this.config.writerMode === "native", numericLocale: contextOptions.locale });
              const boundary = date.startOf("day").plus({ days: 1 }).toMillis();
              if (samples.some((sample) => Date.parse(sample.timestamp) !== boundary)) throw new Error("PND registry export returned a different day than requested");
              await context.storageState({ path: this.storageStatePath });
              await chmod(this.storageStatePath, 0o600);
              return samples;
            } finally {
              // Report selection is portal state; do not leave the working
              // profile scraper pointing at registry columns on its next run.
              await this.selectReport(page, intervalInputId, /^01\s+Profil spotřeby/);
            }
          }
          const csv = await this.downloadCsv(page, intervalInputId);
          const parser = this.config.writerMode === "native" && !this.config.elm ? parsePndMultiMeterCsv : parsePndCsv;
          if (rangeEnd) {
            const end = DateTime.fromISO(rangeEnd, { zone: this.config.timezone });
            if (!end.isValid || end <= date || end > now.setZone(this.config.timezone).startOf("day") || end.diff(date, "days").days > 32) throw new Error("Invalid measurement range");
            const result = { from: targetDate, through: end.minus({ days: 1 }).toISODate(), profiles: {}, incomplete: [], registers: [] };
            for (let day = date; day < end; day = day.plus({ days: 1 })) {
              const target = day.toISODate();
              const profile = parser(csv, { elm: this.config.elm, timezone: this.config.timezone, targetDate: target });
              try {
                buildHourlyStatistics(profile, { timezone: this.config.timezone });
                result.profiles[target] = profile;
              } catch (error) {
                if (!(error instanceof IncompleteDayError)) throw error;
                result.incomplete.push(target);
              }
            }
            try {
              await this.selectReport(page, intervalInputId, /^17\s+Registry za den/);
              result.registers = parseRegisterCsv(await this.downloadCsv(page, intervalInputId), {
                elm: this.config.elm, timezone: this.config.timezone, allowMultiple: true, numericLocale: contextOptions.locale,
              });
              const fromMs = date.toMillis();
              if (result.registers.some((sample) => Date.parse(sample.timestamp) <= fromMs || Date.parse(sample.timestamp) > end.toMillis())) throw new Error("PND registry export returned a different range");
            } finally {
              await this.selectReport(page, intervalInputId, /^01\s+Profil spotřeby/);
            }
            await context.storageState({ path: this.storageStatePath });
            await chmod(this.storageStatePath, 0o600);
            return result;
          }
          const profile = parser(csv, {
            elm: this.config.elm,
            timezone: this.config.timezone,
            targetDate,
          });
          // Validate before saving the session or handing data to Home Assistant.
          try {
            buildHourlyStatistics(profile, { timezone: this.config.timezone });
          } catch (error) {
            if (error instanceof IncompleteDayError) {
              this.logger.warn("PND CSV does not contain a complete measured day", {
                targetDate,
                ...profile.diagnostics,
              });
            }
            throw error;
          }
          await context.storageState({ path: this.storageStatePath });
          await chmod(this.storageStatePath, 0o600);
          if (includeRegisters) {
            try {
              await this.selectReport(page, intervalInputId, /^17\s+Registry za den/);
              profile.registers = parseRegisterCsv(await this.downloadCsv(page, intervalInputId), {
                elm: this.config.elm, timezone: this.config.timezone, allowMultiple: true, numericLocale: contextOptions.locale,
              });
              const boundary = date.startOf("day").plus({ days: 1 }).toMillis();
              if (profile.registers.some((sample) => Date.parse(sample.timestamp) !== boundary)) throw new Error("PND registry export returned a different day than requested");
            } finally {
              await this.selectReport(page, intervalInputId, /^01\s+Profil spotřeby/);
            }
          }
          return profile;
        } catch (error) {
          await page.screenshot({ path: this.errorScreenshotPath, fullPage: true }).catch(() => {});
          // A stale session can still reach the dashboard URL but fail to load
          // its windows. Recover from that too, not just /login?error.
          if (!(error instanceof IncompleteDayError) && !(error instanceof NoDataSourcesError) && attempt === 0) {
            await rm(this.storageStatePath, { force: true });
            this.logger.warn("PND portal attempt failed; cleared saved session and retrying once", {
              error: error.message,
            });
            continue;
          }
          if (error instanceof PndLoginRejectedError) {
            throw new Error(
              "PND rejected sign-in after a clean-session retry; verify the configured credentials or sign in to PND manually",
              { cause: error },
            );
          }
          throw error;
        } finally {
          await context.close();
        }
      }
      throw new Error("PND portal retry ended unexpectedly");
    } finally {
      await browser.close();
    }
  }

  async loginIfRequired(page) {
    const ready = await pollForValue(page, async () => page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Zadejte svůj e-mail"], input[type="email"]');
      if (input) {
        const style = getComputedStyle(input);
        if (style.display !== "none" && style.visibility !== "hidden" && input.getClientRects().length > 0) {
          return "login";
        }
      }
      if (location.pathname === "/cezpnd2/external/dashboard/view") return "dashboard";
      if (location.pathname.endsWith("/login") && new URLSearchParams(location.search).has("error")) return "rejected";
      return null;
    }), 60_000);
    if (ready === "rejected") throw new PndLoginRejectedError();
    if (!ready) throw new Error("PND did not display a login form or dashboard");
    if (ready === "dashboard") return;

    this.logger.info("PND session expired; signing in again");
    await Promise.all([
      page.waitForURL((url) =>
        url.pathname === "/cezpnd2/external/dashboard/view" || isPndLoginErrorUrl(url), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      }),
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
    if (isPndLoginErrorUrl(page.url())) throw new PndLoginRejectedError();
  }

  async selectReport(page, intervalInputId, pattern) {
    await waitForSearch(page, () => page.evaluate(({ id, source }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      const expression = new RegExp(source);
      const report = [...(scope?.querySelectorAll("a") ?? [])]
        .find((link) => expression.test(link.textContent.trim()));
      if (!report) throw new Error("Requested PND report is unavailable");
      report.click();
    }, { id: intervalInputId, source: pattern.source }));
  }

  async findExportWindow(page) {
    const inputId = await pollForValue(page, async () => page.evaluate(({ native }) => {
      const windows = [...document.querySelectorAll(".pnd-window")];
      if (native) windows.sort((a, b) => Number(b.innerText.includes("Všechny EANy")) - Number(a.innerText.includes("Všechny EANy")));
      for (const window of windows) {
        const input = window.querySelector('input[id$="-intervalType"]');
        const search = [...window.querySelectorAll("button")]
          .find((button) => /\bvyhledat\s+data\b/i.test(button.textContent ?? ""));
        if (input?.id && search) return input.id;
      }
      return null;
    }, { native: this.config.writerMode === "native" && !this.config.elm }), 30_000);
    if (!inputId) throw new Error("No PND data window with period and search controls was found");
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

    await this.searchAndWait(page, intervalInputId, targetDate);
  }

  async selectHistoricalAndSearch(page, intervalInputId, targetDate, rangeEnd = null) {
    const dayStart = DateTime.fromISO(targetDate, { zone: this.config.timezone });
    // PND searches timestamp boundaries, not inclusive date labels. Identical
    // midnight endpoints yield a header-only CSV. Use a calendar day (not 24
    // elapsed hours) so DST days include all 92/100 quarter-hour intervals.
    const dayEnd = rangeEnd ? DateTime.fromISO(rangeEnd, { zone: this.config.timezone }) : dayStart.plus({ days: 1 });
    const expected = dayStart.toFormat("dd.MM.yyyy");
    const expectedEnd = dayEnd.toFormat("dd.MM.yyyy");
    await page.evaluate(({ id }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      if (!scope) throw new Error("PND data window disappeared");
      document.getElementById(id).click();
      const custom = [...scope.querySelectorAll(".multiselect__option")].find((option) => {
        const text = (option.textContent ?? "").normalize("NFD").replace(/\p{Mark}/gu, "")
          .replace(/\s+/g, " ").trim().toLowerCase();
        return /^(vlastni(?: (?:obdobi|interval|rozsah|vyber))?|volitelne obdobi)$/.test(text);
      });
      custom?.click();
    }, { id: intervalInputId });
    // Let the period selection render its date-range input before changing it.
    await page.evaluate(({ id, date, endDate, iso, endIso }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      const input = scope?.querySelector('input[id$="-interval"]');
      if (!input) throw new Error("PND historical date-range input was not found");
      if (input._flatpickr) {
        const localDate = (value) => {
          const [year, month, day] = value.split("-").map(Number);
          return new Date(year, month - 1, day);
        };
        input._flatpickr.setDate([localDate(iso), localDate(endIso)], true);
        input._flatpickr.close();
      } else {
        if (input.readOnly || input.disabled) {
          throw new Error("PND historical date picker is unsupported: no editable range or Flatpickr instance");
        }
        const separator = input.value.match(/\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?(\s*[^\d\s.]+\s*)\d{2}\.\d{2}\.\d{4}/)?.[1] ?? " - ";
        const time = /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/.test(input.value) ? " 00:00:00"
          : /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(input.value) ? " 00:00" : "";
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        input.focus();
        setter.call(input, `${date}${time}${separator}${endDate}${time}`);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
        }));
        input.blur();
      }
    }, { id: intervalInputId, date: expected, endDate: expectedEnd, iso: targetDate, endIso: dayEnd.toISODate() });
    const selected = await pollForValue(page, async () => page.evaluate(({ id, date, endDate }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      const value = scope?.querySelector('input[id$="-interval"]')?.value ?? "";
      const dates = value.match(/\d{2}\.\d{2}\.\d{4}/g) ?? [];
      return dates.length === 2 && dates[0] === date && dates[1] === endDate;
    }, { id: intervalInputId, date: expected, endDate: expectedEnd }), 10_000);
    if (!selected) throw new Error(`PND did not select historical day (${targetDate})`);
    await this.searchAndWait(page, intervalInputId, targetDate);
  }

  async searchAndWait(page, intervalInputId, targetDate) {
    const selectedPeriod = await page.evaluate(({ id }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      return scope?.querySelector('input[id$="-interval"]')?.value ?? null;
    }, { id: intervalInputId });
    this.logger.info("Searching PND data window", { targetDate, selectedPeriod });
    // Vue must commit the selected dates before the search handler reads them.
    // Track the resulting requests rather than exporting an old table after a
    // fixed sleep; the portal can take much longer than a second to load data.
    await waitForSearch(page, () => page.evaluate(({ id }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      const search = [...(scope?.querySelectorAll("button") ?? [])]
        .find((button) => /\bvyhledat\s+data\b/i.test(button.textContent ?? ""));
      if (!search || search.disabled) throw new Error("PND data search is unavailable");
      search.click();
    }, { id: intervalInputId }));

    const exportReady = await pollForValue(page, async () => page.evaluate(({ id }) => {
      const scope = document.getElementById(id)?.closest(".pnd-window");
      if (/Pro danou konfiguraci nejsou k dispozici žádné datové zdroje/i.test(scope?.textContent ?? "")) return "no_sources";
      return [...(scope?.querySelectorAll("a") ?? [])]
        .some((link) => link.textContent?.trim() === "CSV") || null;
    }, { id: intervalInputId }), 30_000);
    if (exportReady === "no_sources") throw new NoDataSourcesError();
    if (!exportReady) throw new Error("PND search completed without a CSV export option");
  }

  async downloadCsv(page, intervalInputId) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.evaluate(({ id }) => {
        const input = document.getElementById(id);
        const scope = input?.closest(".pnd-window");
        const csv = [...(scope?.querySelectorAll("a") ?? [])]
          .find((link) => link.textContent?.trim() === "CSV");
        if (!csv) throw new Error("PND CSV export option was not found");
        csv.click();
      }, { id: intervalInputId }),
    ]);
    return readDownload(download);
  }
}

class PndLoginRejectedError extends Error {
  constructor() {
    super("PND rejected sign-in and redirected to /login?error");
    this.name = "PndLoginRejectedError";
  }
}

export function isPndLoginErrorUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  return url.pathname.endsWith("/login") && url.searchParams.has("error");
}

export async function waitForSearch(page, search, { timeoutMs = 60_000, quietMs = 1_000 } = {}) {
  const pending = new Set();
  let lastActivity = Date.now();
  let failure = null;
  const started = (request) => {
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    pending.add(request);
    lastActivity = Date.now();
  };
  const finished = (request) => {
    if (!pending.delete(request)) return;
    lastActivity = Date.now();
  };
  const failed = (request) => {
    if (pending.has(request)) failure = new Error("PND data search request failed");
    finished(request);
  };
  const response = (result) => {
    if (pending.has(result.request()) && result.status() >= 400) {
      failure = new Error(`PND data search returned HTTP ${result.status()}`);
    }
  };
  page.on("request", started);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  page.on("response", response);
  try {
    await search();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (pending.size === 0 && Date.now() - lastActivity >= quietMs) return;
      await page.waitForTimeout(100);
    }
    throw new Error("PND data search did not finish before the timeout");
  } finally {
    page.off("request", started);
    page.off("requestfinished", finished);
    page.off("requestfailed", failed);
    page.off("response", response);
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

export class NoDataSourcesError extends Error {
  constructor() { super("PND reports no data sources for the requested period"); this.name = "NoDataSourcesError"; }
}
