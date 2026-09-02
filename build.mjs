// Rebuilds docs/index.html from src/template.html using live data.
//
// Two sources, both free and key-less:
//   NWS      api.weather.gov          official US forecast + station observations
//   TSD      ll.thespacedevs.com      Launch Library 2, upcoming launches
//
// Design rule: stale beats wrong. If either fetch fails or returns a shape we
// do not recognise, this exits non-zero WITHOUT writing, so the previously
// deployed page stays up untouched.

import { readFile, writeFile } from "node:fs/promises";

const LAT = 32.8801;                 // UCSD / La Jolla
const LON = -117.234;
const UA = "t-minus-san-diego (github actions; personal dashboard)";
const TZ = "America/Los_Angeles";

const fail = (m) => { console.error("BUILD FAILED:", m); process.exit(1); };

async function getJSON(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`);
  return res.json();
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Reads the first path that yields a non-empty value. The Launch Library
// response shape varies by mode, so never assume a single path.
const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};

const fmtDate = (d, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }).format(d);

// en-GB renders September as "Sept", which breaks the three-letter column.
// Build the "2 Sep" form from numeric parts instead.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMon = (d) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric", month: "numeric" })
    .formatToParts(d);
  const day = parts.find((p) => p.type === "day").value;
  const mon = Number(parts.find((p) => p.type === "month").value);
  return `${day} ${MONTHS[mon - 1]}`;
};

// ---------------------------------------------------------------- launches

function renderLaunches(json) {
  const results = json?.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error("launches: no results array");

  const rows = results.slice(0, 8).map((L) => {
    const name = pick(L, "name") || "Unnamed mission";
    const vehicle = pick(L, "rocket.configuration.full_name", "rocket.configuration.name", "name") || "TBD";
    const padName = pick(L, "pad.name") || "";
    const locName = pick(L, "pad.location.name") || "";
    const net = pick(L, "net");
    const precision = String(pick(L, "net_precision.abbrev", "net_precision.name") || "");

    // A mission name usually reads "Falcon 9 | Starlink 15-23"; keep the right half.
    const mission = name.includes("|") ? name.split("|").pop().trim() : name;
    const veh = vehicle.includes("|") ? vehicle.split("|")[0].trim() : vehicle;

    let when = "TBD", time = "", firm = false;
    if (net) {
      const d = new Date(net);
      if (!isNaN(d)) {
        // SEC, MIN and HR all mean the window is pinned to a real clock time.
        // DAY and coarser mean the date itself is still provisional.
        firm = precision === "" || /^(sec|min|hr|hour)/i.test(precision);
        when = dayMon(d);
        if (firm) time = fmtDate(d, { hour: "2-digit", minute: "2-digit", hour12: false }) + " PT";
        else when = "NET " + when;
      }
    }

    // The API says "Unknown Pad" when it has a location but no pad. Drop it
    // rather than printing the word Unknown on the board.
    const site = [padName, locName]
      .filter((s) => s && !/^unknown/i.test(s))
      .join(" &middot; ");
    const isVberg = /vandenberg/i.test(locName) || /vandenberg/i.test(padName);
    // Polar launches out of SLC-4E are genuinely visible from San Diego, but
    // only in the dark. Anything from ~19:00 to ~06:00 local qualifies.
    let nightly = false;
    if (isVberg && net) {
      const h = Number(fmtDate(new Date(net), { hour: "2-digit", hour12: false }));
      nightly = h >= 19 || h < 6;
    }

    const cls = isVberg ? ' class="vberg"' : (!firm ? ' class="tbd"' : "");
    const marker = nightly
      ? '<span class="visible-note">Often visible from San Diego</span>' : "";

    return `            <tr${cls}>
              <td class="when mono">${esc(when)}${time ? `<small>${esc(time)}</small>` : ""}</td>
              <td class="veh">${esc(veh)}</td>
              <td class="mission">${esc(mission)}${site ? `<small>${site}</small>` : ""}${marker}</td>
            </tr>`;
  });

  const vbergNight = results.slice(0, 8).some((L) => {
    const loc = String(pick(L, "pad.location.name") || "");
    const net = pick(L, "net");
    if (!/vandenberg/i.test(loc) || !net) return false;
    const h = Number(fmtDate(new Date(net), { hour: "2-digit", hour12: false }));
    return h >= 19 || h < 6;
  });

  const foot = vbergNight
    ? "There is a Vandenberg night launch on the board. Those go up the coast on a polar track and are regularly visible from San Diego on a clear night, roughly two to four minutes after liftoff, low in the northwest."
    : "No Vandenberg night launch is currently manifested. Those are the ones worth setting an alarm for, since a polar track out of SLC-4E is visible from San Diego on clear nights.";

  return { rows: rows.join("\n"), foot };
}

// ---------------------------------------------------------------- weather

async function getWeather() {
  const points = await getJSON(`https://api.weather.gov/points/${LAT},${LON}`, "points");
  const forecastURL = pick(points, "properties.forecast");
  if (!forecastURL) throw new Error("weather: no forecast URL in points response");

  const fc = await getJSON(forecastURL, "forecast");
  const periods = pick(fc, "properties.periods");
  if (!Array.isArray(periods) || periods.length === 0) throw new Error("weather: no forecast periods");

  // Pair each daytime period with the night that follows it.
  const days = [];
  for (let i = 0; i < periods.length && days.length < 4; i++) {
    const p = periods[i];
    if (!p.isDaytime) continue;
    const night = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null;
    days.push({
      label: fmtDate(new Date(p.startTime), { weekday: "short" }),
      hi: p.temperature,
      lo: night ? night.temperature : null,
      sky: p.shortForecast,
    });
  }
  if (days.length === 0) throw new Error("weather: no daytime periods");

  // Current conditions come from the nearest station; fall back to the forecast.
  let now = null;
  try {
    const stations = await getJSON(pick(points, "properties.observationStations"), "stations");
    const first = pick(stations, "features.0.id", "observationStations.0");
    const obs = await getJSON(`${first}/observations/latest`, "observation");
    const c = pick(obs, "properties.temperature.value");
    now = {
      temp: c == null ? periods[0].temperature : Math.round((c * 9) / 5 + 32),
      sky: pick(obs, "properties.textDescription") || periods[0].shortForecast,
      humidity: Math.round(pick(obs, "properties.relativeHumidity.value") ?? NaN),
      station: String(pick(obs, "properties.station") || "").split("/").pop(),
    };
  } catch (e) {
    console.warn("observation unavailable, using forecast:", e.message);
    now = { temp: periods[0].temperature, sky: periods[0].shortForecast, humidity: NaN, station: null };
  }

  return { now, days };
}

