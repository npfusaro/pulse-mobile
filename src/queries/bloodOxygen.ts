// Blood oxygen (fork addition, a Pulse-only extra): the band's minute-by-minute SpO2 from the Google source
// (src/google) across a night, the night's average, and the week of nights. Ported from the server app's
// getBloodOxygen (src/server/queries/health.ts). Nothing here is scored; the engine's Health Monitor still leaves
// SpO2 out (Fitbit writes none to Health Connect), so the standing is the fixed 95–100 range Fitbit uses.
import { findSpo2Dips, type Spo2Dip, type Spo2DipSummary, spo2GapMinutes, summarizeSpo2Dips } from "@/core/algorithms/spo2Dips";
import { isGoogleConnected } from "@/google/auth";
import { addDays } from "@/lib/time";
import { type DayRow, finite, loadDays, ms, none, ok, type QueryCtx, todayOf, vitalReason } from "./common";
import { nightHrOf } from "./sleep";
import type { BloodOxygenVM, HealthHubVM, NightSpo2, TimePoint } from "./types";

/** Readings strictly under this count as low, the way Fitbit and the Health Monitor flag them ("Below 95%"). */
export const SPO2_LOW_PCT = 95;
const PAD_S = 15 * 60;

/**
 * The band's blood oxygen over the sleep [start, end) (unix seconds) plus 15 minutes each side, on the minute grid;
 * a minute the band did not read is null. The band reads SpO2 once a minute asleep and drops unreliable minutes, so
 * gaps are normal and nothing here judges the count: an empty night is the caller's "no readings". The night's
 * per-minute heart rate rides along on the same grid (the Sleep page's series), for the chart to overlay.
 */
export async function nightSpo2Of(ctx: QueryCtx, start: number, end: number): Promise<NightSpo2 & { samples: { ts: number; pct: number }[] }> {
  const from = Math.floor((start - PAD_S) / 60) * 60;
  const to = end + PAD_S;
  const [samples, hr] = await Promise.all([ctx.store.readSpo2(from, to), nightHrOf(ctx, start, end)]);
  // One reading a minute; should two land in one, the last wins (as the sync keeps the last of a repeated second).
  const byMin = new Map(samples.map((s) => [Math.floor(s.ts / 60) * 60, s.pct]));
  const points: TimePoint[] = [];
  for (let m = from; m < to; m += 60) points.push({ t: ms(m), v: byMin.get(m) ?? null });
  return { bed: ms(start), wake: ms(end), points, hr: hr.value?.points ?? null, samples };
}

type NightStats = { readMin: number; mean: number; low: { t: number; v: number }; below95Min: number; dips: Spo2Dip[]; dipSummary: Spo2DipSummary };

/** A main sleep's readings summarised, its dips judged by the heart's answer; null when the band kept none for it. */
async function spo2Stats(ctx: QueryCtx, main: { start: number; end: number }): Promise<(NightStats & { night: NightSpo2 }) | null> {
  const night = await nightSpo2Of(ctx, main.start, main.end);
  const inNight = night.samples.filter((x) => x.ts >= main.start && x.ts < main.end);
  if (!inNight.length) return null;
  const low = inNight.reduce((m, x) => (x.pct < m.pct ? x : m));
  const dips = findSpo2Dips(night.points, night.hr, night.bed, night.wake);
  return {
    night: { bed: night.bed, wake: night.wake, points: night.points, hr: night.hr },
    readMin: inNight.length,
    mean: Math.round((inNight.reduce((a, x) => a + x.pct, 0) / inNight.length) * 10) / 10,
    low: { t: ms(low.ts), v: low.pct },
    below95Min: inNight.filter((x) => x.pct < SPO2_LOW_PCT).length,
    dips,
    dipSummary: summarizeSpo2Dips(dips, spo2GapMinutes(night.points, night.bed, night.wake)),
  };
}

/** The night's average: Fitbit's nightly value when Health Connect has one, else the readings' own mean. */
const nightAverage = (row: DayRow | undefined, stats: NightStats | null): number | null => (finite(row?.metrics?.spo2Pct) ? row!.metrics!.spo2Pct! : (stats?.mean ?? null));

/** Where an average stands against Fitbit's 95–100: the Health Monitor's wording for SpO2. */
export function spo2Chip(average: number | null): BloodOxygenVM["chip"] {
  if (!finite(average)) return null;
  return average < SPO2_LOW_PCT ? { tone: "warning", text: "Below 95%" } : { tone: "optimal", text: "Within 95 - 100" };
}

/**
 * Blood oxygen `/health/blood-oxygen?d=`: the band's minute-by-minute SpO2 across the night ending on `day` (its main
 * sleep), the night's average and standing, and the week of nights ending there. Fitbit reads SpO2 only while asleep,
 * so there is nothing live about today: today's night is last night's.
 */
export async function getBloodOxygen(day: string, ctx: QueryCtx): Promise<BloodOxygenVM> {
  const isToday = day === todayOf(ctx);
  const [rows, connected] = await Promise.all([loadDays(ctx, addDays(day, -6), day), isGoogleConnected()]);
  const row = rows.get(day);
  const noNight = vitalReason(row, isToday);

  const week = await Promise.all(
    Array.from({ length: 7 }, (_, k) => addDays(day, k - 6)).map(async (d) => {
      const r = rows.get(d);
      const main = r?.sleep?.main;
      const stats = main ? await spo2Stats(ctx, main) : null;
      return { day: d, main, stats, average: nightAverage(r, stats) };
    }),
  );
  const tonight = week.at(-1)!;
  const st = tonight.stats;

  return {
    day,
    isToday,
    connected,
    average: finite(tonight.average) ? ok(tonight.average) : none(noNight),
    night: st ? ok({ ...st.night, low: st.low, readMin: st.readMin, below95Min: st.below95Min, dips: st.dips, dipSummary: st.dipSummary }) : none(tonight.main ? "no_data" : noNight),
    chip: spo2Chip(tonight.average),
    nights: week.map((n) => ({
      day: n.day,
      average: n.average,
      low: n.stats?.low.v ?? null,
      below95Min: n.stats?.below95Min ?? null,
      answered: n.stats?.dipSummary.answered ?? null,
      flat: n.stats?.dipSummary.flat ?? null,
    })),
  };
}

/** Last night's blood oxygen for the Health hub card: today's main sleep's readings, when the band kept any. */
export async function lastNightSpo2(ctx: QueryCtx, row: DayRow | undefined): Promise<HealthHubVM["bloodOxygen"]> {
  const main = row?.sleep?.main;
  const stats = main ? await spo2Stats(ctx, main) : null;
  return stats ? { average: nightAverage(row, stats)!, low: stats.low.v, wake: ms(main!.end) } : null;
}
