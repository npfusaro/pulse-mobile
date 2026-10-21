// The Blood oxygen view model over the 180-day demo seed (whose nights carry a minute of SpO2 each, as the Google
// source brings them): last night, the illness week, a band-off night, a night without readings, and the hub card.
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

const { getBloodOxygen } = await import("./bloodOxygen");
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

describe("getBloodOxygen", () => {
  it("last night: minute readings across the main sleep with gaps, the low marked, Fitbit's nightly average, the week", async () => {
    const vm = await getBloodOxygen(TODAY, ctx);
    expect(vm.isToday).toBe(true);
    expect(vm.connected).toBe(true);
    const night = vm.night.value!;
    const row = (await store.allMetrics()).find((m) => m.day === TODAY)!;
    expect(vm.average.value).toBe(row.spo2Pct);
    expect(vm.chip).toEqual(row.spo2Pct! < 95 ? { tone: "warning", text: "Below 95%" } : { tone: "optimal", text: "Within 95 - 100" });
    // One point a minute from 15 minutes before bed to 15 after waking; the band reads only asleep, so the ends are gaps.
    expect(night.points[0].t).toBe(night.bed - 15 * 60_000);
    expect(night.points.at(-1)!.t).toBe(night.wake + 15 * 60_000 - 60_000);
    expect(night.points.slice(0, 15).every((p) => p.v === null)).toBe(true);
    const read = night.points.filter((p) => p.v !== null);
    expect(read.length).toBe(night.readMin);
    expect(night.readMin).toBeGreaterThan(200);
    expect(night.readMin).toBeLessThan((night.wake - night.bed) / 60_000); // gaps: minutes the band could not read
    expect(night.low).toEqual(read.reduce<{ t: number; v: number }>((m, p) => (p.v! < m.v ? { t: p.t, v: p.v! } : m), { t: 0, v: Infinity }));
    expect(night.below95Min).toBe(read.filter((p) => p.v! < 95).length);
    // The night's heart rate on the same minute grid, for the overlay.
    expect(night.hr).not.toBeNull();
    expect(night.hr!.length).toBe(night.points.length);
    expect(night.hr!.map((p) => p.t)).toEqual(night.points.map((p) => p.t));
    expect(night.hr!.filter((p) => p.v !== null).length).toBeGreaterThan(night.points.length / 2);
    expect(vm.nights.map((n) => n.day)).toEqual(Array.from({ length: 7 }, (_, k) => addDays(TODAY, k - 6)));
    expect(vm.nights.at(-1)).toEqual({ day: TODAY, average: vm.average.value, low: night.low.v, below95Min: night.below95Min, answered: night.dipSummary.answered, flat: night.dipSummary.flat });
    // The night's dips, each judged by the heart (the seed carries heart rate, so none is unknown), in time order.
    expect(night.dipSummary.dips).toBe(night.dips.length);
    expect(night.dipSummary.answered + night.dipSummary.flat + night.dipSummary.unknown).toBe(night.dips.length);
    expect(night.dipSummary.unknown).toBe(0);
    for (const d of night.dips) {
      expect(d.drop).toBeGreaterThanOrEqual(3);
      expect(d.nadir.t).toBeGreaterThanOrEqual(night.bed);
      expect(d.nadir.t).toBeLessThan(night.wake);
    }
    expect(night.dipSummary.gapMin).toBeGreaterThan(0);
  });

  it("the illness peak reads lower than a healthy night, with minutes under 95%", async () => {
    const ill = await getBloodOxygen(dayAt(SCENARIO.illness.start + 3), ctx);
    const well = await getBloodOxygen(dayAt(100), ctx);
    expect(ill.average.value!).toBeLessThan(well.average.value!);
    expect(ill.night.value!.below95Min).toBeGreaterThan(well.night.value!.below95Min);
    expect(ill.isToday).toBe(false);
  });

  it("a band-off night has no average or readings with the night's reason; a night with no samples is no_data", async () => {
    const off = await getBloodOxygen(dayAt(SCENARIO.bandOff.day + 1), ctx);
    expect(off.average).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.night).toMatchObject({ value: null, reason: "band_not_worn" });
    expect(off.nights.at(-1)).toEqual({ day: dayAt(SCENARIO.bandOff.day + 1), average: null, low: null, below95Min: null, answered: null, flat: null });
    // The night's reason needs the scored night (DayRow.sleep.main), so the bare store is scored too.
    const bare = new MemoryStore();
    await seedDemo(bare, { today: TODAY, timeZone: TZ, now: NOW });
    await runPipeline(bare, PROFILE, { today: TODAY });
    await bare.clearSpo2();
    const none = await getBloodOxygen(TODAY, { ...ctx, store: bare });
    expect(none.night).toMatchObject({ value: null, reason: "no_data" });
    expect(none.average.value).not.toBeNull(); // Fitbit's nightly value still stands without the minutes
  });

  it("says when Google is not connected, so the screen explains instead of showing empty states", async () => {
    storage.delete("pulse.google.connected");
    expect((await getBloodOxygen(TODAY, ctx)).connected).toBe(false);
    storage.set("pulse.google.connected", "1");
  });

  it("the hub card carries last night's average and low", async () => {
    const hub = await getHealthHub(ctx);
    const vm = await getBloodOxygen(TODAY, ctx);
    expect(hub.bloodOxygen).toEqual({ average: vm.average.value, low: vm.night.value!.low.v, wake: vm.night.value!.wake });
  });
});
