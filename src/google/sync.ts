// The Google Health API source, after the server app's src/server/sources/google/sync.ts: the band's
// minute-by-minute blood oxygen into spo2_days, and per night Fitbit's average and deep-sleep RMSSD and its personal
// ranges for HRV and resting HR into google_daily. A first import walks the history window oldest first in 14-day
// windows, each committed with its cursor so an interrupted import resumes; later syncs re-read from a few days
// before the cursor. Within a window the stored SpO2 samples become exactly what Google returned (a reading deleted
// upstream goes), as the server does for heart rate; the nightly rows merge by day. The ranges reach the Health
// Monitor through allMetrics (stage 2 replays every day, so no day needs marking dirty); nothing else is scored.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Store } from "@/data/store";
import type { GoogleDaily, Spo2Sample } from "@/data/types";
import { addDays, localDay, localMidnight } from "@/lib/time";
import { accessToken, GoogleAuthError } from "./auth";
import { createGoogleClient, DATA_TYPES, type GoogleClient, GoogleError, localWindows } from "./client";
import { mapDailyHrv, mapOxygenSaturation, mapPersonalRange } from "./map";

export const GOOGLE_SYNC_KEY = "pulse.google.spo2";
/** Bumped when a sync starts reading a new type: an older cursor re-walks the history window so the type is backfilled. */
export const SYNC_VERSION = 2;
/** Every window is this wide: the shortest limit among the types read (oxygen-saturation's). */
export const WINDOW_DAYS = DATA_TYPES["oxygen-saturation"].maxDays;

/** Later syncs re-read this many local days before the cursor: a night's readings land hours after the band syncs. */
export const OVERLAP_DAYS = 3;

/** What the import remembers, outside the Store (it describes Google, not Pulse's rows). */
export type GoogleSyncState = {
  /** The SYNC_VERSION the cursor was written under; an older one is treated as no cursor. */
  version: number;
  /** The end of the last committed window, unix seconds; null before the first. */
  syncedThrough: number | null;
  /** The history window the import was started with; a longer setting re-walks from the new start. */
  backfillDays: number | null;
  /** Local days walked of `backfillDays`, for the progress line; equal once the first import is done. */
  backfillDone: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  /**
   * Google's answer when it refused a personal-range roll-up outright (INVALID_ARGUMENT, NOT_FOUND): the ranges are
   * not to be had for this account or build, so later syncs skip them and Settings says so. Cleared by a fresh walk.
   */
  rangesError: string | null;
};

const EMPTY: GoogleSyncState = { version: 0, syncedThrough: null, backfillDays: null, backfillDone: 0, lastSuccessAt: null, lastError: null, rangesError: null };

