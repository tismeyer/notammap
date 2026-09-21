/**
 * notam-alternates.js
 * --------------------
 * Adds an "enroute alternate NOTAMs" section to the GRAMET briefing email.
 *
 * For a given origin/destination ICAO pair:
 *   1. Finds the 6 nearest airports (from the curated TAF_AIRPORTS list,
 *      same list used by the flightsheet tool) to the great-circle route.
 *   2. Queries the Aviation Edge NOTAM API for each of those airports.
 *   3. Filters down to NOTAMs that look like runway / movement-area closures.
 *   4. Returns an HTML block ready to append to the briefing email.
 *
 * Drop this file next to briefing.js and require() it from there.
 * Needs AVIATION_EDGE_API_KEY set as a Railway environment variable —
 * never hardcode the key in this file.
 */

const fetch = require('node-fetch');

const R_EARTH_NM = 3440.065;
const AVIATION_EDGE_KEY = process.env.AVIATION_EDGE_API_KEY;

// --- Curated candidate airports (from the TAFMap project) -----------------
const TAF_AIRPORTS = [
  "EGLL", "LFPG", "EHAM", "EDDF", "LEMD", "LIRF",
  "LSZH", "EDDM", "LEBL", "EGKK", "EBCI", "EBBR",
  "LOWW", "LPPT", "EKCH", "ESGG", "ESSA", "EFHK",
  "ENGM", "LGAV", "LTFM", "EPWA", "LKPR", "LHBP",
  "LROP", "LDSP", "LDZA", "LJLJ", "LYBE", "LWSK",
  "LATI", "LGTS", "LCLK", "LLBG", "HEAX", "HESH",
  "OJAI", "LIMC", "LIME", "LICJ", "LICC", "LFMN",
  "LFBO", "LFLL", "LFRS", "LFSB", "LEBB", "LEMG",
  "LEPA", "EGPH", "EGPF", "EGNX", "EGCC", "EGGD",
  "EIDW", "EINN", "EDDB", "EDDL", "EDDC", "EDDS",
  "EDNY", "EDDW", "EDDH", "EDDK", "ELLX", "EBLG",
  "EHRD", "EBOS", "ENBO", "ENBR", "ENVA", "ESMS",
  "EVRA", "EYVI", "EETN", "LOWG", "EKBI", "EICK",
  "LFBD", "LFML", "LFPO", "LFMP", "EDDV", "EDAH",
  "EDXW", "LGKR", "LGIR", "LGKL", "LGKO", "LGMK",
  "LGRP", "LGZA", "LIPE", "LIRQ", "LIRN", "LIEO",
  "LIPZ", "LEAL", "LEIB", "LEMH", "LEVC", "LDDU",
  "EPGD", "EPKK", "EPPO", "EPWR", "LPPR", "LPFR",
  "LRCL", "LYNI", "LZKZ", "BKPR", "LMML", "LGSA",
  "LTAI", "EGLC", "EGBB", "LSGG", "EPKT", "EDDN",
  "EDDP", "LIMF", "LIBR", "LIBD", "LEZG", "LBSF",
  "LBPD", "LRTR", "LQSA", "LZIB", "ESMQ", "ESPA",
  "ESNN", "ESNS", "EFKT", "EFOU", "EFRO", "ENTC",
  "ENAT", "ENZV", "LSZB", "LSGS", "ENSB", "ENEV",
  "EGSS", "EGGP", "LCPH", "DTMB", "DTTA", "HECA",
  "HEGN", "LEZL", "LIRA", "LTBA", "LYPG", "LYTV",
];

