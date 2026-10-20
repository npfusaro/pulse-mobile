package app.pulse.googleauth

import android.app.Activity
import android.content.Context
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * An OAuth access token for the Google Health API, through Google Play services' AuthorizationClient: the one way
 * Google still supports for an Android app (custom-scheme redirects for Android OAuth clients are gone). The phone
 * never holds a refresh token: each call returns a fresh short-lived access token, silently once the owner has
 * granted the scopes, and through Google's consent sheet the first time (or after a revoke). Google matches the app
 * to its Cloud project by package name and signing key, so no client id lives in the app.
 */
class PulseGoogleAuthModule : Module() {
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("PulseGoogleAuth")

    /** Whether Google Play services is on this phone at all (the API needs it). */
    Function("isAvailable") {
      val ctx = appContext.reactContext ?: return@Function false
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS
    }

    /**
     * Resolves { accessToken, grantedScopes } for `scopes`. `interactive` false (a background sync) never shows a
     * sheet: it rejects with NEEDS_CONSENT when the grant is missing, for the app to ask next time it is open.
     */
    AsyncFunction("authorize") { scopes: List<String>, interactive: Boolean, promise: Promise ->
      val ctx: Context = appContext.reactContext ?: run {
        promise.reject("NO_CONTEXT", "The app context is gone", null)
        return@AsyncFunction
      }
      if (pending != null) {
        promise.reject("BUSY", "A Google authorization is already in progress", null)
        return@AsyncFunction
      }
      val request = AuthorizationRequest.builder().setRequestedScopes(scopes.map { Scope(it) }).build()
      Identity.getAuthorizationClient(ctx)
        .authorize(request)
        .addOnSuccessListener { result ->
          if (!result.hasResolution()) {
            promise.resolve(payload(result))
            return@addOnSuccessListener
          }
          val activity: Activity? = appContext.currentActivity
          val intent = result.pendingIntent
          if (!interactive || activity == null || intent == null) {
            promise.reject("NEEDS_CONSENT", "Google needs the owner to grant access; open Pulse and connect Google", null)
            return@addOnSuccessListener
          }
          try {
            pending = promise
            activity.startIntentSenderForResult(intent.intentSender, REQUEST_CODE, null, 0, 0, 0)
          } catch (e: Exception) {
            pending = null
            promise.reject("CONSENT_FAILED", e.localizedMessage ?: "Could not open Google's consent screen", e)
          }
        }
        .addOnFailureListener { e ->
          val status = (e as? ApiException)?.statusCode
          promise.reject(if (status != null) "API_$status" else "AUTHORIZE_FAILED", e.localizedMessage ?: "Google authorization failed", e)
        }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null
      val data = payload.data
      if (payload.resultCode != Activity.RESULT_OK || data == null) {
        promise.reject("CANCELLED", "The owner closed Google's consent screen", null)
        return@OnActivityResult
      }
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.reject("NO_CONTEXT", "The app context is gone", null)
        return@OnActivityResult
      }
      try {
        promise.resolve(payload(Identity.getAuthorizationClient(ctx).getAuthorizationResultFromIntent(data)))
      } catch (e: ApiException) {
        promise.reject("API_${e.statusCode}", e.localizedMessage ?: "Google authorization failed", e)
      } catch (e: Exception) {
        promise.reject("AUTHORIZE_FAILED", e.localizedMessage ?: "Google authorization failed", e)
      }
    }
  }

  private fun payload(result: AuthorizationResult): Map<String, Any?> =
    mapOf("accessToken" to result.accessToken, "grantedScopes" to result.grantedScopes)

  companion object {
    private const val REQUEST_CODE = 0x6A41 // "jA": arbitrary, unused elsewhere in the app
  }
}
