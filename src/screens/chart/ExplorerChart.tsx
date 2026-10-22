// The chart explorer's plot: a series and up to three to compare (fork: was one), each on its own scale, over a
// viewport that pinches, pans (with momentum) and animates between ranges, a crosshair with a readout, all on the UI
// thread. The series are built once in data space and mapped to the
// screen each frame by one affine transform of the path (so strokes keep their width at any zoom); the axes, grid,
// bands and labels are re-recorded as a Skia picture from the viewport. JS only hears about the viewport when a gesture
// settles (to refit the y axis and the summary), never per frame.
import * as React from "react";
import { View } from "react-native";
import {
  Canvas,
  Circle,
  createPicture,
  DashPathEffect,
  Group,
  Line,
  LinearGradient,
  PaintStyle,
  Path,
  Picture,
  RoundedRect,
  Skia,
  StrokeCap,
  Text as SkText,
  rect,
  vec,
  type SkPaint,
} from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDecay, withTiming, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { bandStops, type Band } from "@/lib/charts";
import { barsWeight, clampStart, dataXAt, firstTickAtOrAfter, minuteText, nearestValued, pickLevel, type TickLevel } from "@/lib/chartmath";
import { linePath, segments } from "@/ui/charts/geometry";
import { alpha } from "@/ui/color";
import type { Palette } from "@/ui/palette";
import { useTheme } from "@/ui/theme";
import { measure, type ChartFonts } from "./fonts";
import { lengthText, STAGE_NAME, type Domain, type Series } from "./model";

// Our chart language (src/ui/charts): the dashed grid, muted axis text, the chart cursor, card-coloured rings, a popover
// readout; workouts in Strain's blue and the night in Sleep's, as SpanFills draws them.
const LINE = { width: 2.5, thin: 2 } as const;
const inkOf = (c: Palette) => ({
  grid: c["chart-grid"],
  axis: c["muted-foreground"],
  ink: c.foreground,
  sub: c["foreground-secondary"],
  guide: c["chart-cursor"],
  cursor: c["chart-cursor"],
  ring: c.card,
  scrubRing: c.card,
  readout: c.popover,
  readoutEdge: c["popover-ring"],
  wash: c["fill-faint"],
  pill: c.secondary,
  workout: c.strain,
  sleep: c.sleep,
});

/** The draw-in without redrawing: the canvas is revealed left to right by two counter-moving native views. */
function NativeReveal({ progress, width, height, children }: { progress: SharedValue<number>; width: number; height: number; children: React.ReactNode }) {
  const outer = useAnimatedStyle(() => ({ transform: [{ translateX: -width * (1 - progress.value) }] }));
  const inner = useAnimatedStyle(() => ({ transform: [{ translateX: width * (1 - progress.value) }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ width, height, overflow: "hidden" }, outer]}>
      <Animated.View style={[{ width, height }, inner]}>{children}</Animated.View>
    </Animated.View>
  );
}

export type StageLane = { stage: "awake" | "rem" | "light" | "deep"; from: number; to: number };
/** A marked stretch of a day (minutes): a workout, the night's sleep or a nap, named in the lane over the plot. */
export type DaySpan = { kind: "workout" | "sleep"; label: string; from: number; to: number };

export type ExplorerChartProps = {
  width: number;
  height: number;
  mode: "daily" | "day";
  primary: Series;
  /**
   * The primary's trailing mean on the same xs (model.ts trendSeries), when the days on show are too many to read
   * raw: drawn bold as the line, the days behind it as dots and a faint trace. Null draws the primary as the line.
   */
  trend?: Series | null;
  /** The series to compare, each on its own scale (up to MAX_COMPARES); the first one's labels on the right axis. */
  compares: Series[];
  /** Each compare's trailing mean (as `trend`), or null. */
  compareTrends: (Series | null)[];
  extent: { min: number; max: number; minSpan: number };
  /** The viewport JS last knew (the range's window, or where a gesture settled); a change animates there. */
  window: { start: number; span: number };
  /** The range's own window: a double tap glides back to it. */
  home: { start: number; span: number };
  domain: Domain;
  /** Each compare's scale, aligned to the primary's grid. */
  domains2: Domain[];
  /** Tick text for `domain.ticks`, and per compare for its `domains2` ticks. */
  yLabels: string[];
  y2Labels: string[][];
  levels: TickLevel[];
  /** A shaded range [low, high] on the primary axis: the normal range, or the day's Strain Target. */
  baseline: [number, number] | null;
  /** A dashed, labelled line (the goal, a reference, the day's resting or average heart rate). */
  goal: { y: number; label: string } | null;
  /** The day's stretches, in time order (day views). */
  spans: DaySpan[];
  /** `workouts`: the workouts drawn bold and named with their length, the night quiet. */
  emphasis: "workouts" | null;
  stages: StageLane[];
  /** The night's bed and wake (sleep view), minutes: dashed guides, named over the plot. */
  bed: number | null;
  wake: number | null;
  now: number | null;
  /**
   * The readout's text per primary point (date, value, each compare's value, note), the value's colour, and per
   * compare its dot's colours (null: the compare's own colour).
   */
  readout: { dates: string[]; values: string[]; compares: string[][]; notes: string[]; colors: string[]; compareColors: (string[] | null)[] };
  /** The series' names, set before their values in the readout; a null name leaves the value alone (the header names it). */
  names: { primary: string | null; compares: string[] } | null;
  /** Per compare, per primary point, the compare point beside it (-1: none). */
  compareIdx: number[][];
  lineColor: string;
  /** Colour bands for the primary series (recovery bands, stress levels, heart-rate zones): a gradient by value. */
  bands: Band[] | null;
  /** Per primary point, whether it is drawn in full (the minutes inside a workout); the rest of the line stays quiet. */
  hot: boolean[] | null;
  /** Per primary point, the bar colour group (0-2 for banded bars; 3 for today's running total). */
  barGroup: number[];
  /** Today's running total's colour, drawn faded and outlined ("so far"); null when today has none. */
  partialColor: string | null;
  barColors: string[];
  /** Each compare's colour. */
  compareColors: string[];
  /** Per compare, colour bands for its line (heart-rate zones beside Day Strain); null draws it in its colour. */
  compareBands: (Band[] | null)[];
  /** The primary's latest point, ringed and labelled with its value (Day Strain so far); null for none. */
  latest: { index: number; text: string } | null;
  /** Changes when the data changes: the viewport jumps (no animation) and the series draws in again. */
  dataKey: string;
  onViewport: (start: number, span: number) => void;
  fonts: ChartFonts;
};

