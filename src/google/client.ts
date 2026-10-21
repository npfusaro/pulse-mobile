// Google Health API v4 reads for the phone: local-day windows, pagination, a 4 req/s limiter and retries, after
// the server app's src/server/sources/google/client.ts (same code, same license), without its raw archive. Errors
// carry a code and status only, never a token or a body.
import { addDays, localDay, localMidnight } from "@/lib/time";

const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const MIN_GAP_MS = 250; // 4 req/s, under the documented 5 QPS per user
const MAX_TRIES = 5; // per request, for 429, 5xx and network failures
const BACKOFF_MS = 1000;
/** Longest Retry-After waited out inside a run; a longer one fails the run now and the next sync tries again. */
const MAX_WAIT_MS = 60_000;
const MAX_PAGES = 1000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * The types Pulse Mobile reads from Google: `member` is the filterable time field (a sample's instant in UTC, or a
 * daily type's civil `date`), `maxDays` the longest window one request may cover. Every one is walked in the same
 * 14-day windows (src/google/sync.ts), so a daily type's longer limit goes unused.
 */
export const DATA_TYPES = {
  // The band's minute-by-minute SpO2 (asleep only, unreliable minutes left out): one point a minute, so a night is a
  // few hundred points and a 14-day window stays well under one page.
  "oxygen-saturation": { member: "sample_time.physical_time", maxDays: 14, pageSize: 10_000 },
  // One point a night: Fitbit's average RMSSD and its deep-sleep RMSSD. Its dailyRollUp answers with the personal
  // range instead (heartRateVariabilityPersonalRange), the band of nights Fitbit calls typical as of each day.
  "daily-heart-rate-variability": { member: "date", maxDays: 90, pageSize: 10_000 },
  // Listed for nothing yet; its dailyRollUp is the resting-HR personal range (restingHeartRatePersonalRange).
  "daily-resting-heart-rate": { member: "date", maxDays: 90, pageSize: 10_000 },
  // One point a night: Fitbit's nightly SpO2 average with its bounds, the "Daily SpO2" of a Takeout, on the wake day.
  "daily-oxygen-saturation": { member: "date", maxDays: 90, pageSize: 10_000 },
} as const;
export type DataTypeId = keyof typeof DATA_TYPES;

/**
 * The personal ranges Pulse reads through `:dailyRollUp`, keyed by the daily type they belong to: the roll-up type
 * identifier that goes in the request path (the daily type itself answers "DailyRollup is not supported", as
 * `floors` and `active-minutes` are roll-up-only names of their own), and the key the value sits under in each
 * rolled-up point.
 */
export const ROLLUP = {
  "daily-heart-rate-variability": { path: "heart-rate-variability-personal-range", key: "heartRateVariabilityPersonalRange" },
  "daily-resting-heart-rate": { path: "resting-heart-rate-personal-range", key: "restingHeartRatePersonalRange" },
} as const;
export type RollupTypeId = keyof typeof ROLLUP;

export class GoogleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
    readonly where: string,
    /** Google's own sentence, kept only for a 400: it names the bad request field, never a reading. */
    readonly detail?: string,
  ) {
    super(`[google] ${where}: ${code}${status ? ` (HTTP ${status})` : ""}${detail ? ` — ${detail}` : ""}`);
    this.name = "GoogleError";
  }
}

export type TimeWindow = { start: number; end: number };

/** Splits [from, to) at local midnights into windows of at most `maxDays` local days, with no gap or overlap. */
export function localWindows(from: number, to: number, maxDays: number, tz: string): TimeWindow[] {
  const out: TimeWindow[] = [];
  let day = localDay(from, tz);
  for (let start = from; start < to; ) {
    day = addDays(day, maxDays);
    const end = Math.min(to, localMidnight(day, tz));
    if (end <= start) continue; // only in a zone whose midnight falls in a DST gap
    out.push({ start, end });
    start = end;
  }
  return out;
}

/**
 * `<snake_type>.<member> >= X AND <snake_type>.<member> < Y`: instants in RFC 3339 UTC; a daily type's `date` as the
 * window's local days, the end rounded up to a whole day (a window ends at local midnight, so `< end day` excludes
 * exactly the days after it).
 */
export function buildFilter(type: DataTypeId, w: TimeWindow, tz: string): string {
  const field = `${type.replaceAll("-", "_")}.${DATA_TYPES[type].member}`;
  const [lo, hi] = DATA_TYPES[type].member === "date" ? [localDay(w.start, tz), localDay(ceilMidnight(w.end, tz), tz)] : [w.start, w.end].map((s) => new Date(s * 1000).toISOString());
  return `${field} >= "${lo}" AND ${field} < "${hi}"`;
}

/** `s` if it is a local midnight, else the next one. */
const ceilMidnight = (s: number, tz: string) => {
  const day = localDay(s, tz);
  return localMidnight(day, tz) === s ? s : localMidnight(addDays(day, 1), tz);
};

/** A `CivilDateTime` of a local day's midnight, as the dailyRollUp range wants it. */
const civilDate = (day: string) => {
  const [year, month, d] = day.split("-").map(Number);
  return { date: { year, month, day: d } };
};

