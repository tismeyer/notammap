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
  "LSZH","LSGG","LFSB","LOWI","LOWW","LOWG",
  "EDDF","EDDM","EDDL","EDDH","EDDB","EDDS","EDDP","EDDV","EDDC","EDDK","EDDN","EDVE",
  "EHAM","EBBR","ELLX","EKCH","EKBI",
  "LFPG","LFPO","LFMN","LFML","LFLL","LFBO","LFRS","LFBD","LFMP",
  "LEMD","LEBL","LEMG","LEAL","LEPA","LEIB","LEVC","LEMH","LEZL",
  "GCFV","GCLP","GCTS","GCRO","GCRR",
  "LPPT","LPPR","LPFR",
  "EGLL","EGKK","EGCC","EGPH","EGNX","EICK",
  "LIRF","LIMC","LIME","LIPZ","LIRN","LIRQ","LICJ","LICC","LIRA","LIBD","LIPE","LIEO",
  "LGAV","LGTS","LGRP","LGIR","LGKR","LGKO","LGMK","LGZA","LGKL","LGJT",
  "LTFM","LTAI","LTBA","LTAC",
  "LMML",
  "LCLK","LCPH",
  "LDDU","LDSP","LDZA","LDPL",
  "LYBE","LYPG","LYBT",
  "LWSK","LATI","LKPR",
  "EPWA","EPGD","EPKK",
  "LHBP","LHDC",
  "LZIB","LZKZ",
  "LROP","LRCL","LRTM","LRSB","LRIA",
  "LBSF","LUKK","EVRA","EETN","EYVI",
  "ENGM","ESSA","ESGG","EFHK",
  "UGTB","LLBG","OMDB",
  "LJLJ","EDAH","EDXW",
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
  const alongTrackRad = Math.acos(clamped);

  const routeLengthNm = haversineNm(oLat, oLon, dLat, dLon);
  return {
    crossTrackNm: crossTrackRad * R_EARTH_NM,
    alongTrackNm: alongTrackRad * R_EARTH_NM,
    routeLengthNm,
  };
}

function nearestAirportsOnRoute(originIcao, destIcao, db, n = 6, endpointBufferNm = 30) {
  if (!db[originIcao] || !db[destIcao]) {
    throw new Error(`Missing coordinates for ${originIcao} or ${destIcao}`);
  }
  const [oLat, oLon] = db[originIcao];
  const [dLat, dLon] = db[destIcao];

  const results = [];
  for (const icao of TAF_AIRPORTS) {
    if (icao === originIcao || icao === destIcao) continue;
    if (!db[icao]) continue;
    const [pLat, pLon] = db[icao];
    const { crossTrackNm, alongTrackNm, routeLengthNm } = crossAndAlongTrackNm(oLat, oLon, dLat, dLon, pLat, pLon);
    if (alongTrackNm >= -endpointBufferNm && alongTrackNm <= routeLengthNm + endpointBufferNm) {
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
  LSZH:'ZRH', LSGG:'GVA', LFSB:'BSL', LOWI:'INN', LOWW:'VIE', LOWG:'GRZ',
  EDDF:'FRA', EDDM:'MUC', EDDL:'DUS', EDDH:'HAM', EDDB:'BER', EDDS:'STR',
  EDDP:'LEJ', EDDV:'HAJ', EDDC:'DRS', EDDK:'CGN', EDDN:'NUE', EDVE:'BWE',
  EHAM:'AMS', EBBR:'BRU', ELLX:'LUX', EKCH:'CPH', EKBI:'BLL',
  LFPG:'CDG', LFPO:'ORY', LFMN:'NCE', LFML:'MRS', LFLL:'LYS', LFBO:'TLS',
  LFRS:'NTE', LFBD:'BOD', LFMP:'PGF',
  LEMD:'MAD', LEBL:'BCN', LEMG:'AGP', LEAL:'ALC', LEPA:'PMI', LEIB:'IBZ',
  LEVC:'VLC', LEMH:'MAH', LEZL:'SVQ',
  GCFV:'FUE', GCLP:'LPA', GCTS:'TFS', GCRO:'TFN', GCRR:'ACE',
  LPPT:'LIS', LPPR:'OPO', LPFR:'FAO',
  EGLL:'LHR', EGKK:'LGW', EGCC:'MAN', EGPH:'EDI', EGNX:'EMA', EICK:'ORK',
  LIRF:'FCO', LIMC:'MXP', LIME:'BGY', LIPZ:'VCE', LIRN:'NAP', LIRQ:'FLR',
  LICJ:'PMO', LICC:'CTA', LIRA:'CIA', LIBD:'BRI', LIPE:'BLQ', LIEO:'AHO',
  LGAV:'ATH', LGTS:'SKG', LGRP:'RHO', LGIR:'HER', LGKR:'CFU', LGKO:'KGS',
  LGMK:'JMK', LGZA:'ZTH', LGKL:'KLX', LGJT:'JTR', // LGJT/LGKL: best-effort, verify with NOTAM_DEBUG
  LTFM:'IST', LTAI:'AYT', LTBA:'ISL', LTAC:'ESB',
  LMML:'MLA',
  LCLK:'LCA', LCPH:'PFO',
  LDDU:'DBV', LDSP:'SPU', LDZA:'ZAG', LDPL:'PUY',
  LYBE:'BEG', LYPG:'TGD', LYBT:'TIV',
  LWSK:'SKP', LATI:'TIA', LKPR:'PRG',
  EPWA:'WAW', EPGD:'GDN', EPKK:'KRK',
  LHBP:'BUD', LHDC:'DEB',
  LZIB:'BTS', LZKZ:'KSC',
  LROP:'OTP', LRCL:'CLJ', LRTM:'TGM', LRSB:'SBZ', LRIA:'IAS',
  LBSF:'SOF', LUKK:'KIV',
  EVRA:'RIX', EETN:'TLL', EYVI:'VNO',
  ENGM:'OSL', ESSA:'ARN', ESGG:'GOT', EFHK:'HEL',
  UGTB:'TBS', LLBG:'TLV', OMDB:'DXB',
  LJLJ:'LJU',
  EDAH:'HDF', EDXW:'', // EDXW: no scheduled-service IATA code — falls back to ICAO
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
const ALERT_CATEGORIES = [
  {
    label: 'Runway/movement area closed',
    patterns: [
      /q\)[a-z]{4}\/q(mrlc|mxlc|falc|mnlc)/i, // MR/MX/FA/MN + LC (closed)
      /rwy.{0,10}\bclsd\b/i,
      /runway.{0,15}closed/i,
    ],
  },
  {
    label: 'ILS/navaid unserviceable',
    patterns: [
      /q\)[a-z]{4}\/qi[cdgl]as/i, // IC/ID/IG/IL + AS (unserviceable)
      /\bils\b.{0,25}(u\/s|unserviceable|unavailable)/i,
      /glide ?path.{0,20}(u\/s|unserviceable)/i,
      /localizer.{0,20}(u\/s|unserviceable)/i,
    ],
  },
  {
    label: 'Approach minima / DA-DH changed',
    patterns: [
      /q\)[a-z]{4}\/qpich/i, // PI + CH (instrument approach procedure changed)
      /q\)[a-z]{4}\/qpoch/i, // PO + CH (OCA/OCH changed)
      /\b(da|dh|oca|och)\b.{0,25}(chang|increas|revis)/i,
      /minima.{0,25}(chang|increas|revis)/i,
    ],
  },
];

