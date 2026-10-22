// Blood oxygen across the main sleep (fork addition), after SleepHrChart: the band's one-a-minute readings with
// gaps where it could not read, the bed and wake markers, the 95% line Fitbit and the Health Monitor judge by, and
// the night's low marked. A reading with no neighbour draws no line, so it gets a dot of its own. The night's heart
// rate rides along on a right-hand axis: a dip the heart answers with a jump is a breathing event; a dip, or a gap,
// with the heart rate flat is the band's arm being slept on.
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Circle, Rect } from "@shopify/react-native-skia";
import { alpha } from "../color";
import { clock } from "@/lib/format";
import type { Metric } from "@/lib/reasons";
import { ReasonPlaceholder } from "../metrics/ReasonPlaceholder";
import { EmptyState } from "../shells/EmptyState";
import { MetricState } from "../shells/MetricState";
import { useOptionalShellCalendar } from "../shells/ShellStatus";
import { Skeleton } from "../Skeleton";
import { useTheme } from "../theme";
import { ChartFigure, ChartLabel, DashedLine, GlowDot, GridLines, HollowDot, Pill, PlotCanvas, ScrubLayer, ScrubTick, TooltipCard, TooltipLine, xTickY, yTickX } from "./ChartFrame";
import { areaPath, linePath, linearScale, nearestIndex } from "./geometry";
import { FadeFill, StrokePath } from "./paint";

export type NightSpo2Series = {
  /** Epoch ms of the main sleep's start and end. */
  bed: number;
  wake: number;
  /** One reading a minute, a little past both ends; null is a minute the band did not read, drawn as a gap. */
  points: { t: number; v: number | null }[];
  /** The night's lowest minute, marked. */
  low?: { t: number; v: number } | null;
  /** Per-minute heart rate on the same grid, for the right-hand axis; null or absent draws no heart rate. */
  hr?: { t: number; v: number | null }[] | null;
  /** The night's dips, each marked at its nadir: a ring in the warning colour when the heart answered, muted when not. */
  dips?: { nadir: { t: number; v: number }; hr: "answered" | "flat" | "unknown" }[];
  /** The arm stretches (a slow sag with the heart quiet), shaded across the plot. */
  arm?: { start: number; end: number }[];
};

export type NightSpo2ChartProps = { data: Metric<NightSpo2Series> | null | undefined };

const HEIGHT = 200;
const AXIS_H = 30;
/** Readings under this are the ones Fitbit and the Health Monitor flag ("Below 95%"). */
const LOW_PCT = 95;

/**
 * The y axis: whole percentages from a little under the night's lowest reading (never under 80, so an outlier does
 * not flatten the rest) up to 100, in 2s or 5s so the ticks stay few.
 */
export function spo2Ticks(values: (number | null)[]): number[] {
  const v = values.filter((x): x is number => x !== null);
  const min = v.length ? Math.min(...v, LOW_PCT - 1) : 90;
  const lo = Math.max(80, Math.floor(min / 2) * 2 - 2);
  const step = 100 - lo > 12 ? 5 : 2;
  const first = Math.floor(lo / step) * step;
  return Array.from({ length: Math.floor((100 - first) / step) + 1 }, (_, i) => first + i * step);
}

/** Heart-rate ticks for the right axis: 20 bpm steps around the night's range, as the Sleep page's chart. */
function hrTicks(values: (number | null)[]): number[] {
  const v = values.filter((x): x is number => x !== null);
  if (!v.length) return [];
  const lo = Math.floor((Math.min(...v) - 5) / 20) * 20;
  const hi = Math.ceil((Math.max(...v) + 5) / 20) * 20;
  return Array.from({ length: (hi - lo) / 20 + 1 }, (_, i) => lo + i * 20);
}

