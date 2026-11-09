import path from "node:path";
import { createHash } from "node:crypto";
import { StateStore } from "./state-store.js";
import { buildHourlyStatistics } from "./importer.js";

export function normalizeProfile(profile, { supplyPointId, timezone = "Europe/Prague", fetchedAt = new Date().toISOString() }) {
  if (!supplyPointId || !profile.meterId) throw new Error("Supply point and physical meter are required");
  buildHourlyStatistics(profile, { timezone });
  return profile.intervals.map(({ endMs, powerKw }) => ({
    supplyPointId, meterId: profile.meterId,
    start: new Date(endMs - 900_000).toISOString(), end: new Date(endMs).toISOString(),
    kwh: powerKw / 4, tariff: null, source: "pnd_profile_csv", quality: "measured",
    fetchedAt, sourceCorrectedAt: null, complete: true,
  }));
}

// One atomic JSON file per day reuses the existing private /data volume and
// storage mechanism. It is also an export format; no database server required.
export class HistoryStore {
  constructor(directory, supplyPointId, timezone = "Europe/Prague") {
    this.directory = path.join(directory, createHash("sha256").update(supplyPointId).digest("hex"));
    this.supplyPointId = supplyPointId;
    this.timezone = timezone;
    this.pending = new StateStore(path.join(this.directory, "pending-plan.json"));
  }
  day(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid history date");
    return new StateStore(path.join(this.directory, `${date}.json`));
  }
  async saveProfile(profile) {
    const intervals = normalizeProfile(profile, this);
    const digest = createHash("sha256").update(JSON.stringify(intervals.map(({ fetchedAt, ...row }) => row))).digest("hex");
    const store = this.day(profile.targetDate);
    const previous = await store.load();
    if (previous.digest === digest) return { changed: false, revision: previous.revision };
    const revision = (previous.revision ?? 0) + 1;
    await store.save({ version: 1, date: profile.targetDate, digest, revision, profile, intervals });
    return { changed: true, revision };
  }
  async loadProfile(date) {
    const saved = await this.day(date).load();
    if (!saved.profile) return null;
    // Revalidate persisted data instead of trusting a partial or edited file.
    normalizeProfile(saved.profile, this);
    return saved.profile;
  }
  async beginPlan(dates) {
    const key = JSON.stringify(dates);
    const saved = await this.pending.load();
    this.plan = saved.key === key ? saved : { key, acquired: [] };
    await this.pending.save(this.plan);
  }
  async loadPendingProfile(date) {
    return this.plan?.acquired.includes(date) ? this.loadProfile(date) : null;
  }
  async checkpoint(date) {
    if (!this.plan) throw new Error("No active history plan");
    if (!this.plan.acquired.includes(date)) this.plan.acquired.push(date);
    await this.pending.save(this.plan);
  }
  async finishPlan() {
    await this.pending.save({});
    this.plan = null;
  }
}
