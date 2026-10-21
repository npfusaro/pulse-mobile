// The Google source on the in-memory store against a scripted Google: the history window in 14-day windows, the
// cursor and resume, a longer window re-walking from its new start, deletions inside a re-read window, the mapping,
// the nightly rows (daily HRV and the personal-range roll-ups) merged into the days' metrics, a cursor from an
// older sync version re-walking, and a failing Google leaving a warning (never a throw).
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => storage.get(k) ?? null,
    setItem: async (k: string, v: string) => void storage.set(k, v),
    removeItem: async (k: string) => void storage.delete(k),
    multiRemove: async (ks: string[]) => ks.forEach((k) => storage.delete(k)),
  },
}));
// The native module is absent in Node: `authorize` would reject UNAVAILABLE, so every test passes its own token.
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));

const { MemoryStore } = await import("@/data/memory");
const { buildFilter, localWindows } = await import("./client");
const { mapDailyHrv, mapOxygenSaturation, mapPersonalRange } = await import("./map");
const { GOOGLE_SYNC_KEY, OVERLAP_DAYS, readGoogleSyncState, SYNC_VERSION, syncGoogle } = await import("./sync");

const TZ = "America/New_York";
/** 2026-10-20 14:00 local (18:00Z). */
const NOW = Date.parse("2026-10-20T18:00:00Z");
const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);

type Point = { name: string; platform?: string; t: string; pct: number };
const point = (p: Point) => ({
  name: `users/me/dataTypes/oxygen-saturation/dataPoints/${p.name}`,
  dataSource: { platform: p.platform ?? "FITBIT", recordingMethod: "ACTIVELY_MEASURED" },
  oxygenSaturation: { percentage: p.pct, sampleTime: { physicalTime: p.t, utcOffset: "-14400s" } },
});

/** A night of readings: one a minute from `start` for `minutes`, around `pct`. */
const night = (name: string, start: string, minutes: number, pct = 97) =>
  Array.from({ length: minutes }, (_, i) => point({ name: `${name}-${i}`, t: new Date(Date.parse(start) + i * 60_000).toISOString(), pct: pct + ((i * 7) % 5) / 10 }));

const civil = (day: string) => {
  const [year, month, d] = day.split("-").map(Number);
  return { year, month, day: d };
};
/** A daily HRV point on `day`. */
const dailyHrv = (day: string, avg: number | null, deep: number | null) => ({
  name: `users/me/dataTypes/daily-heart-rate-variability/dataPoints/${day}`,
  dataSource: { platform: "FITBIT" },
  dailyHeartRateVariability: { date: civil(day), ...(avg !== null && { averageHeartRateVariabilityMilliseconds: avg }), ...(deep !== null && { deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: deep }) },
});
/** A rolled-up personal range on `day`. */
const rangePoint = (type: string, day: string, min: number, max: number) => ({
  civilStartTime: { date: civil(day) },
  civilEndTime: { date: civil(day) },
  ...(type === "daily-heart-rate-variability"
    ? { heartRateVariabilityPersonalRange: { averageHeartRateVariabilityMillisecondsMin: min, averageHeartRateVariabilityMillisecondsMax: max } }
    : { restingHeartRatePersonalRange: { beatsPerMinuteMin: min, beatsPerMinuteMax: max } }),
});

let data: ReturnType<typeof point>[];
let dailyData: ReturnType<typeof dailyHrv>[];
let ranges: Record<string, [number, number]>;
let calls: { type: string; filter?: string; range?: unknown }[];
let failWith: number | null;
/** When set, every roll-up answers 400 INVALID_ARGUMENT with this message (the lists keep working). */
let rollupFail: string | null;

const dateOf = (p: ReturnType<typeof dailyHrv>) => {
  const { year, month, day } = p.dailyHeartRateVariability.date;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const dayStr = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const nextDay = (day: string) => new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

/** Answers each request from the scripted data: lists page by 3 to exercise pagination; roll-ups answer one point a day. */
const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const type = /dataTypes\/([a-z-]+)\//.exec(url.pathname)![1];
  if (failWith) return new Response(JSON.stringify({ error: { code: failWith, status: "UNAVAILABLE" } }), { status: failWith });
  if (url.pathname.endsWith(":dailyRollUp")) {
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { range: { start: { date: { year: number; month: number; day: number } }; end: { date: { year: number; month: number; day: number } } } };
    expect(Object.keys(body)).toEqual(["range"]); // the live API rejects the reference's page fields
    const { range } = body;
    calls.push({ type: `${type}:rollup`, range });
    if (rollupFail) return new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: rollupFail } }), { status: 400 });
    const points = [];
    for (let d = dayStr(range.start.date); d < dayStr(range.end.date); d = nextDay(d)) {
      const r = ranges[`${type}:${d}`];
      if (r) points.push(rangePoint(type, d, r[0], r[1]));
    }
    return new Response(JSON.stringify({ rollupDataPoints: points }), { status: 200 });
  }
  const filter = url.searchParams.get("filter")!;
  const pageToken = url.searchParams.get("pageToken");
  calls.push({ type, filter });
  const [, lo, hi] = /(?:physical_time|date) >= "([^"]+)" AND \S+ < "([^"]+)"/.exec(filter)!;
  const inWin =
    type === "oxygen-saturation"
      ? data.filter((p) => p.oxygenSaturation.sampleTime.physicalTime >= lo && p.oxygenSaturation.sampleTime.physicalTime < hi)
      : dailyData.filter((p) => dateOf(p) >= lo && dateOf(p) < hi);
  const from = pageToken ? Number(pageToken) : 0;
  const page = inWin.slice(from, from + 3);
  const next = from + 3 < inWin.length ? String(from + 3) : undefined;
  return new Response(JSON.stringify({ dataPoints: page, ...(next && { nextPageToken: next }) }), { status: 200 });
}) as typeof fetch;

