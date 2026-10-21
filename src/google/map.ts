// Google Health API data points → Pulse rows, after the server app's src/server/sources/google/map.ts.
import type { GoogleDaily, Spo2Sample } from "@/data/types";
import { ROLLUP, type RollupTypeId } from "./client";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Dotted-path read; undefined when any step is missing. */
function at(v: unknown, path: string): unknown {
  let cur = v;
  for (const k of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** An RFC 3339 instant → unix seconds (whole). */
function secs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

const platform = (p: unknown) => at(p, "dataSource.platform");

/**
 * The band's minute-by-minute blood oxygen, percent to one decimal. HEALTH_CONNECT points (a pulse-oximeter app, a
 * manual entry) are dropped so the samples are the band's alone; a 0 is Fitbit's old sentinel for "could not read"
 * and is skipped. A repeated second keeps the last point. Returned in time order.
 */
export function mapOxygenSaturation(points: unknown[]): Spo2Sample[] {
  const byTs = new Map<number, number>();
  for (const p of points) {
    if (platform(p) === "HEALTH_CONNECT") continue;
    const ts = secs(at(p, "oxygenSaturation.sampleTime.physicalTime"));
    const pct = num(at(p, "oxygenSaturation.percentage"));
    if (ts !== null && pct !== null && pct > 0 && pct <= 100) byTs.set(ts, Math.round(pct * 10) / 10);
  }
  return [...byTs]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, pct]) => ({ ts, pct }));
}

/** `YYYY-MM-DD` from a civil `{year, month, day}` (numbers, or numeric strings). */
function civil(v: unknown): string | null {
  const [y, m, d] = ["year", "month", "day"].map((k) => num(at(v, k)));
  if (y === null || m === null || d === null) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const EMPTY_DAILY: Omit<GoogleDaily, "day"> = { spo2Pct: null, hrvMs: null, hrvDeepMs: null, hrvRangeLow: null, hrvRangeHigh: null, rhrRangeLow: null, rhrRangeHigh: null };

/**
 * `daily-oxygen-saturation` points → one row a day: Fitbit's nightly SpO2 average to one decimal, on Google's civil
 * date (the wake day). A point without an average is skipped; a repeated day keeps the last.
 */
export function mapDailySpo2(points: unknown[]): GoogleDaily[] {
  const byDay = new Map<string, GoogleDaily>();
  for (const p of points) {
    const o = at(p, "dailyOxygenSaturation");
    const day = civil(at(o, "date"));
    const pct = num(at(o, "averagePercentage"));
    if (!day || pct === null || pct <= 0 || pct > 100) continue;
    byDay.set(day, { ...EMPTY_DAILY, day, spo2Pct: Math.round(pct * 10) / 10 });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * `daily-heart-rate-variability` points → one row a day: Fitbit's nightly average RMSSD and its deep-sleep RMSSD, to
 * one decimal, on Google's civil date (the wake day). A point with neither is skipped; a repeated day keeps the last.
 */
export function mapDailyHrv(points: unknown[]): GoogleDaily[] {
  const byDay = new Map<string, GoogleDaily>();
  for (const p of points) {
    const o = at(p, "dailyHeartRateVariability");
    const day = civil(at(o, "date"));
    if (!day) continue;
    const hrvMs = tenth(num(at(o, "averageHeartRateVariabilityMilliseconds")));
    const hrvDeepMs = tenth(num(at(o, "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds")));
    if (hrvMs === null && hrvDeepMs === null) continue;
    byDay.set(day, { ...EMPTY_DAILY, day, hrvMs, hrvDeepMs });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * A `:dailyRollUp` on a daily type → one row a day holding Fitbit's personal range for that vital as of the day
 * (`civilStartTime.date`): HRV in ms to one decimal, resting HR in whole bpm. A range needs both ends and low < high;
 * a day without one is skipped, so a renamed value writes nothing rather than nulls.
 */
export function mapPersonalRange(type: RollupTypeId, points: unknown[]): GoogleDaily[] {
  const byDay = new Map<string, GoogleDaily>();
  for (const p of points) {
    const day = civil(at(p, "civilStartTime.date"));
    const o = at(p, ROLLUP[type].key);
    if (!day || !isObj(o)) continue;
    const hrv = type === "daily-heart-rate-variability";
    const low = hrv ? tenth(num(o.averageHeartRateVariabilityMillisecondsMin)) : whole(num(o.beatsPerMinuteMin));
    const high = hrv ? tenth(num(o.averageHeartRateVariabilityMillisecondsMax)) : whole(num(o.beatsPerMinuteMax));
    if (low === null || high === null || low >= high) continue;
    byDay.set(day, { ...EMPTY_DAILY, day, ...(hrv ? { hrvRangeLow: low, hrvRangeHigh: high } : { rhrRangeLow: low, rhrRangeHigh: high }) });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

const tenth = (v: number | null) => (v === null || v <= 0 ? null : Math.round(v * 10) / 10);
const whole = (v: number | null) => (v === null || v <= 0 ? null : Math.round(v));
