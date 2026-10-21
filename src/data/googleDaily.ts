// Google's nightly extras (google_daily) folded into a day's Metrics, for both stores' allMetrics. Google's
// deep-sleep RMSSD and personal ranges win (Health Connect never has them); Google's nightly average only fills a
// day Health Connect left empty, so the scored value stays Health Connect's.
import { emptyMetrics, type GoogleDaily, type Metrics } from "./types";

export const withGoogleDaily = (m: Metrics, g: GoogleDaily | undefined): Metrics =>
  g
    ? {
        ...m,
        hrvMs: m.hrvMs ?? g.hrvMs,
        hrvDeepMs: g.hrvDeepMs ?? m.hrvDeepMs,
        hrvRangeLow: g.hrvRangeLow ?? m.hrvRangeLow,
        hrvRangeHigh: g.hrvRangeHigh ?? m.hrvRangeHigh,
        rhrRangeLow: g.rhrRangeLow ?? m.rhrRangeLow,
        rhrRangeHigh: g.rhrRangeHigh ?? m.rhrRangeHigh,
      }
    : m;

/** Every day of either list, in day order: Google's row folded into the day's Metrics, or alone on an empty one. */
export function mergeGoogleDaily(metrics: Metrics[], google: GoogleDaily[]): Metrics[] {
  if (!google.length) return metrics;
  const byDay = new Map(google.map((g) => [g.day, g]));
  const out = metrics.map((m) => {
    const g = byDay.get(m.day);
    byDay.delete(m.day);
    return withGoogleDaily(m, g);
  });
  for (const g of byDay.values()) out.push(withGoogleDaily(emptyMetrics(g.day), g));
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The nightly values and the ranges merged by day, a null never replacing a value: what the store's upsert does. */
export function mergeGoogleRows(into: Map<string, GoogleDaily>, rows: GoogleDaily[]): void {
  for (const r of rows) {
    const prev = into.get(r.day);
    into.set(r.day, prev ? { day: r.day, hrvMs: r.hrvMs ?? prev.hrvMs, hrvDeepMs: r.hrvDeepMs ?? prev.hrvDeepMs, hrvRangeLow: r.hrvRangeLow ?? prev.hrvRangeLow, hrvRangeHigh: r.hrvRangeHigh ?? prev.hrvRangeHigh, rhrRangeLow: r.rhrRangeLow ?? prev.rhrRangeLow, rhrRangeHigh: r.rhrRangeHigh ?? prev.rhrRangeHigh } : { ...r });
  }
}