let clock: number;
let store: InstanceType<typeof MemoryStore>;
const run = (historyDays: number, tokenOk = true) =>
  syncGoogle(store, {
    timeZone: TZ,
    historyDays,
    now: () => clock,
    fetch: fetchFn,
    sleep: async (ms) => void (clock += ms),
    token: async () => {
      if (!tokenOk) throw new (await import("../../modules/pulse-google-auth/errors")).GoogleAuthError("NEEDS_CONSENT", "no grant");
      return "tok";
    },
  });
const lowerBound = (f: string) => /"([^"]+)"/.exec(f)![1];
const spo2Calls = () => calls.filter((c) => c.type === "oxygen-saturation");
const all = () => store.readSpo2(0, 2 ** 31);
/** The band's points of `data` as the mapper stores them, in time order. */
const expected = () => mapOxygenSaturation(data);
const metricsOf = async (day: string) => (await store.allMetrics()).find((m) => m.day === day);

beforeEach(() => {
  storage.clear();
  store = new MemoryStore();
  clock = NOW;
  calls = [];
  failWith = null;
  rollupFail = null;
  data = [...night("a", "2026-10-19T03:00:00Z", 7, 96), ...night("b", "2026-10-20T03:30:00Z", 5, 97.5)];
  dailyData = [dailyHrv("2026-10-19", 41.26, 55.5), dailyHrv("2026-10-20", 38, 49.94)];
  ranges = { "daily-heart-rate-variability:2026-10-20": [31.5, 52.25], "daily-resting-heart-rate:2026-10-20": [52.4, 58.6], "daily-resting-heart-rate:2026-10-19": [52, 59] };
});

describe("google client", () => {
  it("splits a span at local midnights into 14-day windows and filters on physical time in UTC", () => {
    const from = s("2026-04-24T04:00:00Z"); // local midnight, 24 April
    const to = s("2026-05-20T15:00:00Z");
    const w = localWindows(from, to, 14, TZ);
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ start: from, end: s("2026-05-08T04:00:00Z") });
    expect(w[1].end).toBe(to);
    expect(buildFilter("oxygen-saturation", w[0], TZ)).toBe(
      'oxygen_saturation.sample_time.physical_time >= "2026-04-24T04:00:00.000Z" AND oxygen_saturation.sample_time.physical_time < "2026-05-08T04:00:00.000Z"',
    );
  });

  it("filters a daily type on local days, the end rounded up to a whole day", () => {
    const w = { start: s("2026-04-24T04:00:00Z"), end: s("2026-05-20T15:00:00Z") };
    expect(buildFilter("daily-heart-rate-variability", w, TZ)).toBe('daily_heart_rate_variability.date >= "2026-04-24" AND daily_heart_rate_variability.date < "2026-05-21"');
    expect(buildFilter("daily-resting-heart-rate", { start: w.start, end: s("2026-05-08T04:00:00Z") }, TZ)).toBe('daily_resting_heart_rate.date >= "2026-04-24" AND daily_resting_heart_rate.date < "2026-05-08"');
  });
});

describe("mapOxygenSaturation", () => {
  it("keeps the band's points to one decimal, drops Health Connect and 0, keeps the last of a repeated second", () => {
    const out = mapOxygenSaturation([
      point({ name: "1", t: "2026-10-19T03:00:00Z", pct: 97.26 }),
      point({ name: "2", t: "2026-10-19T03:01:00Z", pct: 99, platform: "HEALTH_CONNECT" }),
      point({ name: "3", t: "2026-10-19T03:02:00Z", pct: 0 }),
      point({ name: "4", t: "2026-10-19T03:00:00Z", pct: 96.1 }),
      point({ name: "5", t: "2026-10-19T03:03:00Z", pct: 93.55 }),
    ]);
    expect(out).toEqual([
      { ts: s("2026-10-19T03:00:00Z"), pct: 96.1 },
      { ts: s("2026-10-19T03:03:00Z"), pct: 93.6 },
    ]);
  });
});