function isActive(notam, now = new Date()) {
  const start = new Date(notam.startdateutc);
  const end = notam.enddateutc === 'perm' ? new Date('2099-01-01') : new Date(notam.enddateutc);
  return start <= now && end >= now;
}

// Returns the matching category label, or null if the NOTAM doesn't match
// any of the categories we care about for the briefing.
function categorize(notam) {
  const text = (notam.condition || '').toLowerCase();
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
        const cond = f.condition.length > 150 ? f.condition.slice(0, 150) + '…' : f.condition;
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
        const cond = f.condition.length > 150 ? f.condition.slice(0, 150) + '…' : f.condition;
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
        const cond = f.condition.length > 150 ? f.condition.slice(0, 150) + '…' : f.condition;
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
// Returns the three boolean flags plus the matching NOTAM items for one
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

// Turns a raw NOTAM item ({ category, number, condition }) into a
// structured object ready for card-style display: parsed validity window,
// optional recurring schedule, extracted runway, and a clean description.
function parseNotamItem(item) {
  const fields = parseNotamFields(item.condition || '');
  let description = (fields.e || '').trim();
  if (description) {
    description = description.charAt(0).toUpperCase() + description.slice(1);
  }
  return {
    category: item.category,
    number: item.number,
    start: parseNotamDate(fields.b),
    end: parseNotamDate(fields.c),
    schedule: fields.d || null,
    runway: extractRunway(item.condition || ''),
    description: description || (item.condition || '').slice(0, 150),
  };
}

// Builds one HTML card for a single parsed NOTAM item, colored by category.
// Meant for a map popup — each active category at an airport gets one card.
// All text is rendered in capitals (text-transform, so underlying data
// stays normal-case for anything that reuses parseNotamItem elsewhere).
function buildNotamCardHtml(icao, item) {
  const parsed = parseNotamItem(item);
  const color = CATEGORY_COLORS[parsed.category] || '#333';
  const runwayHtml = parsed.runway
    ? `<span style="font-size:24px;font-weight:bold;color:${color};margin-left:14px;">${parsed.runway}</span>`
    : '';
  const scheduleHtml = parsed.schedule
    ? `<div style="font-size:11px;color:#888;margin-top:2px;">Active: ${escapeHtml(parsed.schedule)}</div>`
    : '';
  return `
    <div style="border:1px solid #e0e0e0;border-left:4px solid ${color};background:#fafafa;padding:10px 14px;margin-bottom:8px;border-radius:2px;text-transform:uppercase;">
      <div style="display:flex;align-items:baseline;">
        <span style="font-weight:bold;font-size:15px;color:${color};">${icao}</span>
        ${runwayHtml}
      </div>
      <div style="font-weight:bold;color:${color};margin-top:4px;">${escapeHtml(parsed.category)}</div>
      <div style="font-size:11px;color:#777;margin-top:2px;">NOTAM ${escapeHtml(parsed.number)}</div>
      <div style="font-family:monospace;font-size:12px;color:#333;margin-top:4px;">Valid: ${parsed.start} &#8594; ${parsed.end}</div>
      ${scheduleHtml}
      <div style="font-size:12px;color:#222;margin-top:4px;">${escapeHtml(parsed.description)}</div>
    </div>
  `;
}

module.exports = {
  buildNotamHtmlBlock,
  buildNotamHtmlLines,
  buildNotamTextBlock,
  buildNotamBlocks,
  getRouteNotams,
  getAirportNotamStatus,
  parseNotamFields,
  parseNotamItem,
  extractRunway,
  buildNotamCardHtml,
  nearestAirportsOnRoute,
  loadAirportDb,
  TAF_AIRPORTS,
};