function Chart({ s }: { s: NightSpo2Series }) {
  const { c } = useTheme();
  const tz = useOptionalShellCalendar()?.timeZone;
  const [x, setX] = useState<number | null>(null);
  const { bed, wake, points, low } = s;
  const dips = s.dips ?? [];
  const arm = s.arm ?? [];
  const hr = s.hr?.length ? s.hr : null;
  const hrByT = useMemo(() => new Map((hr ?? []).map((p) => [p.t, p.v])), [hr]);
  const hrAxis = hrTicks((hr ?? []).map((p) => p.v));
  // Two series on one axis: the readings in bed (lit, filled) and the odd one outside it (faint). `lone`: no reading
  // on either side, so the point gets a dot where the line cannot reach it.
  const rows = useMemo(
    () =>
      points.map(({ t, v }, i) => {
        const inside = t >= bed && t <= wake;
        const lone = v !== null && points[i - 1]?.v == null && points[i + 1]?.v == null;
        return { t, v, out: inside ? null : v, night: inside ? v : null, lone };
      }),
    [points, bed, wake],
  );
  const yTicks = spo2Ticks(points.map((p) => p.v));
  const night = points.filter((p) => p.t >= bed && p.t < wake && p.v !== null).map((p) => p.v!);
  const avg = night.length ? Math.round((night.reduce((a, b) => a + b, 0) / night.length) * 10) / 10 : null;
  const hrNight = (hr ?? []).filter((p) => p.t >= bed && p.t < wake && p.v !== null).map((p) => p.v!);
  const summary = `Blood oxygen during sleep from ${clock(bed, tz)} to ${clock(wake, tz)}: low ${Math.min(...night)}, average ${avg}, high ${Math.max(...night)} percent, ${night.length} readings${hrNight.length ? `; heart rate ${Math.min(...hrNight)} to ${Math.max(...hrNight)} beats per minute` : ""}.`;
  const showLowLine = yTicks[0] < LOW_PCT;

  return (
    <ChartFigure summary={summary} height={HEIGHT}>
      {({ width, height }) => {
        const x0 = 32;
        const x1 = width - (hrAxis.length ? 30 : 8);
        const y0 = 8;
        const y1 = height - AXIS_H;
        const tx = linearScale([points[0].t, points.at(-1)!.t], [x0, x1]);
        const y = linearScale([yTicks[0], 100], [y1, y0]);
        const yr = hrAxis.length ? linearScale([hrAxis[0], hrAxis.at(-1)!], [y1, y0]) : null;
        const mk = (key: "out" | "night") => rows.map((r) => ({ x: tx(r.t), y: r[key] === null ? null : y(r[key]!) }));
        const hrPath = yr && hr ? linePath(hr.map((p) => ({ x: tx(p.t), y: p.v === null ? null : yr(p.v) })), "monotone") : null;
        // Scrub over every minute either series has, so a heart-rate minute inside an SpO2 gap still reads out.
        const valid = rows.filter((r) => r.v !== null || hrByT.get(r.t) != null);
        const ai = x === null ? -1 : nearestIndex(valid.map((r) => tx(r.t)), x);
        const a = ai >= 0 ? valid[ai] : null;
        const aHr = a ? (hrByT.get(a.t) ?? null) : null;
        const nightTop = Math.min(...rows.flatMap((r) => (r.night === null ? [] : [y(r.night)])), y1);
        return (
          <>
            <PlotCanvas width={width} height={height}>
              <GridLines ys={yTicks.map(y)} x0={x0} x1={x1} />
              {/* The arm stretches: a muted wash across the plot, so the sag reads as a position, not a breathing problem. */}
              {arm.map((a) => (
                <Rect key={a.start} x={tx(a.start)} y={y0} width={Math.max(1, tx(a.end) - tx(a.start))} height={y1 - y0} color={alpha(c["muted-foreground"], 0.12)} />
              ))}
              {/* Heart rate in the Sleep page's neutral, not strain's blue: it must read apart from the SpO2 blue. */}
              {hrPath && <StrokePath path={hrPath} width={1} paint={{ color: c.foreground }} opacity={0.55} />}
              {/* The 95% line only when the axis reaches under it: a steady night is not drawn against a threshold it never neared. */}
              {showLowLine && <DashedLine x1={x0} x2={x1} y1={y(LOW_PCT)} y2={y(LOW_PCT)} color={c.warning} dash={[4, 4]} />}
              {[bed, wake].map((t) => (
                <DashedLine key={t} x1={tx(t)} x2={tx(t)} y1={y0} y2={y1} color={c["foreground-secondary"]} dash={[2, 3]} />
              ))}
              {a && <DashedLine x1={tx(a.t)} x2={tx(a.t)} y1={y0} y2={y1} color={c["chart-cursor"]} />}
              <StrokePath path={linePath(mk("out"), "monotone")} width={1} paint={{ color: c["muted-foreground"] }} opacity={0.45} />
              <FadeFill path={areaPath(mk("night"), y1, "monotone")} color={c.sleep} y0={nightTop} y1={y1} from={0.28} to={0} />
              <StrokePath path={linePath(mk("night"), "monotone")} width={1.5} paint={{ color: c.sleep }} />
              {rows.map((r) => r.lone && r.v !== null && <Circle key={r.t} cx={tx(r.t)} cy={y(r.v)} r={1.75} color={r.night === null ? c["muted-foreground"] : c.sleep} />)}
              {/* Each dip's nadir: a hollow ring, warning-coloured when the heart answered (breathing), muted when it stayed flat (the arm). */}
              {dips.map((d) => (
                <HollowDot key={d.nadir.t} x={tx(d.nadir.t)} y={y(d.nadir.v)} r={4} stroke={d.hr === "answered" ? c.warning : c["muted-foreground"]} strokeWidth={1.5} opacity={d.hr === "unknown" ? 0.5 : 1} />
              ))}
              {low && (
                <>
                  <Circle cx={tx(low.t)} cy={y(low.v)} r={5.5} color={c.card} />
                  <Circle cx={tx(low.t)} cy={y(low.v)} r={3.5} color={c.foreground} />
                </>
              )}
              {a && a.v !== null && <GlowDot x={tx(a.t)} y={y(a.v)} fill={c.sleep} />}
              {a && aHr !== null && yr && <Circle cx={tx(a.t)} cy={yr(aHr)} r={3} color={c.foreground} />}
            </PlotCanvas>
            {yTicks.map((t) => (
              <ChartLabel key={t} x={yTickX(x0)} y={y(t)} anchor="end" w={x0}>
                {String(t)}
              </ChartLabel>
            ))}
            {yr &&
              hrAxis.map((t) => (
                <ChartLabel key={`hr-${t}`} x={x1 + 6} y={yr(t)} anchor="start" w={28} color={c["foreground-secondary"]}>
                  {String(t)}
                </ChartLabel>
              ))}
            {showLowLine && (
              <ChartLabel x={x1 - 2} y={y(LOW_PCT) - 9} anchor="end" w={40} color={c["warning-text"]} className="text-[10px] font-bold">
                95%
              </ChartLabel>
            )}
            {[bed, wake].map((t) => (
              <ChartLabel key={t} x={tx(t)} y={xTickY(y1)} color={c["foreground-secondary"]}>
                {clock(t, tz)}
              </ChartLabel>
            ))}
            {low && <Pill x={tx(low.t)} y={y(low.v) + 14} anchor="middle" text={`Low ${low.v}%`} />}
            <ScrubLayer width={width} height={height} onScrub={setX} />
            <ScrubTick index={ai} />
            {a && (a.v !== null || aHr !== null) && (
              <TooltipCard x={tx(a.t)} width={width} title={clock(a.t, tz)}>
                {a.v !== null && <TooltipLine color={c.sleep}>{`${a.v.toFixed(1)}%`}</TooltipLine>}
                {aHr !== null && <TooltipLine color={c.foreground}>{`${aHr} bpm`}</TooltipLine>}
              </TooltipCard>
            )}
          </>
        );
      }}
    </ChartFigure>
  );
}

/** Blood oxygen across the main sleep with its bed and wake markers, the 95% line and the night's low. */
export function NightSpo2Chart({ data }: NightSpo2ChartProps) {
  const empty = (
    <View className="items-center">
      <EmptyState body="No blood oxygen readings for this night." />
    </View>
  );
  return (
    <MetricState
      metric={data}
      skeleton={<NightSpo2ChartSkeleton />}
      empty={empty}
      renderReason={(r) => (
        <View className="items-center">
          <ReasonPlaceholder reason={r} size="md" />
        </View>
      )}
    >
      {(s) => (s.points.some((p) => p.v !== null) ? <Chart s={s} /> : empty)}
    </MetricState>
  );
}

export function NightSpo2ChartSkeleton() {
  return <Skeleton className="h-[200px] rounded-lg bg-skeleton" />;
}
NightSpo2Chart.Skeleton = NightSpo2ChartSkeleton;
