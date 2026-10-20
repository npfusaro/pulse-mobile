// Google Health API data points → Pulse rows, after the server app's src/server/sources/google/map.ts.
import type { Spo2Sample } from "@/data/types";

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
