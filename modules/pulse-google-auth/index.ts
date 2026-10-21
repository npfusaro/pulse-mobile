// Pulse's native Google authorization (android/…/PulseGoogleAuthModule.kt): an OAuth access token for the Google
// Health API from Google Play services, with the consent sheet the first time. Safe to import anywhere: without the
// native module (tests, a build without it) `isAvailable()` is false and `authorize()` rejects with UNAVAILABLE.
import { requireOptionalNativeModule } from "expo";
import { GoogleAuthError } from "./errors";

type Native = {
  isAvailable(): boolean;
  authorize(scopes: string[], interactive: boolean): Promise<{ accessToken: string | null; grantedScopes: string[] }>;
  invalidate(token: string): Promise<void>;
};
const native = requireOptionalNativeModule<Native>("PulseGoogleAuth");

export type Authorization = { accessToken: string; grantedScopes: string[] };

export { GoogleAuthError, type AuthErrorCode } from "./errors";

/** Whether Google Play services is on this phone (the API needs it). */
export function isAvailable(): boolean {
  try {
    return native?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

/**
 * A fresh access token for `scopes`. `interactive` false never shows Google's sheet (a background sync): it throws
 * NEEDS_CONSENT when the owner has not granted the scopes yet, or granted fewer than asked.
 */
export async function authorize(scopes: string[], interactive: boolean): Promise<Authorization> {
  if (!native) throw new GoogleAuthError("UNAVAILABLE", "Google Play services is not available in this build");
  let r: { accessToken: string | null; grantedScopes: string[] };
  try {
    r = await native.authorize(scopes, interactive);
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "AUTHORIZE_FAILED";
    throw new GoogleAuthError(code, (e as Error)?.message ?? "Google authorization failed");
  }
  if (!r.accessToken) throw new GoogleAuthError("AUTHORIZE_FAILED", "Google returned no access token");
  const granted = new Set(r.grantedScopes ?? []);
  const missing = scopes.filter((s) => !granted.has(s));
  if (missing.length) throw new GoogleAuthError("NEEDS_CONSENT", `Google did not grant: ${missing.join(", ")}`);
  return { accessToken: r.accessToken, grantedScopes: r.grantedScopes ?? [] };
}

/**
 * Drops a token from Play services' cache, so the next `authorize` fetches a fresh one. For a token the API has
 * rejected (401): without this, `authorize` keeps returning the rejected token. Never throws.
 */
export async function invalidate(token: string): Promise<void> {
  try {
    await native?.invalidate(token);
  } catch {
    // The cache is best effort: a fresh authorize is tried either way.
  }
}
