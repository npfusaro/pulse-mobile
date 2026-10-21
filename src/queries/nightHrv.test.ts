// The Night HRV view model over the 180-day demo seed (whose nights carry five-minute RMSSD samples, a deep-sleep
// RMSSD and personal ranges, as Health Connect and the Google source bring them): last night, the deep stretches,
// the standing against the range, a band-off night, a night without the Google extras, and the hub card.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/data/memory";
import { SCENARIO, seedDemo } from "@/data/seed";
import type { Profile } from "@/data/types";
import { addDays } from "@/lib/time";
import { runPipeline } from "@/pipeline";
import type { QueryCtx } from "./ctx";

const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async (k: string) => storage.get(k) ?? null, setItem: async (k: string, v: string) => void storage.set(k, v), removeItem: async (k: string) => void storage.delete(k) },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => ({ isAvailable: () => true, authorize: async () => ({ accessToken: "t", grantedScopes: [] }) }) }));

const { getNightHrv, hrvChip } = await import("./nightHrv");
const { getHealthHub } = await import("./health");

const TZ = "Asia/Kolkata";
const TODAY = "2026-10-02";
const NOW = Date.parse("2026-10-02T14:00:00+05:30") / 1000;
const PROFILE: Profile = { birthDate: "1990-01-01", sex: "male", maxHr: 183, heightCm: 178, timeZone: TZ };
/** Day index i of the seed as a date (index 179 is today). */
const dayAt = (i: number) => addDays(TODAY, i - 179);

let store: MemoryStore;
let ctx: QueryCtx;
beforeAll(async () => {
  storage.set("pulse.google.connected", "1");
  store = new MemoryStore();
  await seedDemo(store, { today: TODAY, timeZone: TZ, now: NOW });
  await runPipeline(store, PROFILE, { today: TODAY });
  ctx = { store, profile: PROFILE, timeZone: TZ, today: TODAY, now: NOW, sync: { lastSyncTs: NOW, firstDay: addDays(TODAY, -179), lastError: null } };
}, 120_000);

describe("hrvChip", () => {
  it("places an average against the range; nothing without either", () => {
    expect(hrvChip(30, { low: 35, high: 55 })).toEqual({ tone: "warning", text: "Below your range" });
    expect(hrvChip(40, { low: 35, high: 55 })).toEqual({ tone: "optimal", text: "Within 35 - 55" });
    expect(hrvChip(60, { low: 35, high: 55 })).toEqual({ tone: "optimal", text: "Above your range" });
    expect(hrvChip(null, { low: 35, high: 55 })).toBeNull();
    expect(hrvChip(40, null)).toBeNull();
  });
});

