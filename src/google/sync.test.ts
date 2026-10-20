// The Google source on the in-memory store against a scripted Google: the history window in 14-day windows, the
// cursor and resume, a longer window re-walking from its new start, deletions inside a re-read window, the mapping,
// and a failing Google leaving a warning (never a throw).
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
const { mapOxygenSaturation } = await import("./map");
const { OVERLAP_DAYS, readGoogleSyncState, syncGoogle } = await import("./sync");

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

let data: ReturnType<typeof point>[];
let calls: { filter: string; status?: number }[];
let failWith: number | null;

/** Answers each list request from `data` inside its window; pages of 3 to exercise pagination. */
const fetchFn = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const filter = url.searchParams.get("filter")!;
  const pageToken = url.searchParams.get("pageToken");
  calls.push({ filter });
  if (failWith) return new Response(JSON.stringify({ error: { code: failWith, status: "UNAVAILABLE" } }), { status: failWith });
  const [, lo, hi] = /physical_time >= "([^"]+)" AND \S+ < "([^"]+)"/.exec(filter)!;
  const inWin = data.filter((p) => p.oxygenSaturation.sampleTime.physicalTime >= lo && p.oxygenSaturation.sampleTime.physicalTime < hi);
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
const all = () => store.readSpo2(0, 2 ** 31);
/** The band's points of `data` as the mapper stores them, in time order. */
const expected = () => mapOxygenSaturation(data);

beforeEach(() => {
  storage.clear();
  store = new MemoryStore();
  clock = NOW;
  calls = [];
  failWith = null;
  data = [...night("a", "2026-10-19T03:00:00Z", 7, 96), ...night("b", "2026-10-20T03:30:00Z", 5, 97.5)];
});

describe("google client", () => {
  it("splits a span at local midnights into 14-day windows and filters on physical time in UTC", () => {
    const from = s("2026-04-24T04:00:00Z"); // local midnight, 24 April
    const to = s("2026-05-20T15:00:00Z");
    const w = localWindows(from, to, 14, TZ);
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ start: from, end: s("2026-05-08T04:00:00Z") });
    expect(w[1].end).toBe(to);
    expect(buildFilter("oxygen-saturation", w[0])).toBe(
      'oxygen_saturation.sample_time.physical_time >= "2026-04-24T04:00:00.000Z" AND oxygen_saturation.sample_time.physical_time < "2026-05-08T04:00:00.000Z"',
    );
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

describe("syncGoogle", () => {
  it("first import: the history window oldest first in 14-day windows, every page, into spo2_days", async () => {
    const r = await run(30);
    expect(r.warnings).toEqual([]);
    expect(r.samples).toBe(12);
    // 30 local days ending today → from local midnight 21 September; 14-day windows → 3 requests plus pages.
    expect(lowerBound(calls[0].filter)).toBe("2026-09-21T04:00:00.000Z");
    const starts = [...new Set(calls.map((c) => lowerBound(c.filter)))];
    expect(starts).toEqual(["2026-09-21T04:00:00.000Z", "2026-10-05T04:00:00.000Z", "2026-10-19T04:00:00.000Z"]);
    expect(calls.length).toBeGreaterThan(3); // paged
    expect(await all()).toEqual(expected());
    expect(await readGoogleSyncState()).toMatchObject({ backfillDays: 30, backfillDone: 30, lastError: null, syncedThrough: Math.floor(NOW / 1000) });
  });

  it("a later sync re-reads from a few days before the cursor, and a reading Google dropped goes", async () => {
    await run(30);
    calls = [];
    clock += 6 * 3_600_000;
    data = data.filter((p) => !p.name.endsWith("/b-4")); // deleted in Fitbit
    data.push(point({ name: "c", t: "2026-10-20T19:00:00Z", pct: 95 }));
    const r = await run(30);
    expect(r.warnings).toEqual([]);
    expect(lowerBound(calls[0].filter)).toBe(`2026-10-${20 - OVERLAP_DAYS}T04:00:00.000Z`);
    expect(await all()).toEqual(expected());
    expect((await all()).at(-1)).toEqual({ ts: s("2026-10-20T19:00:00Z"), pct: 95 });
  });

  it("a longer history re-walks from the new start; a shorter one changes nothing", async () => {
    await run(30);
    calls = [];
    await run(60);
    expect(lowerBound(calls[0].filter)).toBe("2026-08-22T04:00:00.000Z");
    expect(await readGoogleSyncState()).toMatchObject({ backfillDays: 60, backfillDone: 60 });
    calls = [];
    clock += 3_600_000;
    await run(10);
    expect(lowerBound(calls[0].filter)).toBe(`2026-10-${20 - OVERLAP_DAYS}T04:00:00.000Z`);
    expect(await readGoogleSyncState()).toMatchObject({ backfillDays: 60 });
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
    expect(lowerBound(calls[0].filter)).toBe("2026-09-21T04:00:00.000Z"); // nothing was committed before the failure
    expect(await all()).toHaveLength(12);
  });

  it("without a grant it warns google_needs_consent and writes nothing; nothing throws", async () => {
    const r = await run(30, false);
    expect(r).toEqual({ samples: 0, warnings: ["google_needs_consent"] });
    expect(await all()).toEqual([]);
    expect((await readGoogleSyncState()).syncedThrough).toBeNull();
  });
});
