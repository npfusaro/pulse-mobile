// HRV across the main sleep (fork addition), after SleepHrChart: the band's one-every-five-minutes RMSSD with the
// deep-sleep stretches lit, the bed and wake markers, Fitbit's personal range as a band, and the night's high
// marked. The points are the samples themselves, so the line is broken only where the band skipped a stretch.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Circle, Rect } from "@shopify/react-native-skia";
import { clock } from "@/lib/format";
import type { Metric } from "@/lib/reasons";
import { alpha } from "../color";
import { ReasonPlaceholder } from "../metrics/ReasonPlaceholder";
import { EmptyState } from "../shells/EmptyState";
import { MetricState } from "../shells/MetricState";
import { useOptionalShellCalendar } from "../shells/ShellStatus";
import { Skeleton } from "../Skeleton";
import { useTheme } from "../theme";
import { ChartFigure, ChartLabel, DashedLine, GlowDot, GridLines, Pill, PlotCanvas, ScrubLayer, ScrubTick, TooltipCard, TooltipLine, xTickY, yTickX } from "./ChartFrame";
import { areaPath, evenTicks, linePath, linearScale, nearestIndex, type Point } from "./geometry";
import { FadeFill, StrokePath } from "./paint";

export type NightHrvSeries = {
  /** Epoch ms of the main sleep's start and end. */
  bed: number;
  wake: number;
  /** The samples (RMSSD, ms), a little past both ends, in time order. */
  points: { t: number; v: number }[];
  /** The night's deep-sleep stretches (epoch ms): their samples are drawn bright. */
  deep: { start: number; end: number }[];
  /** Fitbit's personal range for the nightly average, drawn as a band. */
  range?: { low: number; high: number } | null;
  /** The night's highest sample, marked. */
  high?: { t: number; v: number } | null;
};

export type NightHrvChartProps = { data: Metric<NightHrvSeries> | null | undefined };

const HEIGHT = 200;
const AXIS_H = 30;
/** Samples further apart than this are not joined: the band skipped the stretch between them. */
const GAP_MS = 12 * 60_000;

/** The y axis: even ticks from a little under the lowest sample (and the range) to a little over the highest. */
export function hrvTicks(values: number[], range?: { low: number; high: number } | null): number[] {
  const all = [...values, ...(range ? [range.low, range.high] : [])];
  if (!all.length) return [0, 50, 100];
  const lo = Math.max(0, Math.floor((Math.min(...all) - 5) / 5) * 5);
  const hi = Math.ceil((Math.max(...all) + 5) / 5) * 5;
  return evenTicks(lo, Math.max(hi, lo + 10), 5);
}