const BASE_LEFT = 48;
const TOP = 10;
/** The lane over a day's plot that names its stretches (workouts, sleep, naps) and the night's bed and wake. */
const NAME_LANE = 18;
const X_AXIS = 28;
/** The night's stage lanes under the plot: four rows of LANE_H, LANE_GAP apart, LANES_TOP below the plot. */
const LANE_H = 11;
const LANE_GAP = 4;
const LANES_TOP = 10;
const LANES = LANES_TOP + 4 * LANE_H + 3 * LANE_GAP;
const STAGE_ORDER = ["awake", "rem", "light", "deep"] as const;
const MOVE_MS = 420;
/** A right-axis column of tick labels, one per compare that has room (one in portrait, all three when wide). */
const AXIS_COL = 42;
/** At least this wide, every compare gets its own labelled column on the right. */
const WIDE = 560;
/** The x axis keeps its labels at least this far apart (a clock time or a date is about 30 px at 12 px): six months get monthly ticks. */
const TICK_GAP = 42;

/**
 * A series in data space, y normalised to 0-1000 over its own extremes (keeps float precision for any unit), or over
 * `range` (a part of a series drawn on top of it). Flat stretches keep only their ends (a running total is flat for
 * hours): the curve is the same, with far fewer segments to map each frame.
 */
function dataPaths(series: Series | null, range?: { lo: number; hi: number }) {
  const empty = { line: Skia.Path.Make(), area: Skia.Path.Make(), dots: Skia.Path.Make(), lo: 0, hi: 1 };
  if (!series) return empty;
  const vals = series.ys.filter((v): v is number => v !== null);
  if (!vals.length) return empty;
  let lo = range?.lo ?? Math.min(...vals);
  let hi = range?.hi ?? Math.max(...vals);
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const n = (y: number) => ((y - lo) / (hi - lo)) * 1000;
  const pts = series.xs.map((x, i) => ({ x, y: series.ys[i] === null ? null : n(series.ys[i]!) }));
  const parts = series.sparse ? segments(pts.filter((p) => p.y !== null)) : segments(pts);
  let line = "";
  let area = "";
  for (const whole of parts) {
    if (!whole.length) continue;
    const run = whole.filter((q, i) => i === 0 || i === whole.length - 1 || q.y !== whole[i - 1].y || q.y !== whole[i + 1].y);
    // A lone point still shows: a short segment the round cap turns into a dot.
    const r = run.length === 1 ? [run[0], { x: run[0].x + 0.01, y: run[0].y }] : run;
    const d = linePath(r, "monotone");
    line += d;
    area += `${d}L${r[r.length - 1].x} -100000L${r[0].x} -100000Z`;
  }
  // Every read day as a zero-length segment: the round cap makes it a dot of the stroke's width at any zoom.
  const dots = pts.flatMap((q) => (q.y === null ? [] : [`M${q.x} ${q.y}L${q.x + 0.001} ${q.y}`])).join("");
  return { line: Skia.Path.MakeFromSVGString(line) ?? Skia.Path.Make(), area: Skia.Path.MakeFromSVGString(area) ?? Skia.Path.Make(), dots: Skia.Path.MakeFromSVGString(dots) ?? Skia.Path.Make(), lo, hi };
}

function paint(color: string, stroke?: { width: number; dash?: number[]; round?: boolean }): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  if (stroke) {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(stroke.width);
    if (stroke.round) p.setStrokeCap(StrokeCap.Round);
    if (stroke.dash) p.setPathEffect(Skia.PathEffect.MakeDash(stroke.dash, 0));
  }
  return p;
}

type Geo = { LEFT: number; plotW: number; plotH: number; bottom: number };
const EMPTY_PATH = Skia.Path.Make();

/**
 * One compare's scale, paths and crosshair dot (called for each of the MAX_COMPARES slots, filled or not, so the
 * hooks keep their order). Its y axis animates to its window like the primary's.
 */