describe("nightly mappers", () => {
  it("mapDailyHrv keeps the average and deep-sleep RMSSD to one decimal on Google's day; a point with neither goes", () => {
    expect(mapDailyHrv([dailyHrv("2026-10-20", 38, 49.94), dailyHrv("2026-10-19", 41.26, null), dailyHrv("2026-10-18", null, null), { dailyHeartRateVariability: { date: { year: 2026, month: 10 } } }])).toEqual([
      { day: "2026-10-19", hrvMs: 41.3, hrvDeepMs: null, hrvRangeLow: null, hrvRangeHigh: null, rhrRangeLow: null, rhrRangeHigh: null },
      { day: "2026-10-20", hrvMs: 38, hrvDeepMs: 49.9, hrvRangeLow: null, hrvRangeHigh: null, rhrRangeLow: null, rhrRangeHigh: null },
    ]);
  });

  it("mapPersonalRange reads each type's range value, needs both ends and low < high, rounds HRV to a tenth and resting HR to a beat", () => {
    expect(mapPersonalRange("daily-heart-rate-variability", [rangePoint("daily-heart-rate-variability", "2026-10-20", 31.55, 52.21), rangePoint("daily-heart-rate-variability", "2026-10-19", 40, 40)])).toEqual([
      { day: "2026-10-20", hrvMs: null, hrvDeepMs: null, hrvRangeLow: 31.6, hrvRangeHigh: 52.2, rhrRangeLow: null, rhrRangeHigh: null },
    ]);
    expect(mapPersonalRange("daily-resting-heart-rate", [rangePoint("daily-resting-heart-rate", "2026-10-20", 52.4, 58.6), { civilStartTime: { date: civil("2026-10-19") }, restingHeartRatePersonalRange: { beatsPerMinuteMin: 50 } }])).toEqual([
      { day: "2026-10-20", hrvMs: null, hrvDeepMs: null, hrvRangeLow: null, hrvRangeHigh: null, rhrRangeLow: 52, rhrRangeHigh: 59 },
    ]);
  });
});