function Chart({ s }: { s: NightHrvSeries }) {
  const { c } = useTheme();
  const tz = useOptionalShellCalendar()?.timeZone;
  const [x, setX] = useState<number | null>(null);
  const { bed, wake, points, deep, range, high } = s;
  // Three series on one axis: outside the sleep (faint), the night (dim), deep sleep (bright, filled). A sample
  // joins a deep stretch when it falls inside one. `gap`: the previous sample is too far back to draw a line from;
  // `lone`: no sample near on either side, so the point gets a dot where the line cannot reach it.
  const rows = useMemo(
    () =>
      points.map(({ t, v }, i) => {
        const inside = t >= bed && t <= wake;
        const lit = inside && deep.some((d) => t >= d.start && t <= d.end);
        const gap = i > 0 && t - points[i - 1].t > GAP_MS;
        const lone = (i === 0 || gap) && (i === points.length - 1 || points[i + 1].t - t > GAP_MS);
        return { t, v, out: inside ? null : v, night: inside ? v : null, lit: lit ? v : null, gap, lone };
      }),
    [points, bed, wake, deep],
  );
  const yTicks = hrvTicks(points.map((p) => p.v), range);
  const night = rows.filter((r) => r.night !== null).map((r) => r.v);
  const avg = night.length ? Math.round((night.reduce((a, b) => a + b, 0) / night.length) * 10) / 10 : null;
  const summary = `Heart rate variability during sleep from ${clock(bed, tz)} to ${clock(wake, tz)}: low ${Math.min(...night)}, average ${avg}, high ${Math.max(...night)} milliseconds, ${night.length} readings${range ? `; your typical range ${range.low} to ${range.high}` : ""}.`;

  return (
    <ChartFigure summary={summary} height={HEIGHT}>
      {({ width, height }) => {
        const x0 = 32;
        const x1 = width - 8;
        const y0 = 8;
        const y1 = height - AXIS_H;
        const tx = linearScale([Math.min(points[0].t, bed), Math.max(points.at(-1)!.t, wake)], [x0, x1]);
        const y = linearScale([yTicks[0], yTicks.at(-1)!], [y1, y0]);
        // A gap breaks the line: a null point between two samples the band did not join.
        const mk = (key: "out" | "night" | "lit"): Point[] => rows.flatMap((r) => [...(r.gap ? [{ x: tx(r.t) - 0.5, y: null }] : []), { x: tx(r.t), y: r[key] === null ? null : y(r[key]!) }]);
        const ai = x === null ? -1 : nearestIndex(rows.map((r) => tx(r.t)), x);
        const a = ai >= 0 ? rows[ai] : null;
        const litTop = Math.min(...rows.flatMap((r) => (r.lit === null ? [] : [y(r.lit)])), y1);
        return (
          <>
            <PlotCanvas width={width} height={height}>
              <GridLines ys={yTicks.map(y)} x0={x0} x1={x1} />
              {range && <Rect x={x0} y={y(range.high)} width={x1 - x0} height={Math.max(1, y(range.low) - y(range.high))} color={alpha(c["recovery-blue"], 0.14)} />}
              {[bed, wake].map((t) => (
                <DashedLine key={t} x1={tx(t)} x2={tx(t)} y1={y0} y2={y1} color={c["foreground-secondary"]} dash={[2, 3]} />
              ))}
              {a && <DashedLine x1={tx(a.t)} x2={tx(a.t)} y1={y0} y2={y1} color={c["chart-cursor"]} />}
              <StrokePath path={linePath(mk("out"), "monotone")} width={1} paint={{ color: c["muted-foreground"] }} opacity={0.45} />
              <StrokePath path={linePath(mk("night"), "monotone")} width={1.25} paint={{ color: c["muted-foreground"] }} />
              <FadeFill path={areaPath(mk("lit"), y1, "monotone")} color={c["sleep-deep"]} y0={litTop} y1={y1} from={0.28} to={0} />
              <StrokePath path={linePath(mk("lit"), "monotone")} width={1.5} paint={{ color: c["sleep-deep"] }} />
              {rows.map((r) => r.lone && <Circle key={r.t} cx={tx(r.t)} cy={y(r.v)} r={1.75} color={r.lit !== null ? c["sleep-deep"] : c["muted-foreground"]} />)}
              {high && (
                <>
                  <Circle cx={tx(high.t)} cy={y(high.v)} r={5.5} color={c.card} />
                  <Circle cx={tx(high.t)} cy={y(high.v)} r={3.5} color={c.foreground} />
                </>
              )}
              {a && <GlowDot x={tx(a.t)} y={y(a.v)} fill={a.lit === null ? c.foreground : c["sleep-deep"]} />}
            </PlotCanvas>
            {yTicks.map((t) => (
              <ChartLabel key={t} x={yTickX(x0)} y={y(t)} anchor="end" w={x0}>
                {String(t)}
              </ChartLabel>
            ))}
            {range && (
              <ChartLabel x={x1 - 2} y={y(range.high) - 9} anchor="end" w={80} color={c["foreground-secondary"]} className="text-[10px] font-bold">
                Your range
              </ChartLabel>
            )}
            {[bed, wake].map((t) => (
              <ChartLabel key={t} x={tx(t)} y={xTickY(y1)} color={c["foreground-secondary"]}>
                {clock(t, tz)}
              </ChartLabel>
            ))}
            {high && <Pill x={tx(high.t)} y={y(high.v) - 22} anchor="middle" text={`High ${high.v}`} />}
            <ScrubLayer width={width} height={height} onScrub={setX} />
            <ScrubTick index={ai} />
            {a && (
              <TooltipCard x={tx(a.t)} width={width} title={clock(a.t, tz)}>
                <TooltipLine color={a.lit === null ? c.foreground : c["sleep-deep"]}>{`${a.v} ms${a.lit === null ? "" : " · deep"}`}</TooltipLine>
              </TooltipCard>
            )}
          </>
        );
      }}
    </ChartFigure>
  );
}

/** HRV across the main sleep with its bed and wake markers, deep sleep lit, Fitbit's range as a band and the night's high. */
export function NightHrvChart({ data }: NightHrvChartProps) {
  const empty = (
    <View className="items-center">
      <EmptyState body="No HRV readings for this night." />
    </View>
  );
  return (
    <MetricState
      metric={data}
      skeleton={<NightHrvChartSkeleton />}
      empty={empty}
      renderReason={(r) => (
        <View className="items-center">
          <ReasonPlaceholder reason={r} size="md" />
        </View>
      )}
    >
      {(s) => (s.points.length ? <Chart s={s} /> : empty)}
    </MetricState>
  );
}

export function NightHrvChartSkeleton() {
  return <Skeleton className="h-[200px] rounded-lg bg-skeleton" />;
}
NightHrvChart.Skeleton = NightHrvChartSkeleton;