describe("getNightHrv", () => {
  it("last night: the five-minute samples across the main sleep, deep sleep lit, Fitbit's nightly values and range, the week", async () => {
    const vm = await getNightHrv(TODAY, ctx);
    expect(vm.isToday).toBe(true);
    expect(vm.connected).toBe(true);
    const night = vm.night.value!;
    const row = (await store.allMetrics()).find((m) => m.day === TODAY)!;
    expect(vm.average.value).toBe(row.hrvMs);
    expect(vm.deep).toBe(row.hrvDeepMs);
    expect(vm.range).toEqual({ low: row.hrvRangeLow, high: row.hrvRangeHigh });
    expect(vm.chip).toEqual(hrvChip(row.hrvMs, vm.range));
    // The samples sit inside the night, five minutes apart, in order; the deep stretches come from the hypnogram.
    const inNight = night.points.filter((p) => p.t >= night.bed && p.t < night.wake);
    expect(inNight.length).toBe(night.readings);
    expect(night.readings).toBeGreaterThan(40);
    for (let i = 1; i < night.points.length; i++) expect(night.points[i].t).toBeGreaterThan(night.points[i - 1].t);
    expect(night.deep.length).toBeGreaterThan(0);
    expect(night.deep.every((d) => d.start >= night.bed && d.end <= night.wake && d.start < d.end)).toBe(true);
    expect(night.high).toEqual(inNight.reduce((m, p) => (p.v > m.v ? p : m)));
    expect(night.low).toEqual(inNight.reduce((m, p) => (p.v < m.v ? p : m)));
    expect(vm.nights.map((n) => n.day)).toEqual(Array.from({ length: 7 }, (_, k) => addDays(TODAY, k - 6)));
    expect(vm.nights.at(-1)).toEqual({ day: TODAY, average: vm.average.value, deep: vm.deep, inRange: vm.average.value! >= vm.range!.low && vm.average.value! <= vm.range!.high });
  });

  it("the illness peak reads under a healthy night; both nights stand against a range", async () => {
    const ill = await getNightHrv(dayAt(SCENARIO.illness.start + 3), ctx);
    const well = await getNightHrv(dayAt(100), ctx);
    expect(ill.average.value!).toBeLessThan(well.average.value!);
    expect(ill.isToday).toBe(false);
    expect(typeof ill.nights.at(-1)!.inRange).toBe("boolean");
    expect(typeof well.chip?.text).toBe("string");
  });

  it("a band-off night has no average or samples with the night's reason; a night with samples but no Google row has no deep value or range", async () => {
    const off = await getNightHrv(dayAt(SCENARIO.bandOff.day + 1), ctx);
    expect(off.average).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.night).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.nights.at(-1)).toEqual({ day: dayAt(SCENARIO.bandOff.day + 1), average: null, deep: null, inRange: null });
    // Strip the Google extras from today's row: the curve and the average stay, the chip and the deep value go.
    const bare = new MemoryStore();
    await seedDemo(bare, { today: TODAY, timeZone: TZ, now: NOW });
    await runPipeline(bare, PROFILE, { today: TODAY });
    const m = (await bare.allMetrics()).find((r) => r.day === TODAY)!;
    await bare.upsertMetrics([{ ...m, hrvDeepMs: null, hrvRangeLow: null, hrvRangeHigh: null }]);
    const plain = await getNightHrv(TODAY, { ...ctx, store: bare });
    expect(plain.average.value).toBe(m.hrvMs);
    expect(plain.night.value!.readings).toBeGreaterThan(40);
    expect(plain.deep).toBeNull();
    expect(plain.range).toBeNull();
    expect(plain.chip).toBeNull();
    expect(plain.nights.at(-1)!.inRange).toBeNull();
  });

  it("a Google nightly row fills a day's deep-sleep RMSSD and range over what Health Connect wrote", async () => {
    const bare = new MemoryStore();
    await seedDemo(bare, { today: TODAY, timeZone: TZ, now: NOW });
    await runPipeline(bare, PROFILE, { today: TODAY });
    const m = (await bare.allMetrics()).find((r) => r.day === TODAY)!;
    await bare.upsertMetrics([{ ...m, hrvDeepMs: null, hrvRangeLow: null, hrvRangeHigh: null }]);
    await bare.upsertGoogleDaily([{ day: TODAY, hrvMs: 99, hrvDeepMs: 61.5, hrvRangeLow: 30, hrvRangeHigh: 50, rhrRangeLow: null, rhrRangeHigh: null }]);
    const vm = await getNightHrv(TODAY, { ...ctx, store: bare });
    expect(vm.average.value).toBe(m.hrvMs); // Health Connect's nightly value stands
    expect(vm.deep).toBe(61.5);
    expect(vm.range).toEqual({ low: 30, high: 50 });
  });

  it("says when Google is not connected, so the screen explains what is missing", async () => {
    storage.delete("pulse.google.connected");
    expect((await getNightHrv(TODAY, ctx)).connected).toBe(false);
    storage.set("pulse.google.connected", "1");
  });

  it("the hub card carries last night's average and deep-sleep RMSSD", async () => {
    const hub = await getHealthHub(ctx);
    const vm = await getNightHrv(TODAY, ctx);
    expect(hub.nightHrv).toEqual({ average: vm.average.value, deep: vm.deep, wake: vm.night.value!.wake });
  });
});
