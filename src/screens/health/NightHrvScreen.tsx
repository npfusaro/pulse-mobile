// Night HRV `/health/night-hrv?d=` (fork addition): the night's average RMSSD with where it sits in Fitbit's range,
// the deep-sleep RMSSD, the high and the readings; the night's five-minute chart with deep sleep lit; the week's
// nights as rows, each opening its night. The curve is Health Connect's; the deep-sleep value and the range come
// from the Google Health API (src/google), and without it connected the screen says what it is missing.
import { useMemo } from "react";
import { View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { DAY, dayLabel, formatDay, MISSING } from "@/lib/format";
import { dayHref } from "@/lib/url";
import { getNightHrv } from "@/queries/nightHrv";
import type { NightHrvVM } from "@/queries/types";
import { NightHrvChart, NightHrvChartSkeleton } from "@/ui/charts/NightHrvChart";
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
import { NIGHT_HRV_INFO } from "./info";

const HREF = "/health/night-hrv";
const GOOGLE_SETTINGS = "/settings?s=source";

/** The night's average over its deep-sleep RMSSD, its high and how many readings the band kept. */
function Hero({ vm }: { vm: NightHrvVM }) {
  const n = vm.night.value;
  const stats = [
    { label: "Deep sleep", value: vm.deep !== null ? `${vm.deep}` : MISSING, unit: "ms", spoken: vm.deep !== null ? `${vm.deep} milliseconds` : "not available" },
    { label: "High", value: n ? `${n.high.v}` : MISSING, unit: "ms", spoken: n ? `${n.high.v} milliseconds` : "no readings" },
    { label: "Readings", value: n ? `${n.readings}` : MISSING, spoken: n ? `${n.readings} readings` : "no readings" },
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
            <ValueUnit value={MISSING} unit="ms" className={big} unitClassName={unit} />
            <Text className={CAPTION}>{r === "awaiting_sleep_sync" ? "Waiting for last night’s sleep" : r === "band_not_worn" ? "Band not worn this night" : "No HRV on this night"}</Text>
          </>
        )}
      >
        {(avg) => (
          <>
            <ValueUnit value={Number.isInteger(avg) ? String(avg) : avg.toFixed(1)} unit="ms" className={big} unitClassName={unit} />
            <Text className={CAPTION}>{vm.isToday ? "Last night’s average" : "Night average"}</Text>
            {vm.chip && (
              <StatusChip tone={vm.chip.tone} className="mt-1">
                {vm.chip.text}
              </StatusChip>
            )}
          </>
        )}
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

const CELL = "font-numeric text-[15px] font-bold leading-5 tabular-nums";
const HEAD = cn(LABEL, "text-[10px] leading-3 text-muted-foreground");

const fmt = (v: number | null) => (v === null ? MISSING : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** The week's nights as rows (oldest first, the shown night last); a row opens its night. */
function Week({ vm, today }: { vm: NightHrvVM; today: string }) {
  return (
    <View>
      <View className="flex-row items-end pb-2">
        <Text className={cn(HEAD, "flex-1")}>Night</Text>
        <Text className={cn(HEAD, "w-16 text-right")}>Average</Text>
        <Text className={cn(HEAD, "w-20 text-right")}>Deep sleep</Text>
        <Text className={cn(HEAD, "w-16 text-right")}>Range</Text>
        <View className="w-6" />
      </View>
      {vm.nights.map((n) => {
        const current = n.day === vm.day;
        return (
          <Press
            key={n.day}
            accessibilityRole="link"
            accessibilityLabel={`${n.day === today ? "Last night" : formatDay(n.day, DAY.long)}: average ${n.average === null ? "no readings" : `${fmt(n.average)} milliseconds`}, deep sleep ${n.deep === null ? "not available" : `${fmt(n.deep)} milliseconds`}, ${n.inRange === null ? "no range" : n.inRange ? "within your range" : "outside your range"}`}
            onPress={() => push(dayHref(HREF, n.day, today))}
            className="flex-row items-center border-t border-border py-2.5"
          >
            <Text className={cn("flex-1 text-[15px] leading-5", current ? "font-bold" : "font-medium text-foreground-secondary")}>{n.day === today ? "Last night" : formatDay(n.day, DAY.short)}</Text>
            <Text className={cn(CELL, "w-16 text-right")}>{fmt(n.average)}</Text>
            <Text className={cn(CELL, "w-20 text-right text-foreground-secondary")}>{fmt(n.deep)}</Text>
            <Text className={cn(CELL, "w-16 text-right", n.inRange === false ? "text-warning-text" : "text-foreground-secondary")}>{n.inRange === null ? MISSING : n.inRange ? "In" : "Out"}</Text>
            <View className="w-6 items-end">
              <Icon icon={ChevronRight} size={16} tone="muted-foreground" strokeWidth={2} />
            </View>
          </Press>
        );
      })}
    </View>
  );
}

export function NightHrvScreen() {
  const { data, error, reload } = useDayScreen("nightHrv", getNightHrv);
  const vm = data?.vm;
  const series = useMemo(
    () => vm && (vm.night.value ? { value: { bed: vm.night.value.bed, wake: vm.night.value.wake, points: vm.night.value.points, deep: vm.night.value.deep, range: vm.range, high: vm.night.value.high }, reason: null, provisional: false } : vm.night),
    [vm],
  );
  if (!data || !vm || !series) return error ? <ErrorView detail retry={reload} /> : <NightHrvLoading />;
  const { d, today } = data;
  const nightTitle = vm.isToday ? "Last night" : dayLabel(d, today);
  return (
    <DetailShell
      title="Night HRV"
      bodySkeleton={BODY_SKELETON}
      dateSwitcher={{ mode: "day" }}
      info={NIGHT_HRV_INFO}
      hero={<Hero vm={vm} />}
      primary={
        <SectionShell
          variant="card"
          title={nightTitle}
          info={{ title: "HRV through the night", body: "One RMSSD reading every five minutes from bedtime to waking; deep sleep is lit, since that is where HRV runs highest and steadiest. A break is a stretch the band could not read. The shaded band is your typical range: the Health Monitor’s, from your last month of nights, or Fitbit’s own when Google provides it." }}
        >
          <NightHrvChart data={series} />
          {!vm.connected && (
            <View className="mt-3">
              <EmptyState
                body="The deep-sleep HRV lives in Google’s cloud, not in Health Connect. Connect Google in Settings to see it here."
                action={{ label: "Open Settings", href: GOOGLE_SETTINGS }}
              />
            </View>
          )}
        </SectionShell>
      }
      secondary={[
        <SectionShell key="week" variant="card" title="This week" info={{ title: "Seven nights", body: "Each night’s average RMSSD, Fitbit’s deep-sleep RMSSD (from Google), and whether the average sat inside your typical range as of that night. Tap a night to see it." }}>
          <Week vm={vm} today={today} />
        </SectionShell>,
      ]}
    />
  );
}

const LOADING_PRIMARY = (
  <SectionShell variant="card" title="Last night">
    <NightHrvChartSkeleton />
  </SectionShell>
);

const LOADING_SECONDARY = [
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

/** Night HRV loading: the date row, the average with its three stats, the night's chart, then the week's nights. */
function NightHrvLoading() {
  return (
    <DetailShell
      loading
      title="Night HRV"
      dateSwitcher={{ mode: "day" }}
      hero={
        <View accessibilityElementsHidden className="w-full max-w-[360px] items-center gap-2 py-4">
          <SkeletonText lh={64} fs={64} className="w-[130px]" />
          <SkeletonText className="w-28" />
          <View className="mt-4 w-full flex-row gap-3">
            {["Deep sleep", "High", "Readings"].map((w) => (
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