export type ClientDeps = {
  /** A fresh access token; called again after a 401 (`retry` true) before the request is given up as revoked. */
  token: (retry: boolean) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds. */
  now?: () => number;
  maxTries?: number;
};

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** `error.status` ("INVALID_ARGUMENT") from Google's error body, when it has one. */
const errorCode = (j: unknown): string | undefined => {
  const e = (j as { error?: { status?: unknown } } | undefined)?.error;
  return e && typeof e.status === "string" && e.status ? e.status : undefined;
};

/** `error.message` from a 400's body, trimmed: what Google found wrong with the request (a field, a value). */
const errorDetail = (j: unknown): string | undefined => {
  const m = (j as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === "string" && m ? m.replace(/\s+/g, " ").slice(0, 200) : undefined;
};

export function createGoogleClient({ token, fetch: fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxTries = MAX_TRIES }: ClientDeps) {
  let nextSlot = 0;
  async function throttle() {
    const t = now();
    const wait = Math.max(0, nextSlot - t);
    nextSlot = Math.max(t, nextSlot) + MIN_GAP_MS;
    if (wait) await sleep(wait);
  }

  function retryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined;
    const ms = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - now();
    return Number.isNaN(ms) ? undefined : ms;
  }

  /** The 200 body. One fresh token on 401, then `auth_revoked`; 429 waits Retry-After; 5xx and network back off. */
  async function request(url: string, where: string, body?: string): Promise<string> {
    let tries = 0;
    let refreshed = false;
    for (;;) {
      const bearer = await token(refreshed);
      await throttle();
      let res: Response;
      try {
        res = await fetchFn(url, {
          ...(body !== undefined && { method: "POST", body }),
          headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined && { "content-type": "application/json" }) },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) return await res.text();
      } catch {
        if (++tries >= maxTries) throw new GoogleError("network", undefined, where);
        await sleep(BACKOFF_MS * 2 ** (tries - 1));
        continue;
      }
      const { status } = res;
      if (status === 401) {
        if (refreshed) throw new GoogleError("auth_revoked", status, where);
        refreshed = true;
        continue;
      }
      if ((status === 429 || status >= 500) && ++tries < maxTries) {
        const after = status === 429 ? retryAfterMs(res.headers.get("retry-after")) : undefined;
        if (after !== undefined && after > MAX_WAIT_MS) throw new GoogleError(errorCode(parseJson(await res.text())) ?? "http_429", status, where);
        await sleep(Math.min(MAX_WAIT_MS, Math.max(0, after ?? BACKOFF_MS * 2 ** (tries - 1))));
        continue;
      }
      const j = parseJson(await res.text());
      throw new GoogleError(errorCode(j) ?? `http_${status}`, status, where, status === 400 ? errorDetail(j) : undefined);
    }
  }

  /** Parses a 200 body; one that is not the expected envelope is an error, never "no data". */
  function readPage(body: string, key: "dataPoints" | "rollupDataPoints", where: string): { points: unknown[]; next?: string } {
    const j = parseJson(body);
    if (typeof j !== "object" || j === null) throw new GoogleError("bad_response", 200, where);
    const { [key]: pts = [], nextPageToken: next } = j as Record<string, unknown>;
    if (!Array.isArray(pts)) throw new GoogleError("bad_response", 200, where);
    return { points: pts, next: typeof next === "string" && next ? next : undefined };
  }

  return {
    /** Every data point of `type` in [start, end) (one window of at most `maxDays`), one page at a time to `onPage`. */
    async listEach(type: DataTypeId, w: TimeWindow, tz: string, onPage: (points: unknown[]) => void): Promise<void> {
      const t = DATA_TYPES[type];
      const filter = buildFilter(type, w, tz);
      let pageToken: string | undefined;
      let pages = 0;
      do {
        if (++pages > MAX_PAGES) throw new GoogleError("too_many_pages", undefined, type);
        const q = new URLSearchParams({ filter, pageSize: String(t.pageSize), ...(pageToken && { pageToken }) });
        const page = readPage(await request(`${API}/${type}/dataPoints?${q}`, type), "dataPoints", type);
        onPage(page.points);
        pageToken = page.next;
      } while (pageToken);
    },
    /**
     * `type`'s daily roll-up over the window's local days (one point a day, at most `maxDays`): what the API has
     * for the day's personal range. The window's edges must be local midnights, as sync's windows are. The body is
     * the range alone, as the server app sends it: the reference's page fields are not accepted by the live API
     * (INVALID_ARGUMENT), and a window of days fits one answer anyway.
     */
    async rollup(type: RollupTypeId, w: TimeWindow, tz: string): Promise<unknown[]> {
      const { path } = ROLLUP[type];
      const where = `${path} dailyRollUp`;
      const range = { start: civilDate(localDay(w.start, tz)), end: civilDate(localDay(ceilMidnight(w.end, tz), tz)) };
      return readPage(await request(`${API}/${path}/dataPoints:dailyRollUp`, where, JSON.stringify({ range })), "rollupDataPoints", where).points;
    },
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