function renderWeather({ now, days }) {
  const detail = [
    Number.isFinite(now.humidity) ? `Humidity ${now.humidity}%` : null,
    now.station ? `Station ${esc(now.station)}` : null,
  ].filter(Boolean).join(" &middot; ");

  const wxNow = `
        <div class="deg">${esc(now.temp)}&deg;</div>
        <div class="cond">
          <b>${esc(now.sky)}</b>
          ${detail || "Current conditions"}
        </div>`;

  const wxDays = "\n" + days.map((d) => `        <div class="wx-day"><div class="d">${esc(d.label)}</div>` +
    `<div class="hi mono">${esc(d.hi)}&deg;</div>` +
    `<div class="lo mono">${d.lo == null ? "&mdash;" : esc(d.lo) + "&deg;"}</div>` +
    `<div class="sky">${esc(d.sky)}</div></div>`).join("\n") + "\n      ";

  const wet = days.some((d) => /rain|shower|storm|drizzle/i.test(d.sky));
  const foot = wet
    ? "Rain in the outlook. Worth checking before any pre-dawn launch drive, since coastal cloud kills the view even when the launch is on time."
    : "Clear through the outlook. The marine layer usually burns off by late morning, which matters for both move-in logistics and pre-dawn launch viewing.";

  return { wxNow, wxDays, foot };
}

// ---------------------------------------------------------------- main

const [launchJSON, weather] = await Promise.all([
  getJSON("https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=8", "launches"),
  getWeather(),
]).catch(fail);

let launches, wx;
try {
  launches = renderLaunches(launchJSON);
  wx = renderWeather(weather);
} catch (e) {
  fail(e.message);
}

const stampDate = `${dayMon(new Date())} ${fmtDate(new Date(), { year: "numeric" })}`;
const stampTime = fmtDate(new Date(), { hour: "2-digit", minute: "2-digit", hour12: false });

const replacements = {
  LAUNCH_ROWS: launches.rows,
  LAUNCH_FOOT: launches.foot,
  SRC_LAUNCH: `The Space Devs &middot; ${stampDate}`,
  SRC_WX: `NWS &middot; ${stampDate}`,
  WX_NOW: wx.wxNow,
  WX_DAYS: wx.wxDays,
  WX_FOOT: wx.foot,
  STAMP: `      <b>Data stamp</b>
      Manifest &amp; weather: ${stampDate}, ${stampTime} PT<br>
      Countdown: live in browser`,
};

let html = await readFile(new URL("./src/template.html", import.meta.url), "utf8");
for (const [key, value] of Object.entries(replacements)) {
  const marker = `<!--${key}-->`;
  if (!html.includes(marker)) fail(`template is missing ${marker}`);
  html = html.replace(marker, value);
}

await writeFile(new URL("./docs/index.html", import.meta.url), html);
console.log(`Built docs/index.html — ${launchJSON.results.length} launches, ${weather.days.length} forecast days.`);
