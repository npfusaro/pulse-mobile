# Blood oxygen from the Google Health API

This fork adds a second source beside Health Connect: the Google Health API, for the one thing Health Connect never
gets from Fitbit, the band's **minute-by-minute blood oxygen (SpO2)**. Fitbit's own app shows a nightly average;
Google's cloud keeps every minute the band read (you can see them in a Google Takeout), and the API serves them as
the `oxygen-saturation` sample type. Pulse reads only that type under one read-only scope. Nothing about the Google
account is kept on the phone: no email, no name, no token.

```mermaid
flowchart LR
  B[Fitbit Air] --> G[Google Health app]
  G --> HC[Health Connect] --> P[Pulse: everything else]
  G --> C[Google cloud] -- Google Health API, oxygen-saturation --> P2[Pulse: spo2_days]
  P2 --> S[/health/blood-oxygen]
```

## What it takes

Google lets an Android app get an access token for an API only through Google Play services
(`Identity.getAuthorizationClient`); the browser flow with a custom-scheme redirect is no longer accepted for Android
OAuth clients. Play services matches the app to a Google Cloud project by its **package name and signing key**, so the
app carries no client id, and the build you install must be one whose signing key you registered. That means you build
the APK yourself (below), and register that build's key with Google once.

The native part is the local Expo module `modules/pulse-google-auth` (Kotlin, `play-services-auth`). The TypeScript
side is `src/google`: `auth.ts` (the connection flag and tokens), `client.ts` (requests, pacing, retries),
`map.ts` (points to samples), `sync.ts` (the history window, the cursor, resume). The samples live in `spo2_days`
(`src/data`), shaped like `hr_days`. The screen is `src/screens/health/BloodOxygenScreen.tsx` with
`src/ui/charts/NightSpo2Chart.tsx`; the view model is `src/queries/bloodOxygen.ts`.

## 1. Build the app

Needs Node 24, pnpm, JDK 17 and Android Studio with SDK platform 36 (the build downloads the rest).

```sh
git clone https://github.com/npfusaro/pulse-mobile.git && cd pulse-mobile
git checkout feat/google-health-spo2
pnpm install
npx expo run:android --variant release    # phone plugged in with USB debugging, or an emulator
```

`expo run:android` generates `android/` (never edit it), builds, signs with the **debug keystore**
(`~/.android/debug.keystore`, which Android Studio creates) and installs. The release variant is a normal standalone
APK; the debug keystore only means Google Play would not accept it, which does not matter for a sideload. The APK
is also at `android/app/build/outputs/apk/release/app-release.apk` for installing on another phone.

If the upstream release of Pulse Mobile is installed, uninstall it first: it has the same package name
(`in.portlabs.pulse`) under a different signing key, and Android refuses to install over it. The import rebuilds the
local data from Health Connect in a few minutes.

## 2. Register the build with Google

In the [Google Cloud Console](https://console.cloud.google.com/), signed in as the Google account your Fitbit uses:

1. Create a project (any name, e.g. "Pulse").
2. **APIs & Services › Enable APIs and Services** → search **Google Health API** → Enable.
3. **Google Auth Platform › Branding**: user type **External**, an app name, your email.
4. **Google Auth Platform › Data access** → Add scopes → paste
   `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` → Update, Save.
5. **Google Auth Platform › Audience** → add yourself as a test user, then **Publish** the app (In production).
   While it stays in Testing, Google drops the grant every 7 days and Pulse asks you to reconnect. Published, Google
   shows an "unverified app" screen once when you connect; click through ("Advanced" › continue), it is your own app.
6. **Clients › Create client** → Application type **Android**:
   - Package name: `in.portlabs.pulse` (or what you set in `app.json`'s `expo.android.package`).
   - SHA-1 certificate fingerprint: the keystore that signed your build. For the debug keystore:

     ```sh
     keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA1
     ```

   Create. No client id or secret goes anywhere; the registration is the whole point.

Changes in the console take a few minutes to apply.

## 3. Connect in Pulse

Settings › Data source › **Google Health** → **Connect Google**. Google's sheet asks for the blood-oxygen scope; the
next sync imports the history window (Settings › Data source › **History**, 180 days unless you change it) in
14-day windows, a night at a time, and every sync after that re-reads the last three days. The Health tab gets a
Blood oxygen card, which opens the night: the average with its standing against 95–100, the low, minutes under 95%,
the minute chart with bed and wake markers, and the week's nights.

**Disconnect** forgets the connection, asks Google to revoke the grant and drops the samples. The grant is also
listed at myaccount.google.com › Security › Third-party access.

## History

Settings › Data source › **History** sets how far back both sources import (was a constant 180). Neither source
caps it, once Health Connect's past-data permission is granted; Health Connect holds only what the Google Health app
wrote into it, so a longer window brings more from Health Connect only when that reaches further back (check in the
Health Connect app: Data and access › Heart rate › earliest entry). The Google source reads whatever Google holds.
Raising it re-reads Health Connect's whole window and walks the Google import from the new start; lowering it
removes nothing.

## When it doesn't connect

| Toast | Cause |
|---|---|
| Google doesn't know this build (`API_10`, DEVELOPER_ERROR) | The package name or SHA-1 registered as the Android client doesn't match the installed build, the Google Health API isn't enabled, or the change hasn't propagated yet. |
| Google's consent screen was closed | You backed out of the sheet. |
| Needs Google Play services | A phone without Play services (some Huawei models, custom ROMs without GApps). |
| Access needed (after it worked) | The grant was revoked, or the app is still in Testing and the 7 days passed. Reconnect. |

The last sync's error is in the Google Health block in Settings. No health data or token is ever logged.