function useCompareSlot(i: number, p: ExplorerChartProps, start: SharedValue<number>, span: SharedValue<number>, idx: SharedValue<number>, glide: (sv: SharedValue<number>, to: number) => void, geo: Geo, fallback: string) {
  const series = p.compares[i] ?? null;
  const trend = p.compareTrends[i] ?? null;
  const domain = p.domains2[i] ?? null;
  const labels = p.y2Labels[i];
  const { LEFT, plotW, plotH, bottom } = geo;
  const lo = useSharedValue(domain?.lo ?? 0);
  const hi = useSharedValue(domain?.hi ?? 1);
  const ticks = useSharedValue((domain?.ticks ?? []).map((v, j) => ({ v, text: labels?.[j] ?? "" })));
  // New data: the scale jumps into place (the primary's effect redraws the rest).
  React.useEffect(() => {
    if (!domain) return;
    lo.set(domain.lo);
    hi.set(domain.hi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.dataKey]);
  React.useEffect(() => {
    if (!domain) return;
    ticks.set(domain.ticks.map((v, j) => ({ v, text: labels?.[j] ?? "" })));
    glide(lo, domain.lo);
    glide(hi, domain.hi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, labels]);

  const paths = React.useMemo(() => dataPaths(series), [series]);
  const tPaths = React.useMemo(() => (trend ? dataPaths(trend, paths) : null), [trend, paths]);
  const m = useDerivedValue(() => {
    const sx = plotW / span.value;
    const sc = plotH / (hi.value - lo.value);
    const k = (paths.hi - paths.lo) / 1000;
    return [sx, 0, LEFT - start.value * sx, 0, -k * sc, bottom - (paths.lo - lo.value) * sc, 0, 0, 1];
  });
  const line = useDerivedValue(() => Skia.PathBuilder.MakeFromPath(paths.line).transform(m.value).detach());
  const tLine = useDerivedValue(() => (tPaths ? Skia.PathBuilder.MakeFromPath(tPaths.line).transform(m.value).detach() : EMPTY_PATH));

  const xs = series?.xs ?? [];
  const ys = series?.ys ?? [];
  const cidx = p.compareIdx[i] ?? [];
  const on = useDerivedValue(() => (idx.value >= 0 ? (cidx[idx.value] ?? -1) : -1));
  const dotX = useDerivedValue(() => (on.value < 0 ? -1000 : LEFT + ((xs[on.value] - start.value) / span.value) * plotW));
  const dotY = useDerivedValue(() => {
    const v = on.value < 0 ? null : ys[on.value];
    return v === null || v === undefined ? -1000 : bottom - ((v - lo.value) / (hi.value - lo.value)) * plotH;
  });
  const color = p.compareColors[i] ?? fallback;
  const colors = p.readout.compareColors[i] ?? null;
  const dotColor = useDerivedValue(() => (on.value < 0 || !colors ? color : (colors[on.value] ?? color)));
  const texts = p.readout.compares[i] ?? [];
  const text = useDerivedValue(() => (idx.value < 0 ? "" : (texts[idx.value] ?? "")));
  const bands = p.compareBands[i] ?? null;
  const stops = React.useMemo(() => (series && bands ? bandStops(paths.hi, paths.lo, bands) : null), [series, bands, paths]);
  const gStart = useDerivedValue(() => vec(0, bottom - ((paths.hi - lo.value) / (hi.value - lo.value)) * plotH));
  const gEnd = useDerivedValue(() => vec(0, bottom - ((paths.lo - lo.value) / (hi.value - lo.value)) * plotH + 0.01));
  return { series, trend: !!tPaths, lo, hi, ticks, line, tLine, dotX, dotY, dotColor, text, color, stops, gStart, gEnd };
}

export function ExplorerChart(p: ExplorerChartProps) {
  const { c } = useTheme();
  const k = React.useMemo(() => inkOf(c), [c]);
  const reduce = useReducedMotion();
  const { width, height, extent, fonts } = p;

  // --- Fonts and the text measured once ---
  const axisFont = fonts.num(500, 12);
  const pillFont = fonts.num(700, 11);
  const nameFont = fonts.sans(600, 11);
  const laneFont = fonts.sans(700, 11);
  const timeFont = fonts.num(600, 11);
  const laneNames = React.useMemo(() => STAGE_ORDER.map((s) => STAGE_NAME[s].toUpperCase()), []);
  const laneW = React.useMemo(() => Math.max(...laneNames.map((t) => measure(laneFont, t))), [laneNames, laneFont]);

  // --- Layout: the night's lanes need room for their names; a day names its stretches in a lane over the plot ---
  const LEFT = p.stages.length ? Math.max(BASE_LEFT, Math.ceil(laneW) + 14) : BASE_LEFT;
  const nCmp = p.compares.length;
  // One labelled column on the right per compare that has room: the first in portrait, every one when wide.
  const axisCols = nCmp ? Math.min(nCmp, width >= WIDE ? nCmp : 1) : 0;
  const right = nCmp ? 6 + axisCols * AXIS_COL : 14;
  const plotW = Math.max(1, width - LEFT - right);
  const lanes = p.stages.length ? LANES : 0;
  const named = p.mode === "day" && (p.spans.length > 0 || p.bed !== null || p.wake !== null);
  const top = TOP + (named ? NAME_LANE : 0);
  const bottom = height - X_AXIS - lanes;
  const plotH = Math.max(1, bottom - top);
  const { min, max, minSpan } = extent;

  // --- The viewport and the axes, animated on the UI thread ---
  const start = useSharedValue(p.window.start);
  const span = useSharedValue(p.window.span);
  const lo = useSharedValue(p.domain.lo);
  const hi = useSharedValue(p.domain.hi);
  const homeStart = useSharedValue(p.home.start);
  const homeSpan = useSharedValue(p.home.span);
  const cursor = useSharedValue(NaN);
  const pinching = useSharedValue(false);
  const pinchSpan = useSharedValue(1);
  const focal = useSharedValue(0);
  const progress = useSharedValue(0);
  const yTicks = useSharedValue(p.domain.ticks.map((v, i) => ({ v, text: p.yLabels[i] ?? "" })));

  const timing = { duration: MOVE_MS, easing: Easing.out(Easing.cubic) };
  const glide = (sv: typeof start, to: number) => {
    if (reduce) sv.set(to);
    else sv.set(withTiming(to, timing));
  };

  // New data (another metric, day or compare): everything jumps into place and the series draws in again. Declared
  // first, so the glides below find their values already there.
  React.useEffect(() => {
    cancelAnimation(start);
    cancelAnimation(span);
    start.set(p.window.start);
    span.set(p.window.span);
    lo.set(p.domain.lo);
    hi.set(p.domain.hi);
    cursor.set(NaN);
    if (reduce) progress.set(1);
    else {
      progress.set(0);
      progress.set(withTiming(1, { duration: 600, easing: Easing.out(Easing.cubic) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.dataKey]);
  React.useEffect(() => {
    homeStart.set(p.home.start);
    homeSpan.set(p.home.span);
  }, [p.home.start, p.home.span, homeStart, homeSpan]);
  // A new range glides there (a viewport a gesture settled on comes back here already on screen).
  React.useEffect(() => {
    if (Math.abs(start.get() - p.window.start) < 1e-6 && Math.abs(span.get() - p.window.span) < 1e-6) return;
    cancelAnimation(start);
    cancelAnimation(span);
    glide(start, p.window.start);
    glide(span, p.window.span);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.window.start, p.window.span]);
  // The y axes refit to the window: the grid and labels slide to their new rows.
  React.useEffect(() => {
    yTicks.set(p.domain.ticks.map((v, i) => ({ v, text: p.yLabels[i] ?? "" })));
    glide(lo, p.domain.lo);
    glide(hi, p.domain.hi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.domain, p.yLabels]);

  // --- Series geometry (data space, built once per series) ---
  const prim = React.useMemo(() => dataPaths(p.primary), [p.primary]);
  // The trend on the primary's scale, so one matrix maps both.
  const trendPaths = React.useMemo(() => (p.trend ? dataPaths(p.trend, prim) : null), [p.trend, prim]);
  // The workouts day: the minutes inside a workout as a series of their own, on the primary's scale.
  const hotPaths = React.useMemo(
    () => (p.hot && p.hot.some(Boolean) ? dataPaths({ ...p.primary, sparse: false, ys: p.primary.ys.map((y, i) => (p.hot![i] ? y : null)) }, prim) : null),
    [p.hot, p.primary, prim],
  );
  const empties = React.useMemo(() => Array.from({ length: 7 }, () => Skia.Path.Make()), []);

  const toScreen = (s: number, sp: number, l: number, h: number, dLo: number, dHi: number) => {
    "worklet";
    const sx = plotW / sp;
    const sc = plotH / (h - l);
    const k = (dHi - dLo) / 1000;
    return [sx, 0, LEFT - s * sx, 0, -k * sc, bottom - (dLo - l) * sc, 0, 0, 1];
  };
  const lineM = useDerivedValue(() => toScreen(start.value, span.value, lo.value, hi.value, prim.lo, prim.hi));
  const line = useDerivedValue(() => Skia.PathBuilder.MakeFromPath(prim.line).transform(lineM.value).detach());
  const area = useDerivedValue(() => Skia.PathBuilder.MakeFromPath(prim.area).transform(lineM.value).detach());
  const dots = useDerivedValue(() => (trendPaths ? Skia.PathBuilder.MakeFromPath(prim.dots).transform(lineM.value).detach() : empties[1]));
  const trendLine = useDerivedValue(() => (trendPaths ? Skia.PathBuilder.MakeFromPath(trendPaths.line).transform(lineM.value).detach() : empties[2]));
  const trendArea = useDerivedValue(() => (trendPaths ? Skia.PathBuilder.MakeFromPath(trendPaths.area).transform(lineM.value).detach() : empties[3]));
  const hotLine = useDerivedValue(() => (hotPaths ? Skia.PathBuilder.MakeFromPath(hotPaths.line).transform(lineM.value).detach() : empties[0]));
  const hotArea = useDerivedValue(() => (hotPaths ? Skia.PathBuilder.MakeFromPath(hotPaths.area).transform(lineM.value).detach() : empties[0]));
  // The crosshair's primary point (the compares find theirs beside it).
  const xs0 = p.primary.xs;
  const ys0 = p.primary.ys;
  const idx = useDerivedValue(() => (Number.isNaN(cursor.value) ? -1 : nearestValued(xs0, ys0, cursor.value)));
  // The compares: three slots, filled in order.
  const geo = { LEFT, plotW, plotH, bottom };
  const slot0 = useCompareSlot(0, p, start, span, idx, glide, geo, c["chart-4"]);
  const slot1 = useCompareSlot(1, p, start, span, idx, glide, geo, c["chart-2"]);
  const slot2 = useCompareSlot(2, p, start, span, idx, glide, geo, c["chart-1"]);
  const slots = [slot0, slot1, slot2].slice(0, nCmp);

  const isBar = p.primary.mark === "bar";
  const barW8 = useDerivedValue(() => (isBar ? barsWeight(span.value) : 0));
  const lineAlpha = useDerivedValue(() => 1 - barW8.value);
  const xs = p.primary.xs;
  const ys = p.primary.ys;
  const groups = p.barGroup;
  /** A bar's rounded rect at the viewport (worklet): w wide, its top r round, running r past the floor. */
  // (Memoised: the derived values below key on their closure, so a re-render with the same data keeps them.)
  const barRect = React.useCallback(
    (i: number, s: number, sp: number, l: number, h: number) => {
      "worklet";
      const v = ys[i];
      if (v === null || v === undefined) return null;
      const per = plotW / sp;
      // TrendChart's bar: 80 % of the day's band (a 10 % gap each side), at most 28 wide, 4 round.
      const w = Math.min(28, per * 0.8);
      const r = Math.min(4, w / 2);
      const base = bottom - ((Math.max(l, 0) - l) / (h - l)) * plotH;
      const cx = LEFT + (xs[i] - s) * per;
      const y = bottom - ((v - l) / (h - l)) * plotH;
      if (base - y <= 0) return null;
      // The bar runs r past the floor, where the clip hides its lower corners: square at the base, round on top.
      return Skia.RRectXY(Skia.XYWHRect(cx - w / 2, y, w, base - y + r), r, r);
    },
    [xs, ys, plotW, plotH, bottom, LEFT],
  );
  const bars = useDerivedValue(() => {
    if (barW8.value <= 0) return empties;
    const s = start.value;
    const sp = span.value;
    const l = lo.value;
    const h = hi.value;
    // 0-2: the colour groups; 3: today's running total.
    const b = Array.from({ length: 4 }, () => Skia.PathBuilder.Make());
    const i0 = Math.max(0, Math.floor(s));
    const i1 = Math.min(xs.length - 1, Math.ceil(s + sp));
    for (let i = i0; i <= i1; i++) {
      const rr = barRect(i, s, sp, l, h);
      if (!rr) continue;
      b[groups[i] ?? 0].addRRect(rr);
    }
    return b.map((x) => x.detach());
  });
  const bar0 = useDerivedValue(() => bars.value[0]);
  const bar1 = useDerivedValue(() => bars.value[1]);
  const bar2 = useDerivedValue(() => bars.value[2]);
  const bar3 = useDerivedValue(() => bars.value[3]);

  // The lines' band gradients follow their y axes as they animate.
  const stops = React.useMemo(() => (p.bands ? bandStops(prim.hi, prim.lo, p.bands) : null), [p.bands, prim]);
  const gStart = useDerivedValue(() => vec(0, bottom - ((prim.hi - lo.value) / (hi.value - lo.value)) * plotH));
  const gEnd = useDerivedValue(() => vec(0, bottom - ((prim.lo - lo.value) / (hi.value - lo.value)) * plotH + 0.01));
  // The series stay inside the plot (the bars' rounded feet run under its floor).
  const clip = React.useMemo(() => rect(LEFT, top - 6, plotW, plotH + 6), [LEFT, top, plotW, plotH]);

  // --- Axes, grid and bands (recorded per frame from the viewport) ---
  // A dashed grid and muted axis text, dashed guides, faint spans and bands, the night's stage lanes.
  const workoutsFirst = p.emphasis === "workouts";
  const paints = React.useMemo(
    () => ({
      grid: paint(k.grid, { width: 1, dash: [3, 4] }),
      band: paint(alpha(p.bands ? k.ink : p.lineColor, p.bands ? 0.05 : 0.09)),
      text: paint(k.axis),
      text2: [0, 1, 2].map((i) => paint(p.compareColors[i] ?? k.axis)),
      goal: paint(k.guide, { width: 1.5, dash: [3, 5], round: true }),
      pill: paint(k.pill),
      pillText: paint(k.sub),
      ink: paint(k.ink),
      ring: paint(k.ring),
      latest: paint(p.lineColor),
      workout: paint(alpha(k.workout, workoutsFirst ? 0.16 : 0.1)),
      sleep: paint(alpha(k.sleep, workoutsFirst ? 0.04 : 0.08)),
      workoutEdge: paint(k.workout),
      sleepEdge: paint(alpha(k.sleep, workoutsFirst ? 0.45 : 1)),
      workoutName: paint(k.workout),
      sleepName: paint(workoutsFirst ? k.sub : k.sleep),
      lane: paint(k.wash),
      stage: { awake: paint(c["stage-awake"]), rem: paint(c["stage-rem"]), light: paint(c["stage-light"]), deep: paint(c["stage-deep"]) },
      block: { awake: paint(alpha(c["stage-awake"], 0.85)), rem: paint(alpha(c["stage-rem"], 0.85)), light: paint(alpha(c["stage-light"], 0.85)), deep: paint(alpha(c["stage-deep"], 0.85)) },
    }),
    [c, k, p.compareColors, p.bands, p.lineColor, workoutsFirst],
  );
  const levels = p.levels;
  const baseline = p.baseline;
  const goal = p.goal;
  const spans = p.spans;
  const stages = p.stages;
  const now = p.now;
  // The compares' scales, by name, for the worklets below (shared values captured one by one).
  const lo2a = slot0.lo;
  const hi2a = slot0.hi;
  const t2a = slot0.ticks;
  const lo2b = slot1.lo;
  const hi2b = slot1.hi;
  const t2b = slot1.ticks;
  const lo2c = slot2.lo;
  const hi2c = slot2.hi;
  const t2c = slot2.ticks;
  const plotRight = LEFT + plotW;
  // The stretches' names (a workout's with its length on the workouts day), the night's bed and wake, the latest value.
  const spanText = React.useMemo(
    () => spans.map((s) => (workoutsFirst && s.kind === "workout" ? `${s.label} · ${lengthText(s.to - s.from)}` : s.label)),
    [spans, workoutsFirst],
  );
  const spanTextW = React.useMemo(() => spanText.map((t) => measure(workoutsFirst ? fonts.sans(700, 11) : nameFont, t)), [spanText, workoutsFirst, fonts, nameFont]);
  const spanFont = workoutsFirst ? fonts.sans(700, 11) : nameFont;
  const bed = p.bed;
  const wake = p.wake;
  const night = React.useMemo(
    () => ({
      bedTime: bed === null ? "" : minuteText(bed),
      wakeTime: wake === null ? "" : minuteText(wake),
      bedW: measure(nameFont, "Bed "),
      wakeW: measure(nameFont, "Wake "),
      bedTimeW: bed === null ? 0 : measure(timeFont, minuteText(bed)),
      wakeTimeW: wake === null ? 0 : measure(timeFont, minuteText(wake)),
    }),
    [bed, wake, nameFont, timeFont],
  );
  const latest = p.latest;
  const latestW = React.useMemo(() => (latest ? measure(pillFont, latest.text) : 0), [latest, pillFont]);
  const goalW = React.useMemo(() => (goal ? measure(pillFont, goal.label) : 0), [goal, pillFont]);

  const under = useDerivedValue(() =>
    createPicture(
      (canvas) => {
        const s = start.value;
        const sp = span.value;
        const l = lo.value;
        const h = hi.value;
        const px = (x: number) => LEFT + ((x - s) / sp) * plotW;
        const py = (v: number) => bottom - ((v - l) / (h - l)) * plotH;
        if (baseline) {
          const a = Math.max(top, py(baseline[1]));
          const b = Math.min(bottom, py(baseline[0]));
          if (b > a) canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(LEFT, a, plotW, b - a), 6, 6), paints.band);
        }
        for (const sp2 of spans) {
          const a = Math.max(LEFT, px(sp2.from));
          const b = Math.min(plotRight, px(sp2.to));
          if (b <= a) continue;
          const r = Math.min(6, (b - a) / 2);
          const work = sp2.kind === "workout";
          canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(a, top, b - a, plotH), r, r), work ? paints.workout : paints.sleep);
          const edge = work && workoutsFirst ? 3.5 : 2.5;
          canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(a, top, b - a, edge), Math.min(edge / 2, r), Math.min(edge / 2, r)), work ? paints.workoutEdge : paints.sleepEdge);
        }
        for (const t of yTicks.value) {
          const y = py(t.v);
          if (y < top - 0.5 || y > bottom + 0.5) continue;
          canvas.drawLine(LEFT, y, plotRight, y, paints.grid);
        }
      },
      { width, height },
    ),
  );

  const over = useDerivedValue(() =>
    createPicture(
      (canvas) => {
        const s = start.value;
        const sp = span.value;
        const l = lo.value;
        const h = hi.value;
        const px = (x: number) => LEFT + ((x - s) / sp) * plotW;
        const py = (v: number) => bottom - ((v - l) / (h - l)) * plotH;
        // Left axis
        for (const t of yTicks.value) {
          const y = py(t.v);
          if (y < top - 0.5 || y > bottom + 0.5) continue;
          canvas.drawText(t.text, LEFT - 8 - axisFont.getTextWidth(t.text), y + 12 * 0.32, paints.text, axisFont);
        }
        // Right axis: a column per compare that has room, each in its compare's colour
        const axis2 = (ticks: { v: number; text: string }[], l2: number, h2: number, col: number, pt: SkPaint) => {
          for (const t of ticks) {
            const y = bottom - ((t.v - l2) / (h2 - l2)) * plotH;
            if (y < top - 0.5 || y > bottom + 0.5) continue;
            canvas.drawText(t.text, plotRight + 8 + col * AXIS_COL, y + 12 * 0.32, pt, axisFont);
          }
        };
        if (axisCols > 0) axis2(t2a.value, lo2a.value, hi2a.value, 0, paints.text2[0]);
        if (axisCols > 1) axis2(t2b.value, lo2b.value, hi2b.value, 1, paints.text2[1]);
        if (axisCols > 2) axis2(t2c.value, lo2c.value, hi2c.value, 2, paints.text2[2]);
        // Bottom axis: the finest tick level that leaves room for its labels
        const lv = pickLevel(levels, sp, plotW, TICK_GAP);
        if (lv >= 0) {
          const ticks = levels[lv].ticks;
          for (let i = firstTickAtOrAfter(ticks, s); i < ticks.length && ticks[i].x <= s + sp; i++) {
            const x = px(ticks[i].x);
            const w = axisFont.getTextWidth(ticks[i].text);
            const left = Math.min(width - w - 2, Math.max(LEFT - w / 2, x - w / 2));
            canvas.drawText(ticks[i].text, left, height - 9, paints.text, axisFont);
          }
        }
        // The stretches' names in the lane over the plot, left to right; one that would touch the last is left out.
        if (named) {
          let edge = -Infinity;
          for (let i = 0; i < spans.length; i++) {
            const a = Math.max(LEFT, px(spans[i].from));
            const b = Math.min(plotRight, px(spans[i].to));
            if (b <= a) continue;
            const w = spanTextW[i];
            const x = Math.min(plotRight - w, Math.max(LEFT, (a + b) / 2 - w / 2));
            if (x < edge + 8) continue;
            canvas.drawText(spanText[i], x, TOP + 12, spans[i].kind === "workout" ? paints.workoutName : paints.sleepName, spanFont);
            edge = x + w;
          }
        }
        // The night's bed and wake: dashed guides through the plot and the lanes, named over the plot.
        if (bed !== null || wake !== null) {
          const laneBottom = bottom + lanes;
          let bedRight = -Infinity;
          if (bed !== null) {
            const x = px(bed);
            if (x >= LEFT && x <= plotRight) {
              canvas.drawLine(x, top, x, laneBottom, paints.goal);
              const w = night.bedW + night.bedTimeW;
              const tx = Math.min(plotRight - w, Math.max(LEFT, x - 2));
              canvas.drawText("Bed", tx, TOP + 12, paints.pillText, nameFont);
              canvas.drawText(night.bedTime, tx + night.bedW, TOP + 12, paints.ink, timeFont);
              bedRight = tx + w;
            }
          }
          if (wake !== null) {
            const x = px(wake);
            if (x >= LEFT && x <= plotRight) {
              canvas.drawLine(x, top, x, laneBottom, paints.goal);
              const w = night.wakeW + night.wakeTimeW;
              const tx = Math.max(LEFT, Math.min(plotRight - w, x - w + 2));
              if (tx > bedRight + 8) {
                canvas.drawText("Wake", tx, TOP + 12, paints.pillText, nameFont);
                canvas.drawText(night.wakeTime, tx + night.wakeW, TOP + 12, paints.ink, timeFont);
              }
            }
          }
        }
        // Now
        if (now !== null) {
          const x = px(now);
          if (x >= LEFT && x <= plotRight) canvas.drawLine(x, top, x, bottom, paints.goal);
        }
        // The goal line with its pill at the plot's right end
        let goalBox: { x: number; y: number; w: number } | null = null;
        if (goal) {
          const y = py(goal.y);
          if (y >= top && y <= bottom) {
            canvas.drawLine(LEFT, y, plotRight, y, paints.goal);
            const w = goalW + 12;
            canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(plotRight - w - 2, y - 9, w, 18), 9, 9), paints.pill);
            canvas.drawText(goal.label, plotRight - w + 4, y + 11 * 0.35, paints.pillText, pillFont);
            goalBox = { x: plotRight - w - 2, y: y - 9, w };
          }
        }
        // The latest point, ringed in the card colour, its value on a pill over it (under it near the top)
        if (latest) {
          const v = ys[latest.index];
          if (v !== null && v !== undefined) {
            const x = px(xs[latest.index]);
            const y = py(v);
            if (x >= LEFT - 1 && x <= plotRight + 1 && y >= top - 1 && y <= bottom + 1) {
              canvas.drawCircle(x, y, 6.5, paints.ring);
              canvas.drawCircle(x, y, 4.5, paints.latest);
              const w = latestW + 14;
              const bx = Math.min(plotRight - w, Math.max(LEFT, x - w / 2));
              const by = y - 12 - 18 >= top ? y - 12 - 18 : y + 12;
              const hitsGoal = goalBox && bx < goalBox.x + goalBox.w && bx + w > goalBox.x && by < goalBox.y + 18 && by + 18 > goalBox.y;
              if (!hitsGoal) {
                canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(bx, by, w, 18), 9, 9), paints.pill);
                canvas.drawText(latest.text, bx + 7, by + 9 + 11 * 0.35, paints.ink, pillFont);
              }
            }
          }
        }
        // The night's stages: four soft lanes under the plot, each named in its colour, each stretch a rounded block
        if (stages.length) {
          const laneTop = bottom + LANES_TOP;
          for (let k2 = 0; k2 < 4; k2++) {
            const y = laneTop + k2 * (LANE_H + LANE_GAP);
            canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(LEFT, y, plotW, LANE_H), LANE_H / 2, LANE_H / 2), paints.lane);
            const name = laneNames[k2];
            canvas.drawText(name, LEFT - 8 - laneFont.getTextWidth(name), y + LANE_H / 2 + 11 * 0.35, paints.stage[STAGE_ORDER[k2]], laneFont);
          }
          for (const g of stages) {
            const a = Math.max(LEFT, px(g.from));
            const b = Math.min(plotRight, px(g.to));
            if (b <= a) continue;
            const k2 = STAGE_ORDER.indexOf(g.stage);
            const w = Math.max(0.75, b - a);
            const r = Math.min(3, w / 2);
            canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(a, laneTop + k2 * (LANE_H + LANE_GAP), w, LANE_H), r, r), paints.block[g.stage]);
          }
        }
      },
      { width, height },
    ),
  );

  // --- The crosshair (the cursor is in data x, so it rides along with a pan or a zoom) ---
  const dotX = useDerivedValue(() => (idx.value < 0 ? -1000 : LEFT + ((xs[idx.value] - start.value) / span.value) * plotW));
  const dotY = useDerivedValue(() => {
    const v = idx.value < 0 ? null : ys[idx.value];
    return v === null || v === undefined ? -1000 : bottom - ((v - lo.value) / (hi.value - lo.value)) * plotH;
  });
  const shown = useDerivedValue(() => (idx.value >= 0 && dotX.value >= LEFT - 1 && dotX.value <= plotRight + 1 ? 1 : 0));
  const vTop = useDerivedValue(() => vec(dotX.value, top));
  const vBottom = useDerivedValue(() => vec(dotX.value, bottom));
  const hLeft = useDerivedValue(() => vec(LEFT, dotY.value));
  const hRight = useDerivedValue(() => vec(plotRight, dotY.value));
  const fg = k.ink;
  const readoutColors = p.readout.colors;
  const dotColor = useDerivedValue(() => (idx.value < 0 ? fg : (readoutColors[idx.value] ?? fg)));
  const halo = useDerivedValue(() => (idx.value < 0 ? "transparent" : (readoutColors[idx.value] ?? fg)));
  // The inspected day: TrendChart's faint column behind its bar, the day's whole band, the plot's full height.
  const selBar = useDerivedValue(() => {
    const i = idx.value;
    if (barW8.value <= 0 || i < 0) return empties[0];
    const per = plotW / span.value;
    const b = Skia.PathBuilder.Make();
    b.addRect(Skia.XYWHRect(LEFT + (xs[i] - start.value) * per - per / 2, top, per, plotH));
    return b.detach();
  });

  // --- Gestures ---
  const notify = p.onViewport;
  const full = max - min;
  const gesture = React.useMemo(() => {
    const at = (x: number) => {
      "worklet";
      return dataXAt(x, start.get(), span.get(), LEFT, plotW);
    };
    const settle = () => {
      "worklet";
      scheduleOnRN(notify, start.get(), span.get());
    };
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        "worklet";
        cancelAnimation(start);
        cancelAnimation(span);
        pinching.set(true);
        pinchSpan.set(span.get());
        focal.set(at(e.focalX));
      })
      .onUpdate((e) => {
        "worklet";
        const next = Math.min(full, Math.max(Math.min(minSpan, full), pinchSpan.get() / Math.max(0.01, e.scale)));
        // The day under the fingers stays under them, as they spread and as they move.
        start.set(clampStart(focal.get() - ((e.focalX - LEFT) / plotW) * next, next, min, max));
        span.set(next);
      })
      .onEnd(() => {
        "worklet";
        pinching.set(false);
        settle();
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(8)
      .onStart(() => {
        "worklet";
        cancelAnimation(start);
      })
      .onChange((e) => {
        "worklet";
        if (pinching.get()) return;
        start.set(clampStart(start.get() - (e.changeX / plotW) * span.get(), span.get(), min, max));
      })
      .onEnd((e, success) => {
        "worklet";
        if (!success || pinching.get()) return;
        const sp = span.get();
        if (sp >= full - 1e-6) {
          settle();
          return;
        }
        // Momentum: the window glides on and settles against either end of the data.
        start.set(
          withDecay({ velocity: -(e.velocityX / plotW) * sp, clamp: [min, max - sp], deceleration: 0.996 }, (finished) => {
            if (finished) scheduleOnRN(notify, start.get(), span.get());
          }),
        );
      });
    const scrub = Gesture.Pan()
      .activateAfterLongPress(220)
      .onStart((e) => {
        "worklet";
        cursor.set(at(e.x));
      })
      .onUpdate((e) => {
        "worklet";
        cursor.set(at(e.x));
      })
      // Lifting the finger ends the inspection, as a hover ends.
      .onFinalize((_e, success) => {
        "worklet";
        if (success) cursor.set(NaN);
      });
    // A tap pins the crosshair where it lands; a tap with it showing clears it.
    const tap = Gesture.Tap()
      .maxDuration(260)
      .onEnd((e, success) => {
        "worklet";
        if (!success) return;
        cursor.set(Number.isNaN(cursor.get()) ? at(e.x) : NaN);
      });
    // A double tap glides back to the range's own window.
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd((_e, success) => {
        "worklet";
        if (!success) return;
        cursor.set(NaN);
        cancelAnimation(start);
        cancelAnimation(span);
        const s0 = homeStart.get();
        const sp0 = homeSpan.get();
        start.set(withTiming(s0, { duration: MOVE_MS }));
        span.set(
          withTiming(sp0, { duration: MOVE_MS }, (finished) => {
            if (finished) scheduleOnRN(notify, s0, sp0);
          }),
        );
      });
    return Gesture.Race(Gesture.Exclusive(doubleTap, tap), scrub, Gesture.Simultaneous(pan, pinch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotW, LEFT, min, max, minSpan, full, notify]);

  // --- The readout box: text per point, measured once ---
  const r = p.readout;
  const dateFont = fonts.sans(600, 12);
  const valueFont = fonts.num(700, 17);
  const compareFont = fonts.num(700, 13);
  const noteFont = fonts.sans(500, 12);
  const seriesFont = fonts.sans(600, 12);
  const names = p.names;
  // Each series' name sits before its value: the values start this far in (name and a gap).
  const nameW = React.useMemo(
    () => ({ primary: names?.primary ? measure(seriesFont, names.primary) + 6 : 0, compares: [0, 1, 2].map((j) => (names?.compares[j] ? measure(seriesFont, names.compares[j]) + 6 : 0)) }),
    [names, seriesFont],
  );
  // Each line measured once per text array (the notes change when a gesture settles; the rest with the data).
  const datesW = React.useMemo(() => r.dates.map((t) => measure(dateFont, t)), [r.dates, dateFont]);
  const valuesW = React.useMemo(() => r.values.map((t) => measure(valueFont, t)), [r.values, valueFont]);
  const comparesW = React.useMemo(() => r.compares.map((arr) => arr.map((t) => measure(compareFont, t))), [r.compares, compareFont]);
  const notesW = React.useMemo(() => r.notes.map((t) => measure(noteFont, t)), [r.notes, noteFont]);
  const box = React.useMemo(() => {
    const notes = r.notes.some(Boolean);
    const widths = datesW.map((w, i) => Math.max(w, nameW.primary + (valuesW[i] ?? 0), ...comparesW.slice(0, nCmp).map((arr, j) => nameW.compares[j] + (arr[i] ?? 0)), notesW[i] ?? 0) + 20);
    return { widths, height: 10 + 16 + 22 + 18 * nCmp + (notes ? 16 : 0) + 6 };
  }, [r.notes, datesW, valuesW, comparesW, notesW, nCmp, nameW]);
  const boxW = useDerivedValue(() => (idx.value < 0 ? 0 : (box.widths[idx.value] ?? 0)));
  const boxX = useDerivedValue(() => {
    const w = boxW.value;
    const x = dotX.value + 14 + w <= plotRight ? dotX.value + 14 : dotX.value - 14 - w;
    return Math.max(LEFT, Math.min(plotRight - w, x));
  });
  const textX = useDerivedValue(() => boxX.value + 10);
  const valueX = useDerivedValue(() => textX.value + nameW.primary);
  const cX0 = useDerivedValue(() => textX.value + nameW.compares[0]);
  const cX1 = useDerivedValue(() => textX.value + nameW.compares[1]);
  const cX2 = useDerivedValue(() => textX.value + nameW.compares[2]);
  const compareXs = [cX0, cX1, cX2];
  const dateText = useDerivedValue(() => (idx.value < 0 ? "" : (r.dates[idx.value] ?? "")));
  const valueText = useDerivedValue(() => (idx.value < 0 ? "" : (r.values[idx.value] ?? "")));
  const noteText = useDerivedValue(() => (idx.value < 0 ? "" : (r.notes[idx.value] ?? "")));
  const boxTop = top + 4;
  const valueY = boxTop + 10 + 16 + 17;
  const compareY = (j: number) => boxTop + 10 + 16 + 22 + 12 + 18 * j;
  const noteY = compareY(nCmp);

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <View style={{ width, height }} accessible accessibilityRole="image" accessibilityLabel={`${p.primary.label}${nCmp ? ` with ${p.compares.map((x) => x.label).join(", ")}` : ""}. Pinch to zoom, drag to pan, hold to inspect a point.`}>
          {/* The chart draws in by a native wipe (the canvas is not redrawn for it); the crosshair is a canvas of its own,
              so inspecting a point never redraws the series. */}
          <NativeReveal progress={progress} width={width} height={height}>
            <Canvas style={{ width, height }}>
              <Picture picture={under} />
              <Group clip={clip}>
                <Group opacity={lineAlpha}>
                  {hotPaths ? (
                    // The workouts day: the day's line quiet, the minutes inside a workout in full, coloured by zone.
                    <Group>
                      <Path path={line} style="stroke" strokeWidth={LINE.thin - 0.5} strokeJoin="round" strokeCap="round" color={alpha(k.sub, 0.45)} />
                      <Path path={hotArea}>
                        <LinearGradient start={vec(0, top)} end={vec(0, bottom)} colors={[alpha(k.workout, 0.2), alpha(k.workout, 0)]} />
                      </Path>
                      <Path path={hotLine} style="stroke" strokeWidth={LINE.width} strokeJoin="round" strokeCap="round" color={p.lineColor}>
                        {stops && <LinearGradient start={gStart} end={gEnd} colors={stops.map((s) => s.color)} positions={stops.map((s) => s.offset)} />}
                      </Path>
                    </Group>
                  ) : trendPaths ? (
                    // Many days on show: the days as dots and a faint trace, the trailing average bold as the line.
                    <Group>
                      <Path path={trendArea}>
                        <LinearGradient start={vec(0, top)} end={vec(0, bottom)} colors={[alpha(p.bands ? fg : p.lineColor, p.bands ? 0.08 : 0.14), alpha(p.bands ? fg : p.lineColor, 0)]} />
                      </Path>
                      <Path path={line} style="stroke" strokeWidth={1} strokeJoin="round" strokeCap="round" color={alpha(p.lineColor, 0.28)} />
                      <Path path={dots} style="stroke" strokeWidth={3} strokeCap="round" color={alpha(p.lineColor, 0.5)} />
                      <Path path={trendLine} style="stroke" strokeWidth={LINE.width + 0.5} strokeJoin="round" strokeCap="round" color={p.lineColor}>
                        {stops && <LinearGradient start={gStart} end={gEnd} colors={stops.map((s) => s.color)} positions={stops.map((s) => s.offset)} />}
                      </Path>
                    </Group>
                  ) : (
                    <Group>
                      <Path path={area}>
                        <LinearGradient start={vec(0, top)} end={vec(0, bottom)} colors={[alpha(p.bands ? fg : p.lineColor, p.bands ? 0.08 : 0.18), alpha(p.bands ? fg : p.lineColor, 0)]} />
                      </Path>
                      <Path path={line} style="stroke" strokeWidth={LINE.width} strokeJoin="round" strokeCap="round" color={p.lineColor}>
                        {stops && <LinearGradient start={gStart} end={gEnd} colors={stops.map((s) => s.color)} positions={stops.map((s) => s.offset)} />}
                      </Path>
                    </Group>
                  )}
                </Group>
                {isBar && (
                  <Group opacity={barW8}>
                    <Path path={selBar} color={alpha(fg, 0.05)} />
                    {/* TrendChart's bars: every day at full ink, fading to half towards the floor (its CapBar), today's "so far" outlined lighter. */}
                    {[bar0, bar1, bar2].map((b, j) =>
                      p.barColors[j] ? (
                        <Path key={j} path={b} color={p.barColors[j]}>
                          <LinearGradient start={vec(0, top)} end={vec(0, bottom)} colors={[p.barColors[j], alpha(p.barColors[j], 0.5)]} />
                        </Path>
                      ) : null,
                    )}
                    {p.partialColor && (
                      <Group>
                        <Path path={bar3} color={alpha(p.partialColor, 0.28)} />
                        <Path path={bar3} style="stroke" strokeWidth={1.5} color={alpha(p.partialColor, 0.9)} />
                      </Group>
                    )}
                  </Group>
                )}
                {/* The compares, each on its own scale: many days on show draw its days faint and its trailing average bold. */}
                {slots.map((sl, j) =>
                  sl.trend ? (
                    <Group key={j}>
                      <Path path={sl.line} style="stroke" strokeWidth={1} strokeJoin="round" strokeCap="round" color={alpha(sl.color, 0.3)} />
                      <Path path={sl.tLine} style="stroke" strokeWidth={LINE.thin + 0.5} strokeJoin="round" strokeCap="round" color={sl.color}>
                        {sl.stops && <LinearGradient start={sl.gStart} end={sl.gEnd} colors={sl.stops.map((s) => s.color)} positions={sl.stops.map((s) => s.offset)} />}
                      </Path>
                    </Group>
                  ) : (
                    <Path key={j} path={sl.line} style="stroke" strokeWidth={LINE.thin} strokeJoin="round" strokeCap="round" color={sl.color} opacity={sl.stops ? 0.9 : 1}>
                      {sl.stops && <LinearGradient start={sl.gStart} end={sl.gEnd} colors={sl.stops.map((s) => s.color)} positions={sl.stops.map((s) => s.offset)} />}
                    </Path>
                  ),
                )}
              </Group>
              <Picture picture={over} />
            </Canvas>
          </NativeReveal>
          <Canvas pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height }}>
            {/* Crosshair, dots and readout */}
            {/* The Calm crosshair: a dashed cursor in the ink at 30 %, the dot with a white ring, a white readout card with a soft edge. */}
            <Group opacity={shown}>
              <Line p1={vTop} p2={vBottom} color={k.cursor} strokeWidth={1.5} strokeCap="round" style="stroke">
                <DashPathEffect intervals={[3, 5]} />
              </Line>
              <Line p1={hLeft} p2={hRight} color={alpha(k.ink, 0.14)} strokeWidth={1} style="stroke">
                <DashPathEffect intervals={[2, 4]} />
              </Line>
              <Circle cx={dotX} cy={dotY} r={12} color={halo} opacity={0.16} />
              <Circle cx={dotX} cy={dotY} r={8} color={k.scrubRing} />
              <Circle cx={dotX} cy={dotY} r={5} color={dotColor} />
              {slots.map((sl, j) => (
                <Group key={j}>
                  <Circle cx={sl.dotX} cy={sl.dotY} r={7} color={k.scrubRing} />
                  <Circle cx={sl.dotX} cy={sl.dotY} r={4.5} color={sl.dotColor} />
                </Group>
              ))}
              <RoundedRect x={boxX} y={boxTop} width={boxW} height={box.height} r={12} color={k.readout} />
              <RoundedRect x={boxX} y={boxTop} width={boxW} height={box.height} r={12} color={k.readoutEdge} style="stroke" strokeWidth={1} />
              <SkText x={textX} y={boxTop + 10 + 12} text={dateText} font={dateFont} color={k.sub} />
              {names?.primary ? <SkText x={textX} y={valueY} text={names.primary} font={seriesFont} color={k.sub} /> : null}
              <SkText x={valueX} y={valueY} text={valueText} font={valueFont} color={dotColor} />
              {slots.map((sl, j) => (
                <Group key={j}>
                  {names?.compares[j] ? <SkText x={textX} y={compareY(j)} text={names.compares[j]} font={seriesFont} color={k.sub} /> : null}
                  <SkText x={compareXs[j]} y={compareY(j)} text={sl.text} font={compareFont} color={sl.color} />
                </Group>
              ))}
              <SkText x={textX} y={noteY} text={noteText} font={noteFont} color={k.sub} />
            </Group>
          </Canvas>
        </View>
      </GestureDetector>
    </View>
  );
}