describe("syncGoogle", () => {
  it("first import: the history window oldest first in 14-day windows, every page, into spo2_days", async () => {
    const r = await run(30);
    expect(r.warnings).toEqual([]);
    expect(r.samples).toBe(12);
    // 30 local days ending today → from local midnight 21 September; 14-day windows → 3 requests plus pages.
    expect(lowerBound(spo2Calls()[0].filter!)).toBe("2026-09-21T04:00:00.000Z");
    const starts = [...new Set(spo2Calls().map((c) => lowerBound(c.filter!)))];
    expect(starts).toEqual(["2026-09-21T04:00:00.000Z", "2026-10-05T04:00:00.000Z", "2026-10-19T04:00:00.000Z"]);
    expect(spo2Calls().length).toBeGreaterThan(3); // paged
    expect(await all()).toEqual(expected());
    expect(await readGoogleSyncState()).toMatchObject({ version: SYNC_VERSION, backfillDays: 30, backfillDone: 30, lastError: null, syncedThrough: Math.floor(NOW / 1000) });
  });

  it("writes each night's HRV and the ranges into the day's metrics; a roll-up covers the window's local days", async () => {
    const r = await run(30);
    expect(r.nights).toBe(2);
    expect(await metricsOf("2026-10-19")).toMatchObject({ hrvMs: 41.3, hrvDeepMs: 55.5, hrvRangeLow: null, rhrRangeLow: 52, rhrRangeHigh: 59 });
    expect(await metricsOf("2026-10-20")).toMatchObject({ hrvMs: 38, hrvDeepMs: 49.9, hrvRangeLow: 31.5, hrvRangeHigh: 52.3, rhrRangeLow: 52, rhrRangeHigh: 59 });
    // The daily list and both roll-ups ask for the same windows as the samples, on civil days.
    const rollups = calls.filter((c) => c.type === "daily-heart-rate-variability:rollup");
    expect(rollups).toHaveLength(3);
    expect(rollups[0].range).toEqual({ start: { date: civil("2026-09-21") }, end: { date: civil("2026-10-05") } });
    expect(rollups[2].range).toEqual({ start: { date: civil("2026-10-19") }, end: { date: civil("2026-10-21") } });
    expect(calls.filter((c) => c.type === "daily-resting-heart-rate:rollup")).toHaveLength(3);
    expect(lowerBound(calls.find((c) => c.type === "daily-heart-rate-variability")!.filter!)).toBe("2026-09-21");
  });

  it("Health Connect's nightly average wins over Google's; Google's deep-sleep RMSSD and ranges fill the row", async () => {
    await store.upsertMetrics([{ ...(await import("@/data/types")).emptyMetrics("2026-10-20"), hrvMs: 37.2, rhrBpm: 55 }]);
    await run(30);
    expect(await metricsOf("2026-10-20")).toMatchObject({ hrvMs: 37.2, rhrBpm: 55, hrvDeepMs: 49.9, hrvRangeLow: 31.5, rhrRangeHigh: 59 });
  });

  it("a later sync re-reads from a few days before the cursor, and a reading Google dropped goes", async () => {
    await run(30);
    calls = [];
    clock += 6 * 3_600_000;
    data = data.filter((p) => !p.name.endsWith("/b-4")); // deleted in Fitbit
    data.push(point({ name: "c", t: "2026-10-20T19:00:00Z", pct: 95 }));
    const r = await run(30);
    expect(r.warnings).toEqual([]);
    expect(lowerBound(spo2Calls()[0].filter!)).toBe(`2026-10-${20 - OVERLAP_DAYS}T04:00:00.000Z`);
    expect(await all()).toEqual(expected());
    expect((await all()).at(-1)).toEqual({ ts: s("2026-10-20T19:00:00Z"), pct: 95 });
  });

  it("a longer history re-walks from the new start; a shorter one changes nothing", async () => {
    await run(30);
    calls = [];
    await run(60);
    expect(lowerBound(spo2Calls()[0].filter!)).toBe("2026-08-22T04:00:00.000Z");
    expect(await readGoogleSyncState()).toMatchObject({ backfillDays: 60, backfillDone: 60 });
    calls = [];
    clock += 3_600_000;
    await run(10);
    expect(lowerBound(spo2Calls()[0].filter!)).toBe(`2026-10-${20 - OVERLAP_DAYS}T04:00:00.000Z`);
    expect(await readGoogleSyncState()).toMatchObject({ backfillDays: 60 });
  });

  it("a cursor written by an older sync version re-walks the whole history window (new types get backfilled)", async () => {
    await run(30);
    const st = await readGoogleSyncState();
    storage.set(GOOGLE_SYNC_KEY, JSON.stringify({ ...st, version: SYNC_VERSION - 1 }));
    calls = [];
    clock += 3_600_000;
    await run(30);
    expect(lowerBound(spo2Calls()[0].filter!)).toBe("2026-09-21T04:00:00.000Z");
    expect(await readGoogleSyncState()).toMatchObject({ version: SYNC_VERSION, backfillDays: 30, backfillDone: 30 });
  });

  it("a roll-up Google rejects leaves the SpO2 and the daily HRV in place, moves the cursor on, and surfaces as the run's failure with Google's reason", async () => {
    rollupFail = 'Invalid JSON payload received. Unknown name "pageSize": Cannot find field.';
    const r = await run(30);
    expect(r.samples).toBe(12);
    expect(r.nights).toBe(2);
    expect(r.warnings).toEqual(["google_error:INVALID_ARGUMENT"]);
    const st = await readGoogleSyncState();
    expect(st).toMatchObject({ backfillDone: 30, syncedThrough: Math.floor(NOW / 1000) });
    expect(st.lastError).toBe('[google] daily-heart-rate-variability dailyRollUp: INVALID_ARGUMENT (HTTP 400) — Invalid JSON payload received. Unknown name "pageSize": Cannot find field.');
    expect(await all()).toEqual(expected());
    expect(await metricsOf("2026-10-20")).toMatchObject({ hrvDeepMs: 49.9, hrvRangeLow: null, rhrRangeLow: null });
    // The request Google sees is the range alone.
    expect(calls.find((c) => c.type === "daily-heart-rate-variability:rollup")!.range).toEqual({ start: { date: civil("2026-09-21") }, end: { date: civil("2026-10-05") } });
  });

  it("an interrupted import resumes at its cursor", async () => {
    failWith = 503;
    const r = await run(30);
    expect(r.warnings).toEqual(["google_error:UNAVAILABLE"]);
    expect((await readGoogleSyncState()).lastError).toMatch(/UNAVAILABLE/);
    failWith = null;
    calls = [];
    const r2 = await run(30);
    expect(r2.warnings).toEqual([]);
    expect(lowerBound(spo2Calls()[0].filter!)).toBe("2026-09-21T04:00:00.000Z"); // nothing was committed before the failure
    expect(await all()).toHaveLength(12);
  });

  it("without a grant it warns google_needs_consent and writes nothing; nothing throws", async () => {
    const r = await run(30, false);
    expect(r).toEqual({ samples: 0, nights: 0, warnings: ["google_needs_consent"] });
    expect(await all()).toEqual([]);
    expect(await store.allMetrics()).toEqual([]);
    expect((await readGoogleSyncState()).syncedThrough).toBeNull();
  });
});
