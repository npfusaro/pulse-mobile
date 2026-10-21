#!/usr/bin/env node
// Probes the live Google Health API for what it actually serves an account, where the reference and the API
// disagree (fork tool; docs/google-health.md). Runs on your own machine with a "Desktop app" OAuth client: the consent
// happens in your browser, the token stays in this process, and the report it writes holds no readings — only each
// request's status, Google's error wording, the keys and value types of what came back, counts, and the spacing
// between samples. That file is safe to hand to whoever is debugging the integration.
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-probe.mjs [report.json]
//
// Windows (PowerShell):  $env:GOOGLE_CLIENT_ID = "..."; $env:GOOGLE_CLIENT_SECRET = "..."; node scripts/google-probe.mjs
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SCOPES = (
  process.env.GOOGLE_SCOPES ??
  "activity_and_fitness.readonly health_metrics_and_measurements.readonly sleep.readonly ecg.readonly irn.readonly location.readonly"
)
  .split(/\s+/)
  .filter(Boolean)
  .map((s) => `https://www.googleapis.com/auth/googlehealth.${s}`);
const OUT = process.argv[2] ?? "google-probe-report.json";
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Desktop app OAuth client in the Cloud project with the Google Health API enabled).");
  process.exit(2);
}

// ── Consent in the browser, the code caught on localhost ────────────────────────────────────────────────────────
async function getToken() {
  const state = randomBytes(12).toString("hex");
  let redirect = "";
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/cb") {
        res.statusCode = 404;
        return void res.end();
      }
      res.setHeader("content-type", "text/html");
      const got = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !got) {
        res.end("<p>Something went wrong; close this tab and look at the terminal.</p>");
        reject(new Error(`consent failed: ${url.searchParams.get("error") ?? "no code"}`));
      } else {
        res.end("<p>Done. You can close this tab; the probe is running in the terminal.</p>");
        resolve(got);
      }
      server.close();
    });
    server.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${server.address().port}/cb`;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), access_type: "online", prompt: "consent", state }).toString();
      console.log(`\nOpen this in the browser signed in as the Fitbit account (it should open by itself):\n\n${auth}\n`);
      const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", auth.toString().replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [auth.toString()]] : ["xdg-open", [auth.toString()]];
      try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
      } catch {
        // The URL is printed; opening it by hand works too.
      }
    });
  });
  const body = new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code" });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  console.log(`Token granted for: ${j.scope}\n`);
  return j.access_token;
}

// ── Shapes, never values ─────────────────────────────────────────────────────────────────────────────────────────
/** Keys whose string values are categories, not readings; every other string, number and time is reduced to its type. */
const KEEP = new Set(["platform", "recordingMethod", "exerciseType", "type", "stagesStatus", "resultClassification", "splitType", "calculationMethod", "heartRateZone", "activityLevel", "mealType", "sensorLocation", "motionContext", "status"]);
function shape(v, key = "", depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [`${v.length} items`, shape(v[0], key, depth + 1)] : "[]";
  if (typeof v === "object") {
    if (depth > 6) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k, depth + 1)]));
  }
  if (typeof v === "string") return KEEP.has(key) ? `"${v}"` : /^\d{4}-\d\d-\d\dT/.test(v) ? "timestamp" : /^-?\d+(\.\d+)?s$/.test(v) ? "duration" : /^-?\d+$/.test(v) ? "int64 string" : "string";
  return typeof v;
}

/** Seconds between the first few points' sample times, for sample types: how fine the series is. */
function spacing(points) {
  const times = points
    .map((p) => {
      const body = Object.values(p).find((x) => x && typeof x === "object" && !Array.isArray(x) && (x.sampleTime || x.interval));
      return body?.sampleTime?.physicalTime ?? body?.interval?.startTime;
    })
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => Date.parse(t) / 1000);
  return times.slice(1).map((t, i) => Math.round(t - times[i]));
}

// ── The requests ─────────────────────────────────────────────────────────────────────────────────────────────────
const day = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const ago = (days) => new Date(now.getTime() - days * 86_400_000);
const civil = (d) => ({ date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } });
const physical = (type, member, from, to) => `${type.replaceAll("-", "_")}.${member} >= "${from.toISOString()}" AND ${type.replaceAll("-", "_")}.${member} < "${to.toISOString()}"`;
const dated = (type, from, to) => `${type.replaceAll("-", "_")}.date >= "${day(from)}" AND ${type.replaceAll("-", "_")}.date < "${day(to)}"`;
const list = (type, filter, pageSize = 50) => ({ name: `${type} list`, method: "GET", url: `${API}/${type}/dataPoints?${new URLSearchParams({ filter, pageSize: String(pageSize) })}` });
const daily = (type, body) => ({ name: `${type} dailyRollUp`, method: "POST", url: `${API}/${type}/dataPoints:dailyRollUp`, body: body ?? { range: { start: civil(ago(14)), end: civil(ago(0)) } } });
const rollUp = (type) => ({ name: `${type} rollUp`, method: "POST", url: `${API}/${type}/dataPoints:rollUp`, body: { range: { startTime: ago(14).toISOString(), endTime: now.toISOString() }, windowSize: "86400s" } });
const reconcile = (type, filter) => ({ name: `${type} reconcile`, method: "GET", url: `${API}/${type}/dataPoints:reconcile?${new URLSearchParams({ ...(filter && { filter }), pageSize: "25" })}` });

const PROBES = [
  // What the nightly types carry, and whether the personal ranges can be had anywhere.
  list("daily-heart-rate-variability", dated("daily-heart-rate-variability", ago(14), ago(0))),
  list("daily-resting-heart-rate", dated("daily-resting-heart-rate", ago(14), ago(0))),
  daily("daily-heart-rate-variability"),
  daily("daily-resting-heart-rate"),
  daily("heart-rate-variability-personal-range"),
  daily("resting-heart-rate-personal-range"),
  daily("heart-rate-variability"),
  daily("heart-rate"),
  rollUp("daily-heart-rate-variability"),
  rollUp("heart-rate-variability"),
  reconcile("daily-heart-rate-variability", dated("daily-heart-rate-variability", ago(14), ago(0))),
  reconcile("daily-resting-heart-rate", dated("daily-resting-heart-rate", ago(14), ago(0))),
  // The sample series: how fine, and what metadata rides along (LF/HF on HRV).
  list("heart-rate-variability", physical("heart-rate-variability", "sample_time.physical_time", ago(2), ago(0)), 300),
  list("heart-rate", physical("heart-rate", "sample_time.physical_time", ago(1), ago(0)), 300),
  list("oxygen-saturation", physical("oxygen-saturation", "sample_time.physical_time", ago(2), ago(0)), 20),
  // Breathing, temperature, VO2 max.
  list("daily-respiratory-rate", dated("daily-respiratory-rate", ago(14), ago(0))),
  list("respiratory-rate-sleep-summary", physical("respiratory-rate-sleep-summary", "sample_time.physical_time", ago(14), ago(0))),
  list("daily-sleep-temperature-derivations", dated("daily-sleep-temperature-derivations", ago(14), ago(0))),
  list("daily-vo2-max", dated("daily-vo2-max", ago(60), ago(0))),
  list("run-vo2-max", physical("run-vo2-max", "sample_time.physical_time", ago(60), ago(0))),
  list("vo2-max", physical("vo2-max", "sample_time.physical_time", ago(60), ago(0))),
  // Sessions: the sleep extras, the exercise detail (splits, mobility metrics, pace), ECG and IRN.
  list("sleep", `sleep.interval.end_time >= "${ago(7).toISOString()}" AND sleep.interval.end_time < "${now.toISOString()}"`, 3),
  list("exercise", `exercise.interval.civil_start_time >= "${day(ago(60))}T00:00:00" AND exercise.interval.civil_start_time < "${day(ago(0))}T23:59:59"`, 5),
  list("electrocardiogram", `electrocardiogram.interval.start_time >= "${ago(3650).toISOString()}"`, 3),
  list("irregular-rhythm-notification", `irregular_rhythm_notification.interval.civil_start_time >= "${day(ago(365))}T00:00:00"`, 5),
  // Activity detail Fitbit computes.
  list("activity-level", physical("activity-level", "interval.start_time", ago(1), ago(0)), 50),
  list("daily-heart-rate-zones", dated("daily-heart-rate-zones", ago(14), ago(0))),
  list("active-zone-minutes", physical("active-zone-minutes", "interval.start_time", ago(2), ago(0)), 50),
  list("sedentary-period", physical("sedentary-period", "interval.start_time", ago(2), ago(0)), 50),
];

async function probe(token, p) {
  const t0 = Date.now();
  const res = await fetch(p.url, { method: p.method, headers: { authorization: `Bearer ${token}`, ...(p.body && { "content-type": "application/json" }) }, body: p.body && JSON.stringify(p.body) });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { nonJson: text.slice(0, 120) };
  }
  const out = { name: p.name, request: { method: p.method, path: p.url.slice(API.length), ...(p.body && { body: p.body }) }, status: res.status, ms: Date.now() - t0 };
  if (!res.ok) {
    out.error = { status: j.error?.status, message: j.error?.message, details: shape(j.error?.details) };
    return out;
  }
  const key = ["dataPoints", "rollupDataPoints", "reconciledDataPoints"].find((k) => Array.isArray(j[k]));
  const points = key ? j[key] : [];
  out.response = { keys: Object.keys(j), [key ?? "points"]: points.length, nextPageToken: Boolean(j.nextPageToken), first: points.length ? shape(points[0]) : null, spacingSeconds: spacing(points) };
  return out;
}

const token = await getToken();
const report = { generatedAt: now.toISOString(), scopes: SCOPES, probes: [] };
for (const p of PROBES) {
  process.stdout.write(`${p.name.padEnd(56)}`);
  try {
    const r = await probe(token, p);
    report.probes.push(r);
    console.log(r.status === 200 ? `200  ${r.response.points ?? r.response.dataPoints ?? r.response.rollupDataPoints ?? r.response.reconciledDataPoints ?? 0} points` : `${r.status}  ${r.error.status ?? ""}  ${(r.error.message ?? "").slice(0, 90)}`);
  } catch (e) {
    report.probes.push({ name: p.name, failed: String(e) });
    console.log(`failed  ${String(e).slice(0, 90)}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // under the 5 QPS per user
}
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nReport written to ${OUT} (statuses, error wording, shapes and counts; no readings).`);
