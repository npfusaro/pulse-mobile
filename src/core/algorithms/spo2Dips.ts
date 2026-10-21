// Own algorithm (fork): the night's SpO2 dips, each told apart by the heart's answer. A wrist sensor reads low for
// two reasons: the airway narrowed and oxygen fell, after which the heart rate jumps within a minute or two as the
// sleeper rouses; or the arm the band is on is being slept on, the sensor starved of blood, the heart rate flat.
// A dip is a drop of at least `dropPct` under the running baseline (the median of the valid readings in the
// `baselineMin` minutes before it), from the first minute under to the first minute back within `recoverPct` of
// the baseline. Its heart-rate answer is the highest two-minute mean heart rate from the nadir to `afterMin` minutes
// past the dip's end, against the mean of the `beforeMin` minutes before the dip: a rise of `riseBpm` or more is
// "answered" (an arousal is a short surge, which a long mean would dilute). Minute series in,
// as the Blood oxygen screen draws them (epoch ms, a null minute a gap). Nothing here is medical: a count of
// answered dips is a hint about breathing, not a diagnosis, and the arm explanation is the likelier one, not a fact.

export type MinutePoint = { t: number; v: number | null };

export type DipAnswer = "answered" | "flat" | "unknown";

export type Spo2Dip = {
  /** Epoch ms of the first minute under the threshold and of the first minute recovered (or the last read). */
  start: number;
  end: number;
  /** The lowest minute. */
  nadir: { t: number; v: number };
  /** The baseline it fell from and how far, percentage points. */
  baseline: number;
  drop: number;
  /** The heart's answer: rose, stayed flat, or not enough heart rate around the dip to say. */
  hr: DipAnswer;
  /** The heart's peak (two-minute mean) from the nadir on, minus its mean before the dip, bpm; null when unknown. */
  hrDelta: number | null;
};

export type Spo2DipSummary = {
  dips: number;
  answered: number;
  flat: number;
  unknown: number;
  /** Minutes inside the sleep the band read nothing. */
  gapMin: number;
};

export const spo2DipConfig = {
  /** Points under the baseline that make a dip (the oxygen desaturation index counts 3% drops). */
  dropPct: 3,
  /** Back within this of the baseline ends the dip. */
  recoverPct: 1,
  /** The baseline: the median of the valid readings in these minutes before the dip. */
  baselineMin: 10,
  /** At least this many valid readings in the baseline window, else no dip can start there. */
  baselineMinReadings: 3,
  /** The heart rate before the dip: the mean of these minutes. */
  beforeMin: 5,
  /** The heart's answer is looked for from the nadir to this many minutes past the dip's end. */
  afterMin: 3,
  /** A peak (two-minute mean) this far over the mean before is the heart answering. */
  riseBpm: 5,
  /** Dips closer than this, minutes, are one dip. */
  mergeMin: 2,
  /** Unreadable minutes inside the sleep window count from runs this long; a single missed minute is noise. */
  gapRunMin: 2,
} as const;

type Config = typeof spo2DipConfig;

const MIN = 60_000;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const meanIn = (pts: readonly MinutePoint[], from: number, to: number): number | null => {
  const v = pts.filter((p) => p.t >= from && p.t < to && p.v !== null).map((p) => p.v!);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** The highest mean of two consecutive valid minutes in [from, to); one valid minute stands alone; null with none. */
const peakIn = (pts: readonly MinutePoint[], from: number, to: number): number | null => {
  const v = pts.filter((p) => p.t >= from && p.t < to && p.v !== null).map((p) => p.v!);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  let best = -Infinity;
  for (let i = 1; i < v.length; i++) best = Math.max(best, (v[i - 1] + v[i]) / 2);
  return best;
};

/**
 * The night's dips over [bed, wake) (epoch ms), from the minute SpO2 and, for the heart's answer, the minute heart
 * rate on the same clock (null: every dip is "unknown"). Returned in time order.
 */
export function findSpo2Dips(spo2: readonly MinutePoint[], hr: readonly MinutePoint[] | null, bed: number, wake: number, cfg: Config = spo2DipConfig): Spo2Dip[] {
  const pts = spo2.filter((p) => p.t >= bed && p.t < wake);
  const dips: Spo2Dip[] = [];
  let i = 0;
  while (i < pts.length) {
    const p = pts[i];
    if (p.v === null) {
      i++;
      continue;
    }
    const before = pts.filter((q) => q.t >= p.t - cfg.baselineMin * MIN && q.t < p.t && q.v !== null).map((q) => q.v!);
    if (before.length < cfg.baselineMinReadings) {
      i++;
      continue;
    }
    const baseline = median(before);
    if (p.v > baseline - cfg.dropPct) {
      i++;
      continue;
    }
    // Under: run on until the first valid minute back within recoverPct of the baseline (gaps inside do not end it).
    let j = i;
    let nadir = { t: p.t, v: p.v };
    let end = p.t + MIN;
    while (j < pts.length) {
      const q = pts[j];
      if (q.v !== null) {
        if (q.v >= baseline - cfg.recoverPct) break;
        if (q.v < nadir.v) nadir = { t: q.t, v: q.v };
        end = q.t + MIN;
      }
      j++;
    }
    const start = p.t;
    const prev = dips[dips.length - 1];
    if (prev && start - prev.end < cfg.mergeMin * MIN) {
      // One dip: keep the earlier baseline and the lower nadir.
      prev.end = end;
      if (nadir.v < prev.nadir.v) prev.nadir = nadir;
      prev.drop = Math.round((prev.baseline - prev.nadir.v) * 10) / 10;
    } else dips.push({ start, end, nadir, baseline: Math.round(baseline * 10) / 10, drop: Math.round((baseline - nadir.v) * 10) / 10, hr: "unknown", hrDelta: null });
    i = Math.max(j, i + 1);
  }
  for (const d of dips) {
    const pre = hr ? meanIn(hr, d.start - cfg.beforeMin * MIN, d.start) : null;
    const post = hr ? peakIn(hr, d.nadir.t, d.end + cfg.afterMin * MIN) : null;
    if (pre === null || post === null) continue;
    d.hrDelta = Math.round((post - pre) * 10) / 10;
    d.hr = d.hrDelta >= cfg.riseBpm ? "answered" : "flat";
  }
  return dips;
}

/** Minutes inside [bed, wake) with no reading, counted in runs of `gapRunMin` or more. */
export function spo2GapMinutes(spo2: readonly MinutePoint[], bed: number, wake: number, cfg: Config = spo2DipConfig): number {
  const pts = spo2.filter((p) => p.t >= bed && p.t < wake);
  if (!pts.length) return 0;
  let total = 0;
  let run = 0;
  for (const p of pts) {
    if (p.v === null) run++;
    else {
      if (run >= cfg.gapRunMin) total += run;
      run = 0;
    }
  }
  if (run >= cfg.gapRunMin) total += run;
  return total;
}

export function summarizeSpo2Dips(dips: readonly Spo2Dip[], gapMin: number): Spo2DipSummary {
  const count = (k: DipAnswer) => dips.filter((d) => d.hr === k).length;
  return { dips: dips.length, answered: count("answered"), flat: count("flat"), unknown: count("unknown"), gapMin };
}