// --- Airport coordinate DB (OurAirports, same source flightsheet.py uses) -
// NOTE: stores ALL airports from the CSV (not just TAF_AIRPORTS), because a
// flight's actual dep/dest might not itself be in the curated candidate
// list. TAF_AIRPORTS is only used later to restrict which airports are
// considered as *alternate candidates* along the route.
let _airportDbCache = null;
async function loadAirportDb() {
  if (_airportDbCache) return _airportDbCache;
  const res = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv');
  const csv = await res.text();
  const db = {};
  const lines = csv.split('\n');
  const header = lines[0].split(',').map(h => h.replace(/"/g, ''));
  const identIdx = header.indexOf('ident');
  const latIdx = header.indexOf('latitude_deg');
  const lonIdx = header.indexOf('longitude_deg');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = lines[i].split(',').map(c => c.replace(/"/g, ''));
    const icao = cols[identIdx];
    if (icao && icao.length === 4) {
      const lat = parseFloat(cols[latIdx]);
      const lon = parseFloat(cols[lonIdx]);
      if (!isNaN(lat) && !isNaN(lon)) db[icao] = [lat, lon];
    }
  }
  _airportDbCache = db;
  return db;
}

// --- Great-circle cross-track / along-track math ---------------------------
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineNm(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R_EARTH_NM * Math.asin(Math.sqrt(a));
}

function bearingRad(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return Math.atan2(y, x);
}

function crossAndAlongTrackNm(oLat, oLon, dLat, dLon, pLat, pLon) {
  const dOp = haversineNm(oLat, oLon, pLat, pLon) / R_EARTH_NM;
  const brgOp = bearingRad(oLat, oLon, pLat, pLon);
  const brgOd = bearingRad(oLat, oLon, dLat, dLon);

  const crossTrackRad = Math.asin(Math.sin(dOp) * Math.sin(brgOp - brgOd));
  const clamped = Math.min(1, Math.max(-1, Math.cos(dOp) / Math.cos(crossTrackRad)));
  // acos() only returns the magnitude. Airports BEHIND the origin (more than
  // 90° off the route bearing) must get a negative along-track distance,
  // otherwise airports on the backward extension of the route (e.g. LIPZ or
  // LDSP for LSZH→EGKK) look like they sit right on the track.
  const sign = Math.cos(brgOp - brgOd) < 0 ? -1 : 1;
  const alongTrackRad = sign * Math.acos(clamped);

  const routeLengthNm = haversineNm(oLat, oLon, dLat, dLon);
  return {
    crossTrackNm: crossTrackRad * R_EARTH_NM,
    alongTrackNm: alongTrackRad * R_EARTH_NM,
    routeLengthNm,
  };
}

// Airports further than this from the great-circle track are never offered
// as enroute alternates, even if that leaves fewer than n candidates.
const MAX_CROSS_TRACK_NM = 80;

// Airports never offered as enroute alternates (demanding approaches /
// operationally unsuitable for a diversion). They stay in TAF_AIRPORTS, so
// TAFMap and the NOTAM map still show them.
const EXCLUDED_ENROUTE_ALTERNATES = new Set(['LSZB', 'LOWI', 'LSZS', 'LSGS', 'LIRQ', 'EGLC']);

function nearestAirportsOnRoute(originIcao, destIcao, db, n = 6, endpointBufferNm = 30, maxCrossTrackNm = MAX_CROSS_TRACK_NM) {
  if (!db[originIcao] || !db[destIcao]) {
    throw new Error(`Missing coordinates for ${originIcao} or ${destIcao}`);
  }
  const [oLat, oLon] = db[originIcao];
  const [dLat, dLon] = db[destIcao];

  const results = [];
  for (const icao of TAF_AIRPORTS) {
    if (icao === originIcao || icao === destIcao) continue;
    if (EXCLUDED_ENROUTE_ALTERNATES.has(icao)) continue;
    if (!db[icao]) continue;
    const [pLat, pLon] = db[icao];
    const { crossTrackNm, alongTrackNm, routeLengthNm } = crossAndAlongTrackNm(oLat, oLon, dLat, dLon, pLat, pLon);
    if (alongTrackNm >= -endpointBufferNm && alongTrackNm <= routeLengthNm + endpointBufferNm
        && Math.abs(crossTrackNm) <= maxCrossTrackNm) {
      results.push({ icao, crossTrackNm: Math.abs(crossTrackNm), alongTrackNm });
    }
  }
  results.sort((a, b) => a.crossTrackNm - b.crossTrackNm);
  return results.slice(0, n);
}

// --- Aviation Edge NOTAM fetch + closure filter -----------------------------
// NOTE: Aviation Edge's docs example uses ?iata=ORY but the sample response
// data shows ICAO-style codes (e.g. "loww"). Once the key is live, test one
// known airport (e.g. LSZH) and confirm whether it wants the ICAO or the
// 3-letter IATA code — swap the param below if results come back empty.
// --- ICAO → IATA lookup ------------------------------------------------
// Aviation Edge's NOTAM API takes the 3-letter IATA code (confirmed via the
// NOTAM_DEBUG diagnostic — ICAO codes returned 0 results). Covers the
// TAF_AIRPORTS list above. A few smaller regional/island fields are
// best-effort (marked below) — if NOTAM_DEBUG shows 0 results for one of
// those specifically, that entry is the first place to check.
const ICAO_TO_IATA = {
  EGLL:'LHR', LFPG:'CDG', EHAM:'AMS', EDDF:'FRA',
  LEMD:'MAD', LIRF:'FCO', LSZH:'ZRH', EDDM:'MUC',
  LEBL:'BCN', EGKK:'LGW', EBCI:'CRL', EBBR:'BRU',
  LOWW:'VIE', LPPT:'LIS', EKCH:'CPH', ESGG:'GOT',
  ESSA:'ARN', EFHK:'HEL', ENGM:'OSL', LGAV:'ATH',
  LTFM:'IST', EPWA:'WAW', LKPR:'PRG', LHBP:'BUD',
  LROP:'OTP', LDSP:'SPU', LDZA:'ZAG', LJLJ:'LJU',
  LYBE:'BEG', LWSK:'SKP', LATI:'TIA', LGTS:'SKG',
  LCLK:'LCA', LLBG:'TLV', HEAX:'ALY', HESH:'SSH',
  OJAI:'AMM', LIMC:'MXP', LIME:'BGY', LICJ:'PMO',
  LICC:'CTA', LFMN:'NCE', LFBO:'TLS', LFLL:'LYS',
  LFRS:'NTE', LFSB:'BSL', LEBB:'BIO', LEMG:'AGP',
  LEPA:'PMI', EGPH:'EDI', EGPF:'GLA', EGNX:'EMA',
  EGCC:'MAN', EGGD:'BRS', EIDW:'DUB', EINN:'SNN',
  EDDB:'BER', EDDL:'DUS', EDDC:'DRS', EDDS:'STR',
  EDNY:'FDH', EDDW:'BRE', EDDH:'HAM', EDDK:'CGN',
  ELLX:'LUX', EBLG:'LGG', EHRD:'RTM', EBOS:'OST',
  ENBO:'BOO', ENBR:'BGO', ENVA:'TRD', ESMS:'MMX',
  EVRA:'RIX', EYVI:'VNO', EETN:'TLL', LOWG:'GRZ',
  EKBI:'BLL', EICK:'ORK', LFBD:'BOD', LFML:'MRS',
  LFPO:'ORY', LFMP:'PGF', EDDV:'HAJ', EDAH:'HDF',
  EDXW:'', LGKR:'CFU', LGIR:'HER', LGKL:'KLX',
  LGKO:'KGS', LGMK:'JMK', LGRP:'RHO', LGZA:'ZTH',
  LIPE:'BLQ', LIRQ:'FLR', LIRN:'NAP', LIEO:'AHO',
  LIPZ:'VCE', LEAL:'ALC', LEIB:'IBZ', LEMH:'MAH',
  LEVC:'VLC', LDDU:'DBV', EPGD:'GDN', EPKK:'KRK',
  EPPO:'POZ', EPWR:'WRO', LPPR:'OPO', LPFR:'FAO',
  LRCL:'CLJ', LYNI:'INI', LZKZ:'KSC', BKPR:'PRN',
  LMML:'MLA', LGSA:'CHQ', LTAI:'AYT', EGLC:'LCY',
  EGBB:'BHX', LSGG:'GVA', EPKT:'KTW', EDDN:'NUE',
  EDDP:'LEJ', LIMF:'TRN', LIBR:'BDS', LIBD:'BRI',
  LEZG:'ZAZ', LBSF:'SOF', LBPD:'PDV', LRTR:'TSR',
  LQSA:'SJJ', LZIB:'BTS', ESMQ:'KLR', ESPA:'LLA',
  ESNN:'SDL', ESNS:'SFT', EFKT:'KTT', EFOU:'OUL',
  EFRO:'RVN', ENTC:'TOS', ENAT:'ALF', ENZV:'SVG',
  LSZB:'BRN', LSGS:'SIR', ENSB:'LYR', ENEV:'EVE',
  EGSS:'STN', EGGP:'LPL', LCPH:'PFO', DTMB:'MIR',
  DTTA:'TUN', HECA:'CAI', HEGN:'HRG', LEZL:'SVQ',
  LIRA:'CIA', LTBA:'ISL', LYPG:'TGD', LYTV:'TIV',
};

function toIata(icao) {
  const iata = ICAO_TO_IATA[icao];
  return iata ? iata : icao; // fall back to ICAO if unmapped
}

async function fetchNotams(icaoCode) {
  if (!AVIATION_EDGE_KEY) throw new Error('AVIATION_EDGE_API_KEY not set');
  const code = toIata(icaoCode);
  const url = `https://aviation-edge.com/v2/public/notams?key=${AVIATION_EDGE_KEY}&iata=${code}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`NOTAM fetch failed for ${icaoCode} (iata=${code}): ${res.status}`);
    return [];
  }
  const data = await res.json();
  const notams = Array.isArray(data) ? data : [];
  if (process.env.NOTAM_DEBUG) {
    console.log(`[notam-debug] ${icaoCode} (iata=${code}): ${notams.length} raw NOTAM(s) returned`);
  }
  return notams;
}

// Alert categories, each with its ICAO Q-code pattern(s) plus a plain-text
// fallback, since Aviation Edge's `condition` field is the raw NOTAM text.
// Q-code structure: Q) <FIR>/Q<subject 2 letters><condition 2 letters>/...
// Q-code subject group reference (ICAO Doc 8126, "M" = movement/landing area):
//   MR = runway, MX = taxiway, MN = apron, FA = aerodrome (whole-airport).
// MX (taxiway) is deliberately NOT included here — a pure taxiway closure
// is excluded entirely rather than counted as a runway closure. This also
// matters for NOTAMs that describe a taxiway closure "relative to" a runway
// (e.g. "TWY B EAST FM RWY 16/34 CLSD") — those carry an MX code even though
// the free text mentions "RWY...CLSD", so Q-code must take priority over
// the text-fallback patterns below or they get miscategorized.
const RUNWAY_QCODES = ['mrlc', 'falc', 'mnlc'];
const EXCLUDED_QCODES = ['mxlc']; // taxiway-only closures — never categorized
const ILS_QCODE_RE = /^i[cdgl]as$/;
const MINIMA_QCODES = ['pich', 'poch'];
const MISSED_APPROACH_QCODES = ['puch']; // PU = missed approach procedure, CH = changed

const ALERT_CATEGORIES = [
  {
    label: 'Runway/movement area closed',
    patterns: [
      /rwy.{0,10}\bclsd\b/i,
      /runway.{0,15}closed/i,
    ],
  },
  {
    label: 'ILS/navaid unserviceable',
    patterns: [
      /\bils\b.{0,25}(u\/s|unserviceable|unavailable)/i,
      /glide ?path.{0,20}(u\/s|unserviceable)/i,
      /localizer.{0,20}(u\/s|unserviceable)/i,
    ],
  },
  {
    label: 'Approach minima / DA-DH changed',
    patterns: [
      /\b(da|dh|oca|och)\b.{0,25}(chang|increas|revis)/i,
      /minima.{0,25}(chang|increas|revis)/i,
    ],
  },
  {
    label: 'Missed approach procedure changed',
    patterns: [
      /missed approach.{0,25}(chang|revis|amend)/i,
    ],
  },
];

function isActive(notam, now = new Date()) {
  const start = new Date(notam.startdateutc);
  const end = notam.enddateutc === 'perm' ? new Date('2099-01-01') : new Date(notam.enddateutc);
  return start <= now && end >= now;
}

function extractQCode(text) {
  const m = text.match(/q\)\s*[a-z]{4}\/q([a-z]{4})/i);
  return m ? m[1].toLowerCase() : null;
}

// Returns the matching category label, or null if the NOTAM doesn't match
// any of the categories we care about. The Q-code (a structured field) is
// authoritative when present — free-text pattern matching is only used as
// a fallback for the rare NOTAM where no Q-code could be extracted at all.
function categorize(notam) {
  const text = (notam.condition || '').toLowerCase();
  const qcode = extractQCode(text);

  if (qcode) {
    if (EXCLUDED_QCODES.includes(qcode)) return null; // taxiway-only — excluded
    if (RUNWAY_QCODES.includes(qcode)) return 'Runway/movement area closed';
    if (ILS_QCODE_RE.test(qcode)) return 'ILS/navaid unserviceable';
    if (MINIMA_QCODES.includes(qcode)) return 'Approach minima / DA-DH changed';
    if (MISSED_APPROACH_QCODES.includes(qcode)) return 'Missed approach procedure changed';
    return null; // recognized Q-code, but not one we track — trust it over free text
  }

  // No Q-code found at all — fall back to free-text heuristics.
  for (const cat of ALERT_CATEGORIES) {
    if (cat.patterns.some((re) => re.test(text))) return cat.label;
  }
  return null;
}

// --- Build the HTML block for the briefing email ----------------------------
async function buildNotamHtmlBlock(originIcao, destIcao, n = 6) {
  const db = await loadAirportDb();
  const nearby = nearestAirportsOnRoute(originIcao, destIcao, db, n);

  const perAirport = await Promise.all(
    nearby.map(async ({ icao }) => {
      const notams = await fetchNotams(icao);
      const flagged = notams
        .filter((nt) => isActive(nt))
        .map((nt) => ({ ...nt, category: categorize(nt) }))
        .filter((nt) => nt.category !== null);
      return { icao, flagged };
    })
  );

  const rows = perAirport
    .map(({ icao, flagged }) => {
      if (flagged.length === 0) {
        return `<tr><td><b>${icao}</b></td><td style="color:#2a7a2a;">No active runway, ILS/navaid, or minima-change NOTAMs</td></tr>`;
      }
      const items = flagged
        .map((c) => `<i>[${c.category}]</i> ${c.number}: ${c.condition.slice(0, 200)}${c.condition.length > 200 ? '…' : ''}`)
        .join('<br>');
      return `<tr><td><b>${icao}</b></td><td style="color:#b00000;">${items}</td></tr>`;
    })
    .join('');

  return `
    <h3>Enroute alternate NOTAMs (nearest ${n} to ${originIcao} → ${destIcao} route)</h3>
    <table cellpadding="6" style="border-collapse:collapse;width:100%;">
      ${rows}
    </table>
  `;
}

// --- Shared NOTAM-fetching logic for a route (used by both text/HTML builders) ---
const CATEGORY_COLORS = {
  'Runway/movement area closed': '#c62828',   // red
  'ILS/navaid unserviceable': '#2e7d32',      // green
  'Approach minima / DA-DH changed': '#7b1fa2', // purple
  'Missed approach procedure changed': '#f2c200', // yellow
};

async function getRouteNotams(originIcao, destIcao, n = 6) {
  const db = await loadAirportDb();
  const nearby = nearestAirportsOnRoute(originIcao, destIcao, db, n);
  const perAirport = await Promise.all(
    nearby.map(async ({ icao }) => {
      const notams = await fetchNotams(icao);
      const flagged = notams
        .filter((nt) => isActive(nt))
        .map((nt) => ({ ...nt, category: categorize(nt) }))
        .filter((nt) => nt.category !== null);
      return { icao, flagged };
    })
  );
  return { count: nearby.length, perAirport };
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// HTML version: same line-by-line layout as the text block, but each
// flagged NOTAM line is wrapped in a colored <span> per its category.
// Meant to be dropped inside a <pre> element so line breaks are preserved.
async function buildNotamHtmlLines(originIcao, destIcao, n = 6) {
  let routeData;
  try {
    routeData = await getRouteNotams(originIcao, destIcao, n);
  } catch (e) {
    return `    NOTAM check skipped: ${escapeHtml(e.message)}`;
  }

  const lines = [`    Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao}&#8594;${destIcao}):`];
  for (const { icao, flagged } of routeData.perAirport) {
    if (flagged.length === 0) {
      lines.push(`      ${icao}: none`);
    } else {
      for (const f of flagged) {
        const cleanedCond = decodeNotamEntities(f.condition); const cond = cleanedCond.length > 150 ? cleanedCond.slice(0, 150) + '…' : cleanedCond;
        const color = CATEGORY_COLORS[f.category] || '#333';
        const safeCond = escapeHtml(cond);
        lines.push(
          `      <span style="color:${color};">${icao} [${f.category}] ${f.number}: ${safeCond}</span>`
        );
      }
    }
  }
  return lines.join('\n');
}

// --- Plain-text version (used as the multipart "text" fallback) -----------
async function buildNotamTextBlock(originIcao, destIcao, n = 6) {
  let routeData;
  try {
    routeData = await getRouteNotams(originIcao, destIcao, n);
  } catch (e) {
    return `    NOTAM check skipped: ${e.message}`;
  }

  const lines = [`    Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao}→${destIcao}):`];
  for (const { icao, flagged } of routeData.perAirport) {
    if (flagged.length === 0) {
      lines.push(`      ${icao}: none`);
    } else {
      for (const f of flagged) {
        const cleanedCond = decodeNotamEntities(f.condition); const cond = cleanedCond.length > 150 ? cleanedCond.slice(0, 150) + '…' : cleanedCond;
        lines.push(`      ${icao} [${f.category}] ${f.number}: ${cond}`);
      }
    }
  }
  return lines.join('\n');
}

// Builds both the plain-text and HTML versions from a single NOTAM fetch,
// so the API isn't queried twice per flight just to get two output formats.
async function buildNotamBlocks(originIcao, destIcao, n = 6) {
  let routeData;
  try {
    routeData = await getRouteNotams(originIcao, destIcao, n);
  } catch (e) {
    const msg = `    NOTAM check skipped: ${e.message}`;
    return { text: msg, html: escapeHtml(msg) };
  }

  const textLines = [`    Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao}→${destIcao}):`];
  const htmlLines = [`    Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao}&#8594;${destIcao}):`];

  for (const { icao, flagged } of routeData.perAirport) {
    if (flagged.length === 0) {
      textLines.push(`      ${icao}: none`);
      htmlLines.push(`      ${icao}: none`);
    } else {
      for (const f of flagged) {
        const cleanedCond = decodeNotamEntities(f.condition); const cond = cleanedCond.length > 150 ? cleanedCond.slice(0, 150) + '…' : cleanedCond;
        textLines.push(`      ${icao} [${f.category}] ${f.number}: ${cond}`);

        const color = CATEGORY_COLORS[f.category] || '#333';
        htmlLines.push(
          `      <span style="color:${color};">${icao} [${f.category}] ${f.number}: ${escapeHtml(cond)}</span>`
        );
      }
    }
  }
  return { text: textLines.join('\n'), html: htmlLines.join('\n') };
}

// --- Per-airport NOTAM status (for the map, not route-based) ---------------
// Returns the four boolean flags plus the matching NOTAM items for one
// airport, independent of any route — used by the NOTAM map's cache job.
async function getAirportNotamStatus(icao) {
  const notams = await fetchNotams(icao);
  const flagged = notams
    .filter((nt) => isActive(nt))
    .map((nt) => ({ ...nt, category: categorize(nt) }))
    .filter((nt) => nt.category !== null);

  return {
    icao,
    runwayClosed: flagged.some((f) => f.category === 'Runway/movement area closed'),
    ilsUs: flagged.some((f) => f.category === 'ILS/navaid unserviceable'),
    minimaChanged: flagged.some((f) => f.category === 'Approach minima / DA-DH changed'),
    missedApproachChanged: flagged.some((f) => f.category === 'Missed approach procedure changed'),
    items: flagged.map((f) => ({ category: f.category, number: f.number, condition: f.condition })),
  };
}

// --- NOTAM raw-text field parser --------------------------------------
// NOTAM `condition` text packs lettered fields together with inconsistent
// spacing (e.g. "...1600e)" with no space before the marker), so this
// matches markers directly rather than requiring a preceding space.
const NOTAM_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseNotamDate(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (/^perm/i.test(raw)) return 'PERM';
  const m = raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return raw;
  const [, yy, mm, dd, hh, mi] = m;
  const year = 2000 + parseInt(yy, 10);
  return `${dd} ${NOTAM_MONTHS[parseInt(mm, 10) - 1]} ${year}, ${hh}:${mi} UTC`;
}

function parseNotamFields(raw) {
  const re = /([abcdefgq])\)/g;
  const positions = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    positions.push({ letter: m[1], markerStart: m.index, contentStart: re.lastIndex });
  }
  const fields = {};
  for (let i = 0; i < positions.length; i++) {
    const { letter, contentStart } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].markerStart : raw.length;
    fields[letter] = raw.slice(contentStart, end).trim();
  }
  return fields;
}

