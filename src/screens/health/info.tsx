// The Health screens' info-card copy, from pulse's pages, reworded for the Pulse engine. The web's <p> is a <Text> styled as
// the info card's body (the same as src/screens/_lib/info.tsx's, which does not export it).
import type { ReactNode } from "react";
import { View } from "react-native";
import { AGE_LABEL } from "@/lib/format";
import { Text } from "@/ui/Text";
import type { InfoContent } from "@/ui/shells/InfoButton";

function P({ children }: { children: ReactNode }) {
  return <Text className="text-[15px] leading-[22px] text-foreground-body">{children}</Text>;
}

export const MONITOR_INFO: InfoContent = {
  title: "About Health Monitor",
  body: (
    <P>
      Health Monitor compares last night’s vitals with your personal normal range: the average of your last 30 nights plus or minus one standard
      deviation. Blood oxygen also flags anything below 95%. A change in several vitals at once can be an early sign of illness. Pulse is not a medical device; if you
      feel unwell, talk to a doctor.
    </P>
  ),
};

const LEVELS = [
  { swatch: "bg-stress-low", text: "Low, 0 - 29: you might be feeling calm, relaxed or sleepy." },
  { swatch: "bg-stress-medium", text: "Medium, 30 - 59: neutral, alert or mildly activated." },
  { swatch: "bg-stress-high", text: "High, 60 - 100: excited, stressed or highly activated." },
];

export const STRESS_INFO: InfoContent = {
  title: "About Stress Monitor",
  body: (
    <>
      <P>Stress Monitor scores how activated your body is, from 0 to 100, every 6 minutes: your heart rate against your awake heart rate over the last 30 days, and at night your HRV against its 30-day baseline.</P>
      <View className="gap-2">
        {LEVELS.map((l) => (
          <View key={l.swatch} className="flex-row items-start gap-3">
            <View accessibilityElementsHidden className={`mt-1.5 size-2.5 shrink-0 rounded-sm ${l.swatch}`} />
            <View className="flex-1">
              <P>{l.text}</P>
            </View>
          </View>
        ))}
      </View>
      <P>Workouts and exercise are left out, so a run never counts as stress. Stress is provisional until your data spans 30 days.</P>
    </>
  ),
};

export const FITNESS_INFO: InfoContent = {
  title: "About Fitness",
  body: (
    <P>
      VO2 max is the most oxygen your body can use during hard exercise. Pulse ranks it against people of your age and sex from the FRIEND registry.
      Training load divides your fatigue (about a week of workout load) by your fitness (about three weeks); above 1.4 is a spike.
    </P>
  ),
};

export const HEALTHSPAN_INFO: InfoContent = {
  title: "About Healthspan",
  body: (
    <P>
      {AGE_LABEL} estimates how old your body behaves, from nine habits and vitals over the 28 days ending each Sunday. Pace of Aging is your
      {AGE_LABEL} divided by your age: 1.0x means your body behaves its age, below 1.0x younger, above 1.0x older. Both are estimates for personal insight, not a
      medical assessment.
    </P>
  ),
};

export const HEART_RATE_INFO: InfoContent = {
  title: "About heart rate",
  body: (
    <>
      <P>Your band records heart rate through the day. The Google Health app shares it with Health Connect, and Pulse reads it from there.</P>
      <P>While this screen is open on today, Pulse checks for new readings every minute. A reading usually arrives one to three minutes after your band takes it, so the newest one is never quite now.</P>
      <P>The chart shows each minute’s average. Minutes without a reading, when the band was off or not syncing, stay blank.</P>
    </>
  ),
};

/** Fork addition: the Blood oxygen screen (the Google source's minute readings). */
export const BLOOD_OXYGEN_INFO: InfoContent = {
  title: "About blood oxygen",
  body: (
    <>
      <P>Your band estimates blood oxygen (SpO2) once a minute while you sleep, from the red and infrared light its sensor shines through your skin. Fitbit keeps every minute in Google’s cloud but shows only a nightly average; Pulse reads the minutes from the Google Health API (Settings › Data source › Google Health).</P>
      <P>Minutes the band could not read reliably, when you moved or the band sat loose, are left out, so gaps in the chart are normal. Your heart rate is drawn on the same chart, on the right-hand axis, because it tells the two kinds of dip apart: when the airway narrows, oxygen falls and the heart rate jumps a minute or two later as you rouse; when the arm the band is on is slept on, the sensor loses blood flow and reads low or not at all while the heart rate stays flat. Dips and gaps that cluster in one position with a flat heart rate are the arm, not the lungs. The Dips card counts exactly that for the night: every fall of 3% or more, split into those your heart rate answered (Breathing) and those it ignored (Arm), with the minutes the band could not read at all.</P>
      <P>Most people sit between 95 and 100% through the night. Brief dips are common and usually mean nothing; a night that stays low, or a trend downward, is worth a conversation with a doctor. This is an estimate, not a medical measurement.</P>
    </>
  ),
};

export const NIGHT_HRV_INFO: InfoContent = {
  title: "About night HRV",
  body: (
    <>
      <P>Heart rate variability is the small change in time between one heartbeat and the next, measured here as RMSSD in milliseconds. Your band reads it every five minutes while you sleep; Fitbit’s app shows only the night’s average. Pulse draws every reading, with deep sleep lit: that is where HRV runs highest and steadiest, and Fitbit’s deep-sleep RMSSD is the number it reports from those stretches.</P>
      <P>The shaded band on the chart, and the standing under the average, is your typical range: the same one the Health Monitor judges HRV by, built from your last month of nights (or Fitbit’s own, should the Google Health API provide it). A night under it usually follows a hard day, a late drink or the start of an illness; a night over it is good news.</P>
      <P>Recovery keeps its own baseline, built from the same readings; nothing on this screen changes a score. HRV varies a lot from night to night and from person to person, so the trend over weeks matters more than one night.</P>
    </>
  ),
};
