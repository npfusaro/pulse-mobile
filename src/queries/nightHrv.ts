// Night HRV (fork addition, a Pulse-only extra): the band's five-minute RMSSD across a night from Health Connect's
// samples (hrv_days, the ones the engine scores), with what the Google source adds to the night: Fitbit's deep-sleep
// RMSSD and its personal range for the nightly average, both on the day's metrics (src/data/googleDaily.ts). Nothing
// here is scored; Recovery keeps its own baseline, and the chip is only where the night sits in Fitbit's range.
import { isGoogleConnected } from "@/google/auth";
import { addDays } from "@/lib/time";
import { type DayRow, finite, loadDays, ms, none, ok, type QueryCtx, todayOf, vitalReason } from "./common";
import type { HealthHubVM, NightHrv, NightHrvVM } from "./types";

const PAD_S = 15 * 60;

/**
 * The band's HRV samples over the sleep [start, end) (unix seconds) plus 15 minutes each side, in time order, with
 * the night's deep-sleep stretches (its hypnogram's deep segments; none when the night has no stages). Fitbit keeps
 * one RMSSD every five minutes and drops stretches it could not read, so gaps are normal.
 */
export async function nightHrvOf(ctx: QueryCtx, main: { id: string; start: number; end: number }): Promise<NightHrv> {
  const [samples, segments] = await Promise.all([ctx.store.readHrv(main.start - PAD_S, main.end + PAD_S), ctx.store.segmentsFor([main.id])]);
  const deep = segments
    .filter((g) => g.stage === "deep")
    .sort((a, b) => a.startTs - b.startTs)
    .map((g) => ({ start: ms(g.startTs), end: ms(g.endTs) }));
  return { bed: ms(main.start), wake: ms(main.end), points: samples.map((x) => ({ t: ms(x.ts), v: Math.round(x.ms * 10) / 10 })), deep };
}

type NightStats = { readings: number; mean: number; high: { t: number; v: number }; low: { t: number; v: number } };

/** A main sleep's samples summarised; null when the band kept none inside it. */
async function hrvStats(ctx: QueryCtx, main: { id: string; start: number; end: number }): Promise<(NightStats & { night: NightHrv }) | null> {
  const night = await nightHrvOf(ctx, main);
  const inNight = night.points.filter((p) => p.t >= night.bed && p.t < night.wake);
  if (!inNight.length) return null;
  const high = inNight.reduce((m, p) => (p.v > m.v ? p : m));
  const low = inNight.reduce((m, p) => (p.v < m.v ? p : m));
  return { night, readings: inNight.length, mean: Math.round((inNight.reduce((a, p) => a + p.v, 0) / inNight.length) * 10) / 10, high, low };
}

/** The night's average: Fitbit's nightly RMSSD when Health Connect has one, else the samples' own mean. */
const nightAverage = (row: DayRow | undefined, stats: NightStats | null): number | null => (finite(row?.metrics?.hrvMs) ? row!.metrics!.hrvMs! : (stats?.mean ?? null));

/** Fitbit's personal range for the day, when the Google source has written one. */
const rangeOf = (row: DayRow | undefined): NightHrvVM["range"] => {
  const m = row?.metrics;
  return finite(m?.hrvRangeLow) && finite(m?.hrvRangeHigh) && m!.hrvRangeLow! < m!.hrvRangeHigh! ? { low: m!.hrvRangeLow!, high: m!.hrvRangeHigh! } : null;
};

/** Where an average sits against Fitbit's range: the Health Monitor's wording. Above the range is good news for HRV. */
export function hrvChip(average: number | null, range: NightHrvVM["range"]): NightHrvVM["chip"] {
  if (!finite(average) || !range) return null;
  if (average < range.low) return { tone: "warning", text: "Below your range" };
  if (average > range.high) return { tone: "optimal", text: "Above your range" };
  return { tone: "optimal", text: `Within ${range.low} - ${range.high}` };
}

/**
 * Night HRV `/health/night-hrv?d=`: the band's five-minute RMSSD across the night ending on `day` (its main sleep),
 * the night's average against Fitbit's range, its deep-sleep RMSSD, and the week of nights ending there. Fitbit
 * reads HRV only while asleep, so today's night is last night's.
 */
export async function getNightHrv(day: string, ctx: QueryCtx): Promise<NightHrvVM> {
  const isToday = day === todayOf(ctx);
  const [rows, connected] = await Promise.all([loadDays(ctx, addDays(day, -6), day), isGoogleConnected()]);
  const row = rows.get(day);
  const noNight = vitalReason(row, isToday, true);

  const week = await Promise.all(
    Array.from({ length: 7 }, (_, k) => addDays(day, k - 6)).map(async (d) => {
      const r = rows.get(d);
      const main = r?.sleep?.main;
      const stats = main ? await hrvStats(ctx, main) : null;
      const average = nightAverage(r, stats);
      const range = rangeOf(r);
      return { day: d, main, stats, average, deep: finite(r?.metrics?.hrvDeepMs) ? r!.metrics!.hrvDeepMs! : null, range };
    }),
  );
  const tonight = week.at(-1)!;
  const st = tonight.stats;

  return {
    day,
    isToday,
    connected,
    average: finite(tonight.average) ? ok(tonight.average) : none(noNight),
    deep: tonight.deep,
    range: tonight.range,
    chip: hrvChip(tonight.average, tonight.range),
    night: st ? ok({ ...st.night, high: st.high, low: st.low, readings: st.readings }) : none(tonight.main ? "no_hrv_last_night" : noNight),
    nights: week.map((n) => ({
      day: n.day,
      average: n.average,
      deep: n.deep,
      inRange: finite(n.average) && n.range ? n.average! >= n.range.low && n.average! <= n.range.high : null,
    })),
  };
}

/** Last night's HRV for the Health hub card: today's main sleep's average and Fitbit's deep-sleep RMSSD, when the band kept any. */
export async function lastNightHrv(ctx: QueryCtx, row: DayRow | undefined): Promise<HealthHubVM["nightHrv"]> {
  const main = row?.sleep?.main;
  const stats = main ? await hrvStats(ctx, main) : null;
  const average = nightAverage(row, stats);
  return stats && finite(average) ? { average: average!, deep: finite(row?.metrics?.hrvDeepMs) ? row!.metrics!.hrvDeepMs! : null, wake: ms(main!.end) } : null;
}
