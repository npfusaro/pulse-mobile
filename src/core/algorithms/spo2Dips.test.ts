// SpO2 dips told apart by the heart's answer, on scripted nights: a 3% dip with a heart-rate rise is answered, one
// with the heart flat is flat, one with no heart rate around it is unknown; shallow wobbles are not dips; gaps
// inside a dip do not end it; dips a minute apart merge; unreadable minutes count in runs.
import { describe, expect, it } from "vitest";
import { findSpo2Dips, spo2DipConfig, spo2GapMinutes, summarizeSpo2Dips } from "./spo2Dips";

const T0 = Date.parse("2026-10-20T03:00:00Z");
const MIN = 60_000;
const bed = T0;
const wake = T0 + 120 * MIN;

/** A night: `base` everywhere, `shape(i)` overriding minute i (undefined keeps the base, null makes a gap). */
const series = (base: number, shape: (i: number) => number | null | undefined, minutes = 120) =>
  Array.from({ length: minutes }, (_, i) => {
    const s = shape(i);
    return { t: T0 + i * MIN, v: s === undefined ? base : s };
  });

const flatHr = series(58, () => undefined);

describe("findSpo2Dips", () => {
  it("finds a 3-point dip, its nadir, its baseline and when it recovered", () => {
    const spo2 = series(97, (i) => (i >= 30 && i < 36 ? [94, 93, 92, 93, 94, 95][i - 30] : undefined));
    const dips = findSpo2Dips(spo2, flatHr, bed, wake);
    expect(dips).toHaveLength(1);
    const d = dips[0];
    expect(d.start).toBe(T0 + 30 * MIN);
    expect(d.nadir).toEqual({ t: T0 + 32 * MIN, v: 92 });
    expect(d.baseline).toBe(97);
    expect(d.drop).toBe(5);
    // Back within 1 of the baseline at minute 36 (97): the dip ends after minute 35.
    expect(d.end).toBe(T0 + 36 * MIN);
  });

  it("a flat heart rate makes the dip the arm's; a rise of 5 bpm after the nadir makes it answered; no heart rate is unknown", () => {
    const spo2 = series(97, (i) => (i >= 30 && i < 34 ? 92 : i >= 70 && i < 74 ? 92 : undefined));
    const hr = series(58, (i) => (i >= 72 && i < 76 ? 70 : undefined)); // the second dip's nadir at 70: +12 after it
    const dips = findSpo2Dips(spo2, hr, bed, wake);
    expect(dips.map((d) => d.hr)).toEqual(["flat", "answered"]);
    expect(dips[0].hrDelta).toBe(0);
    expect(dips[1].hrDelta).toBe(12);
    expect(findSpo2Dips(spo2, null, bed, wake).map((d) => d.hr)).toEqual(["unknown", "unknown"]);
    // Heart rate missing around the dip only: unknown, the rest still judged.
    const holes = series(58, (i) => (i >= 24 && i < 36 ? null : i >= 72 && i < 76 ? 70 : undefined));
    expect(findSpo2Dips(spo2, holes, bed, wake).map((d) => d.hr)).toEqual(["unknown", "answered"]);
  });

  it("ignores wobbles under 3 points and a dip whose baseline has too few readings", () => {
    expect(findSpo2Dips(series(97, (i) => (i % 7 === 0 ? 95 : i % 5 === 0 ? 96 : undefined)), flatHr, bed, wake)).toEqual([]);
    // The first minutes have no 10-minute history: a low start is not a dip.
    expect(findSpo2Dips(series(97, (i) => (i < 4 ? 90 : undefined)), flatHr, bed, wake)).toEqual([]);
  });

  it("a gap inside a dip does not end it, and dips a minute apart merge into one with the lower nadir", () => {
    const spo2 = series(97, (i) => (i === 30 ? 93 : i === 31 ? null : i === 32 ? 91 : i === 33 ? 96.5 : i === 34 ? 92 : undefined));
    const dips = findSpo2Dips(spo2, flatHr, bed, wake);
    expect(dips).toHaveLength(1);
    expect(dips[0].nadir.v).toBe(91);
    expect(dips[0].end).toBe(T0 + 35 * MIN);
  });

  it("only looks inside the sleep window and keeps dips in time order", () => {
    const spo2 = series(97, (i) => (i < 5 ? 90 : i >= 50 && i < 53 ? 92 : i >= 20 && i < 23 ? 93 : undefined), 130);
    const dips = findSpo2Dips(spo2, flatHr, T0 + 10 * MIN, wake);
    expect(dips.map((d) => (d.start - T0) / MIN)).toEqual([20, 50]);
  });
});

describe("spo2GapMinutes and the summary", () => {
  it("counts unreadable minutes in runs of two or more inside the sleep", () => {
    const spo2 = series(97, (i) => (i === 10 ? null : i >= 40 && i < 47 ? null : i >= 118 ? null : undefined));
    expect(spo2GapMinutes(spo2, bed, wake)).toBe(7 + 2);
    expect(spo2GapMinutes(spo2, bed, T0 + 30 * MIN)).toBe(0);
    expect(spo2GapMinutes([], bed, wake)).toBe(0);
  });

  it("summarises the counts", () => {
    const spo2 = series(97, (i) => (i >= 30 && i < 34 ? 92 : i >= 70 && i < 74 ? 92 : undefined));
    const hr = series(58, (i) => (i >= 72 && i < 76 ? 70 : undefined));
    expect(summarizeSpo2Dips(findSpo2Dips(spo2, hr, bed, wake), 12)).toEqual({ dips: 2, answered: 1, flat: 1, unknown: 0, gapMin: 12 });
    expect(spo2DipConfig.dropPct).toBe(3);
  });
});
