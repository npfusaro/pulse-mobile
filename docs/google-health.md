# Blood oxygen and night HRV from the Google Health API

This fork adds a second source beside Health Connect: the Google Health API, for what Health Connect never gets from
Fitbit. First the band's **minute-by-minute blood oxygen (SpO2)**: Fitbit's own app shows a nightly average; Google's
cloud keeps every minute the band read (you can see them in a Google Takeout), and the API serves them as the
`oxygen-saturation` sample type. Then, per night, Fitbit's **deep-sleep RMSSD** and its **personal ranges** for HRV
and resting heart rate (`daily-heart-rate-variability` and the two types' `:dailyRollUp`). All of it sits under one
read-only scope. Nothing about the Google account is kept on the phone: no email, no name, no token.

The five-minute HRV samples themselves are *not* read from the API: Fitbit writes those to Health Connect, Pulse
already stores them (`hrv_days`) and the engine scores with them. The Night HRV screen draws that series and adds
what Google has: the deep-sleep value and the range.

```mermaid
flowchart LR
  B[Fitbit band / Pixel Watch] --> G[Google Health app]
  G --> HC[Health Connect] --> P[Pulse: everything else, incl. 5-minute HRV]
  G --> C[Google cloud] -- oxygen-saturation --> P2[Pulse: spo2_days]
  C -- daily HRV, personal ranges --> P3[Pulse: google_daily]
  P2 --> S[/health/blood-oxygen]
  P3 --> S2[/health/night-hrv and the Health Monitor]
```

## What it takes

Google lets an Android app get an access token for an API only through Google Play services
(`Identity.getAuthorizationClient`); the browser flow with a custom-scheme redirect is no longer accepted for Android
OAuth clients. Play services matches the app to a Google Cloud project by its **package name and signing key**, so the
app carries no client id, and the build you install must be one whose signing key you registered. That means you build
the APK yourself (below), and register that build's key with Google once.

The native part is the local Expo module `modules/pulse-google-auth` (Kotlin, `play-services-auth`). The TypeScript
side is `src/google`: `auth.ts` (the connection flag and tokens), `client.ts` (requests, pacing, retries, the list
and `:dailyRollUp` calls), `map.ts` (points to rows), `sync.ts` (the history window, the cursor, resume; every type
walks the same 14-day windows, and a bump of `SYNC_VERSION` re-walks the window so a newly read type is backfilled).
The SpO2 samples live in `spo2_days` (`src/data`), shaped like `hr_days`; the nightly rows in `google_daily`, which
the store folds into each day's `Metrics` in `allMetrics` (`src/data/googleDaily.ts`), so the Health Monitor picks
up the ranges without the Health Connect importer ever overwriting them. The screens are
`src/screens/health/BloodOxygenScreen.tsx` (`src/ui/charts/NightSpo2Chart.tsx`, `src/queries/bloodOxygen.ts`) and
`src/screens/health/NightHrvScreen.tsx` (`src/ui/charts/NightHrvChart.tsx`, `src/queries/nightHrv.ts`).

## 1. Build the app

Needs Node 24, pnpm, JDK 17 and Android Studio with SDK platform 36 (the build downloads the rest).

```sh
git clone https://github.com/npfusaro/pulse-mobile.git && cd pulse-mobile
git checkout feat/google-health-spo2
pnpm install
npx expo run:android --variant release    # phone plugged in with USB debugging, or an emulator
```

`expo run:android` generates `android/` (never edit it), builds, signs with the **debug keystore Expo generates
into the project**, `android/app/debug.keystore` (not Android Studio's `~/.android/debug.keystore`: a different
key), and installs. The release variant is a normal standalone APK; the debug keystore only means Google Play
would not accept it, which does not matter for a sideload. The APK is also at
`android/app/build/outputs/apk/release/app-release.apk` for installing on another phone.

On Windows: pnpm's symlinked `node_modules` makes the native build loop (`ninja: manifest 'build.ninja' still
dirty`), so add `nodeLinker: hoisted` to `pnpm-workspace.yaml` before `pnpm install`; keep the checkout at a short
path (`C:\pm`); build one architecture (`$env:ORG_GRADLE_PROJECT_reactNativeArchitectures = "arm64-v8a"`); and
run Gradle directly when the device picker gets in the way: `npx expo prebuild --platform android`, then
`android\gradlew.bat app:assembleRelease` and `adb install -r` the APK.

### Or let GitHub build it

`.github/workflows/apk.yml` builds the same arm64 release APK on GitHub's runners, signed with the same debug
keystore, so the SHA-1 registered with Google stays valid and the download installs over a local build. Every push
to the fork's branch (and **Actions › APK › Run workflow**) leaves the APK as a workflow artifact; pushing a tag
publishes a Release with the APK attached, which a phone's browser can download straight into the installer:

```sh
git tag v0.1.0-google && git push origin v0.1.0-google
```

A fork starts with Actions switched off: open the fork's **Actions** tab once and enable workflows. The build takes
about 15–25 minutes (the native modules compile from source every time; the Gradle cache shortens the rest).

If the upstream release of Pulse Mobile is installed, uninstall it first: it has the same package name
(`in.portlabs.pulse`) under a different signing key, and Android refuses to install over it. The import rebuilds the
local data from Health Connect in a few minutes.

## 2. Register the build with Google

In the [Google Cloud Console](https://console.cloud.google.com/), signed in as the Google account your Fitbit uses:

1. Create a project (any name, e.g. "Pulse").
2. **APIs & Services › Enable APIs and Services** → search **Google Health API** → Enable.
3. **Google Auth Platform › Branding**: user type **External** (not Internal, even when the console offers it: Internal
   admits only members of a Workspace organization, and a personal Fitbit account isn't one), an app name, your email.
4. **Google Auth Platform › Data access** → Add scopes → paste
   `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` → Update, Save.
5. **Google Auth Platform › Audience** → add yourself as a test user, then **Publish** the app (In production).
   While it stays in Testing, Google drops the grant every 7 days and Pulse asks you to reconnect. Published, Google
   shows an "unverified app" screen once when you connect; click through ("Advanced" › continue), it is your own app.
6. **Clients › Create client** → Application type **Android**:
   - Package name: `in.portlabs.pulse` (or what you set in `app.json`'s `expo.android.package`).
   - SHA-1 certificate fingerprint: the keystore that signed your build, which for `expo run:android` is the
     one Expo generated into the project:

     ```sh
     keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android | grep SHA1
     ```

     (`keytool` is in Android Studio's `jbr/bin` when it is not on the PATH.) A mismatch here is what makes
     Google's consent sheet open and close itself.

   Create. No client id or secret goes anywhere; the registration is the whole point.

Changes in the console take a few minutes to apply.

## 3. Connect in Pulse

Settings › Data source › **Google Health** → **Connect Google**. Google's sheet asks for the health-metrics scope; the
next sync imports the history window (Settings › Data source › **History**, 180 days unless you change it) in
14-day windows, a night at a time, and every sync after that re-reads the last three days. The Health tab gets two
cards. **Blood oxygen** opens the night: the average with its standing against 95–100, the low, minutes under 95%,
the minute chart with bed and wake markers, and the week's nights. **Night HRV** opens the night's five-minute
RMSSD curve with deep sleep lit and Fitbit's typical range as a band, the average with where it sits in that range,
the deep-sleep RMSSD, the high, and the week's nights. The **Health Monitor** judges HRV and resting heart rate
against Fitbit's ranges from then on (a vital without one keeps Pulse's own).

**Disconnect** forgets the connection, asks Google to revoke the grant and drops the samples and the nightly rows.
The grant is also listed at myaccount.google.com › Security › Third-party access.

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
| Google's consent screen was closed | You backed out of the sheet. If it closed itself right after you picked an account, Google rejected that account and Play services reports only "cancelled": with `adb logcat` showing `This client is restricted to users within its organization`, the audience is **Internal** and the Fitbit account isn't in that organization. Audience › Make external, add the account as a test user (or publish). |
| Needs Google Play services | A phone without Play services (some Huawei models, custom ROMs without GApps). |
| Access needed (after it worked) | The grant was revoked, or the app is still in Testing and the 7 days passed. Reconnect. |
| Failed (auth_revoked) | Google answered 401 to a token Play services still hands out: it stops accepting a token when the consent screen it came from changes (scopes added, the audience or publishing status switched) or when a cached token outlived its hour. Not a scope problem (a missing scope is PERMISSION_DENIED). The sync clears the cached token and retries by itself; if it still fails, Disconnect and Connect Google again. |

The last sync's error is in the Google Health block in Settings. No health data or token is ever logged.
