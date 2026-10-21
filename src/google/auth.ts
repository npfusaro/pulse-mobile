// The Google Health API connection: whether the owner connected it, and an access token when a sync needs one.
// Fork addition (Pulse Mobile upstream is Health Connect only): the API is the only source of the band's
// minute-by-minute blood oxygen, which Fitbit never writes to Health Connect.
//
// No client id, secret or refresh token lives on the phone. Google Play services hands Pulse a short-lived access
// token (modules/pulse-google-auth) and Google matches the app to its Cloud project by package name and signing key;
// the owner registers both as an Android OAuth client there (docs/google-health.md). What is remembered is one flag.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GoogleAuthError } from "../../modules/pulse-google-auth/errors";

// Loaded on use, not on import: the binding imports `expo`, which the queries (and their Node tests) must not pull in.
const native = () => import("../../modules/pulse-google-auth");

/** Blood oxygen (and the other metrics and measurements) are read-only under this one scope. */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly"];

export const CONNECTED_KEY = "pulse.google.connected";

export type GoogleState = "unavailable" | "not_connected" | "connected";

/** Whether the owner has connected Google (the flag), or can't on this phone (no Google Play services). */
export async function googleState(): Promise<GoogleState> {
  if (!(await native()).isAvailable()) return "unavailable";
  return (await isGoogleConnected()) ? "connected" : "not_connected";
}

/** The flag alone (the sync and the queries): whether the owner connected Google on this phone. */
export async function isGoogleConnected(): Promise<boolean> {
  const v = await AsyncStorage.getItem(CONNECTED_KEY).catch(() => null);
  return v === "1";
}

/** Asks Google for the scopes (the consent sheet, the first time) and remembers the connection. */
export async function connectGoogle(): Promise<void> {
  await (await native()).authorize(GOOGLE_SCOPES, true);
  await AsyncStorage.setItem(CONNECTED_KEY, "1");
}

/**
 * Forgets the connection and asks Google to revoke the grant, so the next connect shows the consent sheet again.
 * The revoke is best effort: a phone offline still disconnects, and the grant can be removed at myaccount.google.com.
 */
export async function disconnectGoogle(fetchFn: typeof fetch = fetch): Promise<void> {
  await AsyncStorage.removeItem(CONNECTED_KEY).catch(() => {});
  try {
    const { accessToken } = await (await native()).authorize(GOOGLE_SCOPES, false);
    await fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, { method: "POST" });
  } catch {
    // Not granted, offline, or revoked already: nothing to revoke.
  }
}

/** The last token handed out, for `accessToken(…, true)` to invalidate once the API has rejected it. */
let lastToken: string | null = null;

/**
 * A fresh access token for a sync. `interactive` false (the background task) never shows a sheet: a missing grant
 * throws NEEDS_CONSENT, which the sync reports as a warning for Settings to show. `retry` true (the client, after a
 * 401) first drops the last token from Play services' cache, which otherwise hands the rejected token back again.
 */
export async function accessToken(interactive: boolean, retry = false): Promise<string> {
  const n = await native();
  if (retry && lastToken) await n.invalidate(lastToken);
  lastToken = (await n.authorize(GOOGLE_SCOPES, interactive)).accessToken;
  return lastToken;
}

export { GoogleAuthError };
