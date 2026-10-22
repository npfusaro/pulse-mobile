// Blood oxygen `/health/blood-oxygen?d=` (fork addition): the night's average with its standing, the low, the minutes
// under 95% and the readings; the night's minute chart; the week's nights as rows, each opening its night. The
// readings come from the Google Health API (src/google), the one place Fitbit keeps them; without it connected the
// screen says so and points at Settings. Ported from the server app's health/blood-oxygen page.
import { useMemo } from "react";
import { View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { DAY, dayLabel, formatDay, MISSING } from "@/lib/format";
import { dayHref } from "@/lib/url";
import { chartHref } from "@/screens/chart/href";
import { getBloodOxygen } from "@/queries/bloodOxygen";
import type { BloodOxygenVM } from "@/queries/types";
import { NightSpo2Chart, NightSpo2ChartSkeleton } from "@/ui/charts/NightSpo2Chart";
import { cn } from "@/ui/cn";
import { Icon } from "@/ui/Icon";
import { CAPTION, LABEL, StatusChip, ValueUnit } from "@/ui/metrics/primitives";
import { push } from "@/ui/navigate";
import { Press } from "@/ui/Press";
import { DetailShell } from "@/ui/shells/DetailShell";
import { EmptyState } from "@/ui/shells/EmptyState";
import { MetricState } from "@/ui/shells/MetricState";
import { SectionShell } from "@/ui/shells/SectionShell";
import { SkeletonText } from "@/ui/Skeleton";
import { Text } from "@/ui/Text";
import { useDayScreen } from "./day";
import { ErrorView } from "./ErrorView";
import { BLOOD_OXYGEN_INFO } from "./info";

const HREF = "/health/blood-oxygen";
const GOOGLE_SETTINGS = "/settings?s=source";
/** Half an hour or more of the arm on the sensor is toned in the week; a few minutes is every night. */
const ARM_NOTABLE_MIN = 30;

/** The night's average over its low, its minutes under 95% and how many minutes the band read. */
function Hero({ vm }: { vm: BloodOxygenVM }) {
  const n = vm.night.value;
  const stats = [
    { label: "Low", value: n ? `${n.low.v}` : MISSING, spoken: n ? `${n.low.v} percent` : "no readings" },
    { label: "Under 95%", value: n ? `${n.below95Min}` : MISSING, unit: "min", spoken: n ? `${n.below95Min} minutes` : "no readings" },
    { label: "Readings", value: n ? `${n.readMin}` : MISSING, spoken: n ? `${n.readMin} minutes read` : "no readings" },
  ];
  const big = "font-numeric text-[64px] font-bold leading-[64px] tracking-[-0.02em]";
  const unit = "text-xl font-semibold leading-7 text-foreground-secondary";
  return (
    <View className="w-full max-w-[360px] items-center gap-2 py-4">
      <MetricState
        metric={vm.average}
        skeleton={null}
        renderReason={(r) => (
          <>
            <ValueUnit value={MISSING} unit="%" className={big} unitClassName={unit} />
            <Text className={CAPTION}>{r === "awaiting_sleep_sync" ? "Waiting for last night’s sleep" : r === "band_not_worn" ? "Band not worn this night" : "No readings on this night"}</Text>
          </>
        )}
      >
        {(avg) => {
          const clean = vm.night.value?.cleanAverage ?? null;
          const armMin = vm.night.value?.armMin ?? 0;
          return (
            <>
              <ValueUnit value={avg.toFixed(1)} unit="%" className={big} unitClassName={unit} />
              <Text className={CAPTION}>{vm.isToday ? "Last night’s average" : "Night average"}</Text>
              {vm.chip && (
                <StatusChip tone={vm.chip.tone} className="mt-1">
                  {vm.chip.text}
                </StatusChip>
              )}
              {/* The average with the arm's minutes taken out, when they moved it: Fitbit's number includes them. */}
              {clean !== null && armMin > 0 && Math.abs(clean - avg) >= 0.1 && (
                <Text className={cn(CAPTION, "mt-1")} accessibilityLabel={`Without the arm: ${clean.toFixed(1)} percent`}>
                  Without the arm <Text className="font-numeric font-bold tabular-nums text-foreground">{clean.toFixed(1)}%</Text>
                </Text>
              )}
            </>
          );
        }}
      </MetricState>
      <View className="mt-4 w-full flex-row gap-3">
        {stats.map((s) => (
          <View key={s.label} accessible accessibilityLabel={`${s.label}: ${s.spoken}`} className="flex-1 items-center">
            <Text accessibilityElementsHidden className="font-numeric text-xl font-bold leading-6 tabular-nums">
              {s.value}
              {s.unit && s.value !== MISSING && <Text className="text-sm font-semibold text-foreground-secondary"> {s.unit}</Text>}
            </Text>
            <Text accessibilityElementsHidden className={cn(LABEL, "mt-1 text-muted-foreground")}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The night's dips told apart by the heart's answer: the number that says whether the low minutes were breathing or the arm. */
function Dips({ vm }: { vm: BloodOxygenVM }) {
  const n = vm.night.value;
  if (!n) return <Text className={CAPTION}>No readings on this night.</Text>;
  const d = n.dipSummary;
  const noHr = n.hr === null;
  const stats = [
    { label: "Breathing", value: noHr ? MISSING : String(d.answered), spoken: noHr ? "unknown, no heart rate" : `${d.answered} dips the heart rate answered`, tone: d.answered > 0 ? "text-warning-text" : "" },
    { label: "Arm dips", value: noHr ? MISSING : String(d.flat), spoken: noHr ? "unknown, no heart rate" : `${d.flat} dips with the heart rate flat`, tone: "" },
    { label: "Arm", value: noHr ? MISSING : String(n.armMin), unit: "min", spoken: noHr ? "unknown, no heart rate" : `${n.armMin} minutes the arm held the sensor low`, tone: "" },
    { label: "Unreadable", value: String(d.gapMin), unit: "min", spoken: `${d.gapMin} minutes the band could not read`, tone: "" },
  ];
  const dipsLine =
    d.dips === 0
      ? "No dips of 3% or more this night."
      : noHr
        ? `${d.dips} ${d.dips === 1 ? "dip" : "dips"} of 3% or more; no heart rate this night to tell what they were.`
        : d.answered === 0
          ? `${d.dips} ${d.dips === 1 ? "dip" : "dips"} of 3% or more, none answered by your heart rate: the arm the band is on, most likely, not your breathing.`
          : d.flat === 0 && d.unknown === 0
            ? `${d.dips} ${d.dips === 1 ? "dip" : "dips"} of 3% or more, every one answered by a heart-rate rise: breathing events, not the arm.`
            : `${d.dips} dips of 3% or more: ${d.answered} answered by a heart-rate rise (breathing), ${d.flat} with the heart rate flat (the arm, most likely)${d.unknown ? `, ${d.unknown} with no heart rate to say` : ""}.`;
  const armLine =
    noHr || n.armMin === 0
      ? null
      : `The arm held the sensor low for ${n.armMin} minutes in ${n.arm.length === 1 ? "one stretch" : `${n.arm.length} stretches`} (shaded on the chart)${n.cleanAverage !== null && vm.average.value !== null && Math.abs(n.cleanAverage - vm.average.value) >= 0.1 ? `; without them the night averages ${n.cleanAverage.toFixed(1)}%, against ${vm.average.value.toFixed(1)}% with them` : ""}.`;
  return (
    <View className="gap-3">
      <Text className="text-[15px] leading-[22px]">{armLine ? `${dipsLine} ${armLine}` : dipsLine}</Text>
      <View className="flex-row gap-3">
        {stats.map((s) => (
          <View key={s.label} accessible accessibilityLabel={`${s.label}: ${s.spoken}`} className="flex-1 items-center">
            <Text accessibilityElementsHidden className={cn("font-numeric text-xl font-bold leading-6 tabular-nums", s.tone)}>
              {s.value}
              {s.unit && <Text className="text-sm font-semibold text-foreground-secondary"> {s.unit}</Text>}
            </Text>
            <Text accessibilityElementsHidden className={cn(LABEL, "mt-1 text-muted-foreground")}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const CELL = "font-numeric text-[15px] font-bold leading-5 tabular-nums";
const HEAD = cn(LABEL, "text-[10px] leading-3 text-muted-foreground");

/** The week's nights as rows (oldest first, the shown night last); a row opens its night. */
function Week({ vm, today }: { vm: BloodOxygenVM; today: string }) {
  return (
    <View>
      <View className="flex-row items-end pb-2">
        <Text className={cn(HEAD, "flex-1")}>Night</Text>
        <Text className={cn(HEAD, "w-12 text-right")}>Avg</Text>
        <Text className={cn(HEAD, "w-14 text-right")}>No arm</Text>
        <Text className={cn(HEAD, "w-16 text-right")}>Breathing</Text>
        <Text className={cn(HEAD, "w-14 text-right")}>Arm</Text>
        <View className="w-6" />
      </View>
      {vm.nights.map((n) => {
        const current = n.day === vm.day;
        const armTone = n.armMin !== null && n.armMin >= ARM_NOTABLE_MIN;
        return (
          <Press
            key={n.day}
            accessibilityRole="link"
            accessibilityLabel={`${n.day === today ? "Last night" : formatDay(n.day, DAY.long)}: average ${n.average === null ? "no readings" : `${n.average.toFixed(1)} percent`}${n.cleanAverage !== null ? `, ${n.cleanAverage.toFixed(1)} without the arm` : ""}, ${n.answered ?? 0} dips the heart rate answered, the arm ${n.armMin ?? 0} minutes`}
            onPress={() => push(dayHref(HREF, n.day, today))}
            className="flex-row items-center border-t border-border py-2.5"
          >
            <Text className={cn("flex-1 text-[15px] leading-5", current ? "font-bold" : "font-medium text-foreground-secondary")}>{n.day === today ? "Last night" : formatDay(n.day, DAY.short)}</Text>
            <Text className={cn(CELL, "w-12 text-right")}>{n.average !== null ? `${n.average.toFixed(1)}` : MISSING}</Text>
            <Text className={cn(CELL, "w-14 text-right text-foreground-secondary")}>{n.cleanAverage !== null ? `${n.cleanAverage.toFixed(1)}` : MISSING}</Text>
            <Text className={cn(CELL, "w-16 text-right", n.answered ? "text-warning-text" : "text-foreground-secondary")}>{n.answered !== null ? String(n.answered) : MISSING}</Text>
            <Text className={cn(CELL, "w-14 text-right", armTone ? "text-foreground" : "text-foreground-secondary")}>{n.armMin !== null ? `${n.armMin} min` : MISSING}</Text>
            <View className="w-6 items-end">
              <Icon icon={ChevronRight} size={16} tone="muted-foreground" strokeWidth={2} />
            </View>
          </Press>
        );
      })}
    </View>
  );
}

export function BloodOxygenScreen() {
  const { data, error, reload } = useDayScreen("bloodOxygen", getBloodOxygen);
  const vm = data?.vm;
  const series = useMemo(
    () => vm && (vm.night.value ? { value: { bed: vm.night.value.bed, wake: vm.night.value.wake, points: vm.night.value.points, low: vm.night.value.low, hr: vm.night.value.hr, dips: vm.night.value.dips, arm: vm.night.value.arm }, reason: null, provisional: false } : vm.night),
    [vm],
  );
  if (!data || !vm || !series) return error ? <ErrorView detail retry={reload} /> : <BloodOxygenLoading />;
  const { d, today } = data;
  const nightTitle = vm.isToday ? "Last night" : dayLabel(d, today);
  return (
    <DetailShell
      title="Blood oxygen"
      bodySkeleton={BODY_SKELETON}
      dateSwitcher={{ mode: "day" }}
      info={BLOOD_OXYGEN_INFO}
      hero={<Hero vm={vm} />}
      primary={
        <SectionShell
          variant="card"
          title={nightTitle}
          action={{ label: "Zoom", href: chartHref({ metric: "spo2", r: "day", d }) }}
          info={{ title: "Blood oxygen through the night", body: "Each minute the band could read, from bedtime to waking, with your heart rate on the right-hand axis. A gap is a minute the band could not read: movement, or the arm it is on being slept on. A dip your heart rate answers with a jump a minute or two later is a breathing event; a dip or a gap it ignores is almost always the arm, not the lungs. The dashed line marks 95%, under which readings count as low." }}
        >
          {vm.connected ? (
            <NightSpo2Chart data={series} />
          ) : (
            <EmptyState
              body="Fitbit keeps every minute of your blood oxygen in Google’s cloud, not in Health Connect. Connect Google in Settings to see them here."
              action={{ label: "Open Settings", href: GOOGLE_SETTINGS }}
            />
          )}
        </SectionShell>
      }
      secondary={
        vm.connected
          ? [
              <SectionShell
                key="dips"
                variant="card"
                title="Dips"
                info={{
                  title: "Breathing or the arm",
                  body: "A dip is a fall of 3% or more under the previous ten minutes. The heart gives it away: when the airway narrows, the heart rate jumps within a minute or two of the low as you rouse (counted as Breathing); when the arm the band is on is slept on, the sensor loses blood flow, reads low, and the heart rate stays flat (counted as Arm dips). The arm also sags the reading slowly and holds it low for an hour or more, which no dip rule sees, so a stretch of ten minutes or longer sitting 3% under the night’s good level with the heart rate quiet is counted as Arm minutes and shaded on the chart; the average without those minutes stands beside Fitbit’s, which includes them. Unreadable minutes are stretches of two or more the band threw away, which a crushed arm also causes. Counts, not a diagnosis: nights with many answered dips are worth a conversation with a doctor.",
                }}
              >
                <Dips vm={vm} />
              </SectionShell>,
              <SectionShell key="week" variant="card" title="This week" info={{ title: "Seven nights", body: "Each night’s average as Fitbit gives it, the average with the arm’s minutes taken out, the dips the heart rate answered (Breathing), and the minutes the arm held the sensor low. Tap a night to see it." }}>
                <Week vm={vm} today={today} />
              </SectionShell>,
            ]
          : []
      }
    />
  );
}

const LOADING_PRIMARY = (
  <SectionShell variant="card" title="Last night">
    <NightSpo2ChartSkeleton />
  </SectionShell>
);

const LOADING_SECONDARY = [
  <SectionShell key="dips" variant="card" title="Dips">
    <View accessibilityElementsHidden className="gap-3">
      <SkeletonText className="w-full" />
      <View className="flex-row gap-3">
        {["Breathing", "Arm dips", "Arm", "Unreadable"].map((w) => (
          <View key={w} className="flex-1 items-center">
            <SkeletonText lh={24} fs={20} className="w-[42px]" />
            <Text className={cn(LABEL, "mt-1 text-muted-foreground")}>{w}</Text>
          </View>
        ))}
      </View>
    </View>
  </SectionShell>,
  <SectionShell key="week" variant="card" title="This week">
    <View>
      {Array.from({ length: 7 }, (_, i) => (
        <View key={i} className="flex-row items-center justify-between border-t border-border py-2.5">
          <SkeletonText className="w-24" />
          <SkeletonText className="w-40" />
        </View>
      ))}
    </View>
  </SectionShell>,
];

/** Below the fold while a cold push slides in: the loading state's first sections. */
const BODY_SKELETON = (
  <>
    {LOADING_PRIMARY}
    <View className="gap-3">{LOADING_SECONDARY}</View>
  </>
);

/** Blood oxygen loading: the date row, the average with its three stats, the night's chart, then the week's nights. */
function BloodOxygenLoading() {
  return (
    <DetailShell
      loading
      title="Blood oxygen"
      dateSwitcher={{ mode: "day" }}
      hero={
        <View accessibilityElementsHidden className="w-full max-w-[360px] items-center gap-2 py-4">
          <SkeletonText lh={64} fs={64} className="w-[130px]" />
          <SkeletonText className="w-28" />
          <View className="mt-4 w-full flex-row gap-3">
            {["Low", "Under 95%", "Readings"].map((w) => (
              <View key={w} className="flex-1 items-center">
                <SkeletonText lh={24} fs={20} className="w-[42px]" />
                <Text className={cn(LABEL, "mt-1 text-muted-foreground")}>{w}</Text>
              </View>
            ))}
          </View>
        </View>
      }
      primary={LOADING_PRIMARY}
      bodySkeleton={BODY_SKELETON}
      secondary={LOADING_SECONDARY}
    />
  );
}
