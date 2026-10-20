// How much history the sources import (Settings › Data source › History): the Health Connect window, and the Google
// Health API's blood-oxygen backfill. Was a constant (180). Neither source caps how far back it can be read, once
// Health Connect's past-data permission is granted; Health Connect holds only what the Google Health app wrote into
// it, so a longer window brings more only when that reaches further back. Longer is just more reading.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { forgetChanges } from "@/health/importState";

export const HISTORY_DAYS_KEY = "pulse.historyDays";
export const DEFAULT_HISTORY_DAYS = 180;
/** The choices Settings offers, in local days (today counts). */
export const HISTORY_DAY_OPTIONS = [90, 180, 365, 730, 1095] as const;
export const MAX_HISTORY_DAYS = 3650;

export const historyLabel = (days: number): string => (days % 365 === 0 ? `${days / 365} ${days === 365 ? "year" : "years"}` : `${days} days`);

export async function getHistoryDays(): Promise<number> {
  try {
    const n = Number(await AsyncStorage.getItem(HISTORY_DAYS_KEY));
    return Number.isInteger(n) && n >= 1 && n <= MAX_HISTORY_DAYS ? n : DEFAULT_HISTORY_DAYS;
  } catch {
    return DEFAULT_HISTORY_DAYS;
  }
}

/**
 * Stores the choice. Raised, the next sync re-reads Health Connect's whole window so the older days come in (the
 * Google source notices on its own). Lowered, nothing already imported is removed.
 */
export async function setHistoryDays(days: number): Promise<void> {
  const before = await getHistoryDays();
  await AsyncStorage.setItem(HISTORY_DAYS_KEY, String(days));
  if (days > before) await forgetChanges();
}
