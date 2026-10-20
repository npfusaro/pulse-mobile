// The error the native binding throws, in its own file with no native import so src/google (and the queries that
// reach it) load in Node for tests.

/** Error codes the native side rejects with; anything else is a Google API status (`API_<code>`) or a plain failure. */
export type AuthErrorCode = "UNAVAILABLE" | "NEEDS_CONSENT" | "CANCELLED" | "BUSY" | "NO_CONTEXT" | "CONSENT_FAILED" | "AUTHORIZE_FAILED";

export class GoogleAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}
