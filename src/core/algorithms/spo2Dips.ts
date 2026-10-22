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

// ── Arm stretches: the slow sag the dip rule cannot see ───────────────────────────────────────────────────────────
// An arm slept on does not drop the reading abruptly; it sags over minutes and holds low for an hour or two, and the
// dip rule's baseline sags with it. So a stretch is judged against the night's own good level instead: minutes whose
// smoothed reading sits `armDropPct` or more under the night's upper reference (its `armRefQuantile` quantile), in a
// run of `armRunMin` minutes or longer (unread minutes inside it count), with the heart rate quiet across the run
// (its mean within `armHrQuietBpm` of the mean before the run, and no two-minute peak `riseBpm` over it). A real
// hypoxic stretch would not leave the heart that still.

export type ArmStretch = {
  start: number;
  end: number;
  /** Minutes with a reading inside the stretch, and minutes with none. */
  readMin: number;
  gapMin: number;
  /** The stretch's mean reading and how far under the night's reference it sat. */
  meanPct: number;
  drop: number;
};

export const armStretchConfig = {
  /** The night's good level: this quantile of its readings. */
  armRefQuantile: 0.9,
  /** Under the reference by this much (after smoothing) is low. */
  armDropPct: 3,
  /** The running median over this many minutes, so single-minute spikes do not start or end a stretch. */
  armSmoothMin: 5,
  /** A low run shorter than this is a dip's business, not a stretch. */
  armRunMin: 10,
  /** Up to this many minutes back at or near the reference inside a run do not end it (a brief lift, a reposition). */
  armBridgeMin: 3,
  /** The heart rate across the stretch within this of the 10 minutes before it is "quiet". */
  armHrQuietBpm: 4,
} as const;

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
};

/** The running median of the valid readings within ±half the window; null where the minute itself has none. */
function runningMedian(pts: readonly MinutePoint[], windowMin: number): (number | null)[] {
  const half = Math.floor(windowMin / 2);
  return pts.map((p, i) => {
    if (p.v === null) return null;
    const v: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(pts.length - 1, i + half); j++) if (pts[j].v !== null) v.push(pts[j].v!);
    return median(v);
  });
}

/**
 * The night's arm stretches over [bed, wake) (epoch ms), from the minute SpO2 and heart rate. Without heart rate no
 * stretch is called (a sustained low with nothing to clear it could as well be real), so the list is empty.
 */
export function findArmStretches(spo2: readonly MinutePoint[], hr: readonly MinutePoint[] | null, bed: number, wake: number, cfg = { ...spo2DipConfig, ...armStretchConfig }): ArmStretch[] {
  if (!hr) return [];
  const pts = spo2.filter((p) => p.t >= bed && p.t < wake);
  const valid = pts.filter((p) => p.v !== null).map((p) => p.v!);
  if (valid.length < cfg.armRunMin) return [];
  const ref = quantile(valid, cfg.armRefQuantile);
  const smooth = runningMedian(pts, cfg.armSmoothMin);
  const low = smooth.map((v) => (v === null ? null : v <= ref - cfg.armDropPct));
  const out: ArmStretch[] = [];
  let i = 0;
  while (i < pts.length) {
    if (low[i] !== true) {
      i++;
      continue;
    }
    // Run on while low; unread minutes ride along; a lift back up ends it only past armBridgeMin minutes.
    let j = i;
    let lastLow = i;
    let lift = 0;
    while (j < pts.length) {
      if (low[j] === true) {
        lastLow = j;
        lift = 0;
      } else if (low[j] === false) {
        lift++;
        if (lift > cfg.armBridgeMin) break;
      }
      j++;
    }
    const slice = pts.slice(i, lastLow + 1);
    const start = pts[i].t;
    const end = pts[lastLow].t + MIN;
    if (slice.length >= cfg.armRunMin) {
      const read = slice.filter((p) => p.v !== null).map((p) => p.v!);
      const pre = meanIn(hr, start - 10 * MIN, start);
      const during = meanIn(hr, start, end);
      const peak = peakIn(hr, start, end);
      const quiet = pre !== null && during !== null && peak !== null && Math.abs(during - pre) <= cfg.armHrQuietBpm && peak - pre < cfg.riseBpm;
      if (quiet && read.length) {
        const meanPct = read.reduce((a, b) => a + b, 0) / read.length;
        out.push({ start, end, readMin: read.length, gapMin: slice.length - read.length, meanPct: Math.round(meanPct * 10) / 10, drop: Math.round((ref - meanPct) * 10) / 10 });
      }
    }
    i = lastLow + 1;
  }
  return out;
}

/**
 * The night's mean reading with the arm taken out: the minutes outside every arm stretch and outside every dip the
 * heart did not answer. Null when nothing is left. To one decimal.
 */
export function cleanAverage(spo2: readonly MinutePoint[], bed: number, wake: number, arm: readonly ArmStretch[], dips: readonly Spo2Dip[]): number | null {
  const out = [...arm.map((a) => [a.start, a.end]), ...dips.filter((d) => d.hr === "flat").map((d) => [d.start, d.end])];
  const v = spo2.filter((p) => p.t >= bed && p.t < wake && p.v !== null && !out.some(([s, e]) => p.t >= s && p.t < e)).map((p) => p.v!);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}