// Extracts the runway designator (e.g. "35R", "07R/25L") from raw NOTAM
// text, if present, for prominent display next to the ICAO code.
function extractRunway(raw) {
  const m = (raw || '').match(/\b(?:rwy|runway)\s*(\d{2}[lrc]?(?:\/\d{2}[lrc]?)?)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Some sources return HTML-entity-encoded punctuation and zero-width
// spaces embedded directly in the NOTAM text (seen in real EHAM/LSZH data:
// "&apos;", "&#8203;") — decode/strip these before display so they don't
// show up as literal garbage once escaped again for HTML output.
function decodeNotamEntities(str) {
  return (str || '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8203;/g, '')
    .replace(/&amp;/g, '&');
}

const NOTAM_DESCRIPTION_MAX_LEN = 220;

// --- NOTAM D) schedule parser, ported from the TAFMap NOTAM overlay -------
// Parses the free-text recurring-schedule field into day/time segments and
// checks whether a given time window overlaps one. Unlike the map (which
// checks against a user-picked span on "today"), the email checks against
// the flight's own scheduled block time, on the flight's actual date.
const WEEKDAY_ABBR = { mon:0, tue:1, wed:2, thu:3, fri:4, sat:5, sun:6 };

function parseNotamSchedule(dField, refDate) {
  const d = (dField || '').toLowerCase().trim();
  const segments = d.split(',').map(s => s.trim()).filter(Boolean);
  const todayWeekday = (refDate.getUTCDay() + 6) % 7; // convert JS Sun=0 to Mon=0
  const todayDayOfMonth = refDate.getUTCDate();

  return segments.map(seg => {
    const timeMatches = [...seg.matchAll(/(\d{4})-(\d{4})/g)].map(m => [m[1], m[2]]);
    if (timeMatches.length === 0) {
      return { raw: seg, dayMatch: null, times: [], unparsed: true };
    }
    const dayPart = seg.replace(/\d{4}-\d{4}/g, '').trim();
    let dayMatch = null;

    if (/\bdaily\b/.test(dayPart) || /\bevery day\b/.test(dayPart)) {
      dayMatch = true;
    } else {
      const everyMatch = dayPart.match(/\bevery\s+(mon|tue|wed|thu|fri|sat|sun)\b/);
      const rangeMatch = dayPart.match(/\b(mon|tue|wed|thu|fri|sat|sun)\s*-\s*(mon|tue|wed|thu|fri|sat|sun)\b/);
      const wdList = [...dayPart.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)\b/g)].map(m => m[1]);

      if (everyMatch) {
        dayMatch = WEEKDAY_ABBR[everyMatch[1]] === todayWeekday;
      } else if (rangeMatch) {
        const startWd = WEEKDAY_ABBR[rangeMatch[1]], endWd = WEEKDAY_ABBR[rangeMatch[2]];
        dayMatch = startWd <= endWd
          ? (todayWeekday >= startWd && todayWeekday <= endWd)
          : (todayWeekday >= startWd || todayWeekday <= endWd);
      } else if (wdList.length > 0) {
        dayMatch = wdList.some(w => WEEKDAY_ABBR[w] === todayWeekday);
      } else {
        const domList = [...dayPart.matchAll(/\b(\d{1,2})\b/g)].map(m => m[1].padStart(2, '0'));
        dayMatch = domList.length > 0
          ? domList.includes(String(todayDayOfMonth).padStart(2, '0'))
          : null;
      }
    }
    return { raw: seg, dayMatch, times: timeMatches, unparsed: dayMatch === null };
  });
}

function timeRangesOverlap(selLoMin, selHiMin, startHHMM, endHHMM) {
  const toMin = t => parseInt(t.slice(0,2),10) * 60 + parseInt(t.slice(2),10);
  const s = toMin(startHHMM), e = toMin(endHHMM);
  if (s <= e) {
    return selLoMin <= e && selHiMin >= s;
  } else {
    return (selHiMin >= s) || (selLoMin <= e);
  }
}

// Returns { active, unparsed } — whether the D) schedule overlaps at all
// with [selLoMin, selHiMin] (minutes since UTC 00:00) on refDate.
// A NOTAM spanning multiple UTC days (e.g. an overnight flight) is checked
// once per day it touches — see checkScheduleAgainstWindow below.
function evaluateNotamSchedule(dField, selLoMin, selHiMin, refDate) {
  const segments = parseNotamSchedule(dField, refDate);
  const anyUnparsed = segments.some(s => s.unparsed);
  let active = false;
  for (const seg of segments) {
    if (seg.dayMatch) {
      for (const [start, end] of seg.times) {
        if (timeRangesOverlap(selLoMin, selHiMin, start, end)) { active = true; break; }
      }
    }
    if (active) break;
  }
  return { active, unparsed: anyUnparsed };
}

// Checks a D) schedule against an absolute UTC time window given as unix
// seconds (e.g. a flight's departure → arrival). Splits the window into
// per-day segments so an overnight flight is checked against each UTC date
// it actually touches, not just the departure date.
function checkScheduleAgainstWindow(dField, startUnix, endUnix) {
  let anyActive = false;
  let anyUnparsed = false;
  let cursor = new Date(startUnix * 1000);
  const end = new Date(endUnix * 1000);
  let iterations = 0;
  while (cursor <= end && iterations < 4) { // cap: a briefing flight is never multi-day
    const dayStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const segStart = cursor > dayStart ? cursor : dayStart;
    const segEndAbs = end < dayEnd ? end : dayEnd;
    const loMin = Math.floor((segStart - dayStart) / 60000);
    const hiMin = Math.min(1439, Math.ceil((segEndAbs - dayStart) / 60000));
    const { active, unparsed } = evaluateNotamSchedule(dField, loMin, hiMin, dayStart);
    if (active) anyActive = true;
    if (unparsed) anyUnparsed = true;
    cursor = dayEnd;
    iterations++;
  }
  return { active: anyActive, unparsed: anyUnparsed };
}

// Turns a raw NOTAM item ({ category, number, condition }) into a
// structured object ready for card-style display: parsed validity window,
// optional recurring schedule, extracted runway, and a clean description.
function parseNotamItem(item) {
  const cleaned = decodeNotamEntities(item.condition || '');
  const fields = parseNotamFields(cleaned);
  let description = (fields.e || '').trim();
  if (description.length > NOTAM_DESCRIPTION_MAX_LEN) {
    description = description.slice(0, NOTAM_DESCRIPTION_MAX_LEN) + '…';
  }
  return {
    category: item.category,
    number: item.number,
    start: parseNotamDate(fields.b),
    end: parseNotamDate(fields.c),
    schedule: fields.d || null,
    runway: extractRunway(cleaned),
    description: description || cleaned.slice(0, NOTAM_DESCRIPTION_MAX_LEN),
  };
}

// Builds one HTML card for a single parsed NOTAM item, colored by category.
// If flightWindow ({startUnix, endUnix}) is given and the item has a D)
// schedule, the card is greyed out unless the schedule overlaps that window
// — i.e. "will this actually be in effect during this flight?" rather than
// just "is it in its overall validity window at all."
// All text is rendered in capitals (text-transform, so underlying data
// stays normal-case for anything that reuses parseNotamItem elsewhere).
function buildNotamCardHtml(icao, item, flightWindow) {
  const parsed = parseNotamItem(item);
  const color = CATEGORY_COLORS[parsed.category] || '#333';
  const runwayHtml = parsed.runway
    ? `<span style="font-size:24px;font-weight:bold;color:${color};margin-left:14px;">${parsed.runway}</span>`
    : '';

  let scheduleStatusHtml = '';
  let cardOpacity = '1';
  let effectiveColor = color;
  if (parsed.schedule && flightWindow) {
    const { active, unparsed } = checkScheduleAgainstWindow(parsed.schedule, flightWindow.startUnix, flightWindow.endUnix);
    if (unparsed) {
      scheduleStatusHtml = `<div style="font-size:11px;color:#b8860b;margin-top:4px;font-weight:bold;">⏱ SCHEDULE PARTIALLY UNCLEAR — VERIFY TIMING MANUALLY</div>`;
    } else if (active) {
      scheduleStatusHtml = `<div style="font-size:11px;color:${color};margin-top:4px;font-weight:bold;">⚠ ACTIVE DURING THIS FLIGHT</div>`;
    } else {
      cardOpacity = '0.45';
      effectiveColor = '#999';
      scheduleStatusHtml = `<div style="font-size:11px;color:#999;margin-top:4px;">NOT ACTIVE DURING THIS FLIGHT</div>`;
    }
  }

  const scheduleHtml = parsed.schedule
    ? `<div style="font-size:11px;color:#888;margin-top:2px;">ACTIVE: ${escapeHtml(parsed.schedule.toUpperCase())}</div>`
    : '';
  return `
    <div style="border:1px solid #e0e0e0;border-left:4px solid ${effectiveColor};background:#fafafa;padding:10px 14px;margin-bottom:8px;border-radius:2px;text-transform:uppercase;opacity:${cardOpacity};">
      <div style="display:flex;align-items:baseline;">
        <span style="font-weight:bold;font-size:15px;color:${effectiveColor};">${icao}</span>
        ${runwayHtml}
      </div>
      <div style="font-weight:bold;color:${effectiveColor};margin-top:4px;">${escapeHtml(parsed.category)}</div>
      <div style="font-size:11px;color:#777;margin-top:2px;">NOTAM ${escapeHtml(parsed.number)}</div>
      <div style="font-family:monospace;font-size:12px;color:#333;margin-top:4px;">Valid: ${parsed.start} &#8594; ${parsed.end}</div>
      ${scheduleHtml}
      ${scheduleStatusHtml}
      <div style="font-size:12px;color:#222;margin-top:4px;">${escapeHtml(parsed.description)}</div>
    </div>
  `;
}

const NOTAM_CATEGORY_PRIORITY = [
  'Runway/movement area closed',
  'ILS/navaid unserviceable',
  'Approach minima / DA-DH changed',
  'Missed approach procedure changed',
];

function sortNotamItemsByPriority(items) {
  return [...items].sort((a, b) => {
    const pa = NOTAM_CATEGORY_PRIORITY.indexOf(a.category);
    const pb = NOTAM_CATEGORY_PRIORITY.indexOf(b.category);
    return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
  });
}

// "Runway at a glance" strip: one colored runway label per distinct
// (runway, category) pair, greyed if none of the contributing NOTAMs are
// active during the flight window. Mirrors the map popup's header exactly.
function buildRunwaySummaryHtml(items, flightWindow) {
  const groups = new Map();
  for (const item of items) {
    const parsed = parseNotamItem(item);
    if (!parsed.runway) continue;
    let active = true;
    if (parsed.schedule && flightWindow) {
      const result = checkScheduleAgainstWindow(parsed.schedule, flightWindow.startUnix, flightWindow.endUnix);
      active = result.unparsed ? true : result.active;
    }
    const key = parsed.runway + '|' + parsed.category;
    if (groups.has(key)) {
      groups.get(key).active = groups.get(key).active || active;
    } else {
      groups.set(key, { runway: parsed.runway, category: parsed.category, active });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const pa = NOTAM_CATEGORY_PRIORITY.indexOf(a.category);
    const pb = NOTAM_CATEGORY_PRIORITY.indexOf(b.category);
    return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
  });
  return sorted.map(g => {
    const color = CATEGORY_COLORS[g.category] || '#333';
    const opacity = g.active ? '1' : '0.35';
    return `<span style="font-size:24px;font-weight:bold;color:${color};margin-right:12px;opacity:${opacity};">${g.runway}</span>`;
  }).join('');
}

// Full per-route HTML section for the briefing email: one heading + runway
// summary + sorted cards per alternate airport with active items, or a
// compact "ICAO: none" line for airports with nothing active — same
// structure as the old buildNotamHtmlLines, now with the upgraded cards.
// flightWindow ({startUnix, endUnix}, unix seconds) lets cards show whether
// each NOTAM will actually be in effect during this specific flight.
async function buildNotamEmailHtml(originIcao, destIcao, flightWindow, n = 6) {
  let routeData;
  try {
    routeData = await getRouteNotams(originIcao, destIcao, n);
  } catch (e) {
    return `<div style="font-size:12px;color:#888;">NOTAM check skipped: ${escapeHtml(e.message)}</div>`;
  }

  const sections = routeData.perAirport.map(({ icao, flagged }) => {
    if (flagged.length === 0) {
      return `<div style="font-size:12px;color:#2a7a2a;margin-bottom:4px;"><b>${icao}</b>: no active runway/ILS/minima/missed-approach NOTAMs</div>`;
    }
    const sortedItems = sortNotamItemsByPriority(flagged);
    const runwaySummary = buildRunwaySummaryHtml(sortedItems, flightWindow);
    const cards = sortedItems.map(item => buildNotamCardHtml(icao, item, flightWindow)).join('');
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex;align-items:baseline;margin-bottom:4px;">
          <span style="font-family:monospace;font-weight:bold;font-size:15px;margin-right:8px;">${icao}</span>
          ${runwaySummary}
        </div>
        ${cards}
      </div>
    `;
  });

  return `
    <div style="margin-top:6px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:6px;">Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao} &#8594; ${destIcao}):</div>
      ${sections.join('')}
    </div>
  `;
}

// Combined text+HTML builder for the briefing email — single fetch produces
// both outputs, same efficiency pattern as the original buildNotamBlocks.
// flightWindow lets both versions show whether each NOTAM will actually be
// in effect during this specific flight (not just "is it valid at all").
async function buildNotamEmailBlocks(originIcao, destIcao, flightWindow, n = 6) {
  let routeData;
  try {
    routeData = await getRouteNotams(originIcao, destIcao, n);
  } catch (e) {
    const msg = `    NOTAM check skipped: ${e.message}`;
    return { text: msg, html: escapeHtml(msg) };
  }

  const textLines = [`    Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao}→${destIcao}):`];
  const htmlSections = [];

  for (const { icao, flagged } of routeData.perAirport) {
    if (flagged.length === 0) {
      textLines.push(`      ${icao}: none`);
      htmlSections.push(`<div style="font-size:12px;color:#2a7a2a;margin-bottom:4px;"><b>${icao}</b>: no active runway/ILS/minima/missed-approach NOTAMs</div>`);
      continue;
    }
    const sortedItems = sortNotamItemsByPriority(flagged);
    for (const item of sortedItems) {
      const parsed = parseNotamItem(item);
      textLines.push(`      ${icao} [${parsed.category}]${parsed.runway ? ' RWY ' + parsed.runway : ''} ${item.number}: ${parsed.description}`);
    }
    const runwaySummary = buildRunwaySummaryHtml(sortedItems, flightWindow);
    const cards = sortedItems.map(item => buildNotamCardHtml(icao, item, flightWindow)).join('');
    htmlSections.push(`
      <div style="margin-bottom:10px;">
        <div style="display:flex;align-items:baseline;margin-bottom:4px;">
          <span style="font-family:monospace;font-weight:bold;font-size:15px;margin-right:8px;">${icao}</span>
          ${runwaySummary}
        </div>
        ${cards}
      </div>
    `);
  }

  const html = `
    <div style="margin-top:6px;">
      <div style="font-size:13px;font-weight:bold;margin-bottom:6px;">Enroute alternate NOTAMs (nearest ${routeData.count} to ${originIcao} &#8594; ${destIcao}):</div>
      ${htmlSections.join('')}
    </div>
  `;

  return { text: textLines.join('\n'), html };
}

module.exports = {
  buildNotamHtmlBlock,
  buildNotamHtmlLines,
  buildNotamTextBlock,
  buildNotamBlocks,
  buildNotamEmailBlocks,
  buildNotamEmailHtml,
  getRouteNotams,
  getAirportNotamStatus,
  parseNotamFields,
  parseNotamItem,
  extractRunway,
  decodeNotamEntities,
  buildNotamCardHtml,
  buildRunwaySummaryHtml,
  sortNotamItemsByPriority,
  checkScheduleAgainstWindow,
  nearestAirportsOnRoute,
  loadAirportDb,
  TAF_AIRPORTS,
};