export async function readGoogleSyncState(): Promise<GoogleSyncState> {
  try {
    const raw = await AsyncStorage.getItem(GOOGLE_SYNC_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<GoogleSyncState>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

async function writeGoogleSyncState(patch: Partial<GoogleSyncState>): Promise<GoogleSyncState> {
  const next = { ...(await readGoogleSyncState()), ...patch };
  await AsyncStorage.setItem(GOOGLE_SYNC_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

/** Forgets the cursor (Google disconnected): the next connect starts a fresh import. */
export async function forgetGoogleSync(): Promise<void> {
  await AsyncStorage.removeItem(GOOGLE_SYNC_KEY).catch(() => {});
}

export type GoogleSyncOptions = {
  timeZone: string;
  /** Local days the first import covers (today counts). */
  historyDays: number;
  now?: () => number;
  onProgress?: (step: string, done: number, total: number) => void;
  /** Tests: a scripted fetch and no waiting. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  token?: (retry: boolean) => Promise<string>;
};

export type GoogleSyncResult = {
  /** Blood-oxygen samples written. */
  samples: number;
  /** Nightly rows (daily HRV, personal ranges) written. */
  nights: number;
  /** Hints, never errors: "google_needs_consent", "google_error:<code>". */
  warnings: string[];
};

/**
 * One run: the window to read, read it in 14-day windows, write each as it arrives. Throws nothing: an auth or API
 * failure is recorded in the state's lastError and returned as a warning, so a bad day at Google never stops the
 * Health Connect import or the scoring that follows it.
 */
export async function syncGoogle(store: Store, opts: GoogleSyncOptions): Promise<GoogleSyncResult> {
  const tz = opts.timeZone;
  const now = opts.now ?? Date.now;
  const nowS = () => Math.floor(now() / 1000);
  const progress = opts.onProgress ?? (() => {});
  const warnings: string[] = [];
  let samples = 0;
  let nights = 0;
  try {
    // Never interactive: only Settings › Connect Google shows the consent sheet. A grant revoked since then surfaces
    // as the google_needs_consent warning, which Settings turns into "Reconnect".
    const client = createGoogleClient({ token: opts.token ?? ((retry) => accessToken(false, retry)), fetch: opts.fetch, sleep: opts.sleep, now });
    const t = nowS();
    const today = localDay(t, tz);
    const st = await readGoogleSyncState();

    // A first import (or a cursor from before a type was added), or a window longer than the one already walked:
    // from the window's start. Otherwise from a few days before the cursor. A shorter setting removes nothing.
    const fresh = st.syncedThrough === null || st.version !== SYNC_VERSION;
    const grow = !fresh && st.backfillDays !== null && opts.historyDays > st.backfillDays && st.backfillDone >= st.backfillDays;
    const total = fresh || grow ? opts.historyDays : (st.backfillDays ?? opts.historyDays);
    const backfilling = fresh || grow || st.backfillDone < total;
    let done = fresh || grow ? 0 : st.backfillDone;
    let from: number;
    if (fresh || grow) {
      from = localMidnight(addDays(today, 1 - total), tz);
      await writeGoogleSyncState({ version: SYNC_VERSION, syncedThrough: null, backfillDays: total, backfillDone: 0, rangesError: null });
    } else if (backfilling) {
      from = st.syncedThrough!;
    } else {
      from = localMidnight(addDays(localDay(st.syncedThrough!, tz), -OVERLAP_DAYS), tz);
    }

    // The nightly rows ride along with the samples: a window whose nightly requests fail keeps its SpO2 and moves
    // the cursor on, and the run ends with that failure as its warning (so Settings shows it) but is not aborted.
    // A broken request for one type must not stall the other; a fix re-walks the window by bumping SYNC_VERSION.
    let nightsError: unknown;
    let ranges = (await readGoogleSyncState()).rangesError === null;
    const windows = localWindows(from, t, WINDOW_DAYS, tz);
    for (const [i, win] of windows.entries()) {
      progress("google", backfilling ? done : i, backfilling ? total : windows.length);
      samples += await spo2Window(client, store, win, tz);
      const n = await nightsWindow(client, store, win, tz, ranges);
      nights += n.nights;
      if (n.error) {
        const e = n.error;
        if (e instanceof GoogleAuthError || !(e instanceof GoogleError) || e.code === "auth_revoked" || e.code === "network") throw e;
        // A range roll-up Google refuses as such is not this run's failure: it is remembered, and not asked again.
        if (n.errorJob === "range" && (e.status === 400 || e.status === 404)) {
          ranges = false;
          await writeGoogleSyncState({ rangesError: e.message });
        } else nightsError ??= e;
      }
      if (backfilling) done = Math.min(total, done + daysIn(win, tz));
      await writeGoogleSyncState({ syncedThrough: win.end, ...(backfilling && { backfillDone: done }) });
    }
    await writeGoogleSyncState({ syncedThrough: t, ...(backfilling && { backfillDone: total }), lastSuccessAt: t, lastError: null });
    if (nightsError) throw nightsError;
  } catch (e) {
    const code = e instanceof GoogleAuthError ? (e.code === "NEEDS_CONSENT" || e.code === "CANCELLED" ? "needs_consent" : e.code.toLowerCase()) : e instanceof GoogleError ? e.code : "internal";
    warnings.push(code === "needs_consent" ? "google_needs_consent" : `google_error:${code}`);
    await writeGoogleSyncState({ lastError: e instanceof Error ? e.message : String(e) });
  }
  return { samples, nights, warnings };
}

/** Reads one window's points page by page and replaces the window's stored samples with them. */
async function spo2Window(client: GoogleClient, store: Store, win: { start: number; end: number }, tz: string): Promise<number> {
  const raw: unknown[] = [];
  await client.listEach("oxygen-saturation", win, tz, (points) => raw.push(...points));
  const samples: Spo2Sample[] = mapOxygenSaturation(raw);
  // Only when the window has readings, so an empty or unreadable answer never wipes a night (the server's guard).
  if (samples.length) await store.replaceSpo2(win.start, win.end, samples);
  return samples.length;
}

/**
 * One window's nightly rows: the daily HRV list (average and deep-sleep RMSSD) and the two personal-range roll-ups,
 * each written as it arrives and merged into google_daily by day, so a request that fails costs only its own rows.
 * Nothing is deleted: a night Google no longer answers for keeps its last values. Returns the nights touched and
 * the first failure, for the caller to weigh (a run is not aborted over a nightly request).
 */
async function nightsWindow(client: GoogleClient, store: Store, win: { start: number; end: number }, tz: string, ranges: boolean): Promise<{ nights: number; error?: unknown; errorJob?: "daily" | "range" }> {
  const days = new Set<string>();
  let error: unknown;
  let errorJob: "daily" | "range" | undefined;
  const put = async (rows: GoogleDaily[]) => {
    if (rows.length) await store.upsertGoogleDaily(rows);
    for (const r of rows) days.add(r.day);
  };
  const jobs: { kind: "daily" | "range"; run: () => Promise<void> }[] = [
    {
      kind: "daily",
      run: async () => {
        const daily: unknown[] = [];
        await client.listEach("daily-heart-rate-variability", win, tz, (points) => daily.push(...points));
        await put(mapDailyHrv(daily));
      },
    },
    ...(ranges ? (["daily-heart-rate-variability", "daily-resting-heart-rate"] as const).map((type) => ({ kind: "range" as const, run: async () => put(mapPersonalRange(type, await client.rollup(type, win, tz))) })) : []),
  ];
  for (const job of jobs) {
    try {
      await job.run();
    } catch (e) {
      if (error === undefined) {
        error = e;
        errorJob = job.kind;
      }
      if (e instanceof GoogleAuthError || !(e instanceof GoogleError) || e.code === "auth_revoked" || e.code === "network") break;
      if (job.kind === "range") break; // the other range asks the same of Google
    }
  }
  return { nights: days.size, error, errorJob };
}

/** Local days a window touches. */
const daysIn = (w: { start: number; end: number }, tz: string) => Math.round((Date.parse(localDay(w.end - 1, tz)) - Date.parse(localDay(w.start, tz))) / 86_400_000) + 1;
