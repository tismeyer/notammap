'use strict';

/**
 * notam-map-server.js
 * --------------------
 * Small Express service that refreshes NOTAM status for all TAF_AIRPORTS
 * on a fixed schedule (0100/0500/0900/1300/1700/2100 UTC — 6 calls/day per
 * airport, not per viewer) and serves the cached result as one JSON blob.
 *
 * The map (client-side HTML/D3) makes ONE request to GET /notam-map/data
 * regardless of how many people are viewing it or how often they reload —
 * all the actual Aviation Edge calls happen here, on the schedule below.
 *
 * Deploy this alongside your other Railway services. Needs:
 *   - notam-alternates.js in the same folder
 *   - AVIATION_EDGE_API_KEY set as a Railway environment variable
 */

const express = require('express');
const cron = require('node-cron');
const { TAF_AIRPORTS, getAirportNotamStatus, loadAirportDb } = require('./notam-alternates');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — the TAFMap page fetches this from a different origin, so the
// response needs Access-Control-Allow-Origin or the browser blocks it
// silently (no error thrown client-side, it just looks like empty data).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

// In-memory cache: { updatedAt, airports: { ICAO: {lat, lon, runwayClosed, ilsUs, minimaChanged, items} } }
let cache = { updatedAt: null, airports: {} };

async function refreshAll() {
  console.log(`[notam-map] Refresh starting for ${TAF_AIRPORTS.length} airports…`);
  const db = await loadAirportDb();
  const results = {};

  // Run sequentially in small batches to stay polite to the API rather than
  // firing 121 requests simultaneously.
  const BATCH_SIZE = 10;
  for (let i = 0; i < TAF_AIRPORTS.length; i += BATCH_SIZE) {
    const batch = TAF_AIRPORTS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (icao) => {
        try {
          const status = await getAirportNotamStatus(icao);
          const coords = db[icao];
          return {
            icao,
            lat: coords ? coords[0] : null,
            lon: coords ? coords[1] : null,
            ...status,
          };
        } catch (e) {
          console.warn(`[notam-map] Failed for ${icao}: ${e.message}`);
          return null;
        }
      })
    );
    for (const r of batchResults) {
      if (r) results[r.icao] = r;
    }
  }

  cache = { updatedAt: new Date().toISOString(), airports: results };
  console.log(`[notam-map] Refresh complete: ${Object.keys(results).length}/${TAF_AIRPORTS.length} airports updated`);
}

// Schedule: 0100, 0500, 0900, 1300, 1700, 2100 UTC
cron.schedule('0 1,5,9,13,17,21 * * *', () => {
  console.log('[notam-map] ⏰ Scheduled refresh triggered');
  refreshAll().catch((e) => console.error('[notam-map] Refresh failed:', e.message));
}, { timezone: 'UTC' });

// Refresh once on startup so the cache isn't empty while waiting for the
// next scheduled slot.
refreshAll().catch((e) => console.error('[notam-map] Initial refresh failed:', e.message));

// --- Routes ------------------------------------------------------------
app.get('/notam-map/data', (req, res) => {
  res.json(cache);
});

// Manual trigger for testing, mirrors the pattern used in your other tools
// (e.g. GET /fr24-briefing/run?date=...).
app.get('/notam-map/refresh', async (req, res) => {
  try {
    await refreshAll();
    res.json({ ok: true, updatedAt: cache.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[notam-map] Server listening on port ${PORT}`);
  console.log('[notam-map] Scheduled refreshes: 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 UTC');
});
