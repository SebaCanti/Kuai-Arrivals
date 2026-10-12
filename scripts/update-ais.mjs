// Kuai Tracking — daily AIS update.
// Listens to the AISStream.io feed for a few minutes, keeps the latest static data (name, destination, ETA)
// and position of every vessel on the Chile → China lane, and writes data/vessels.json for the app.
//
// Env:
//   AISSTREAM_API_KEY  AISStream.io key (free). Feeds the searchable vessel list.
//   VESSELFINDER_API_KEY  optional, paid. Satellite + terrestrial positions and ETA for the vessels in
//                      data/watchlist.json; whichever source has the newest data wins.
//   VF_FIXTURE=path    use a saved VesselFinder JSON response instead of calling the API (tests)
//   LISTEN_MINUTES     how long to listen (default 20)
//   FORCE=1            skip the "6 AM Chile time, once a day" guard (manual runs)
//   AIS_FIXTURE=path   replay a JSON-lines file of AISStream messages instead of connecting (tests)
//   DATA_DIR           where vessels.json / watchlist.json live (default ./data)
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const L = require('../js/logic.js');

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'vessels.json');
const WATCH_PATH = path.join(DATA_DIR, 'watchlist.json');
const LISTEN_MS = Number(process.env.LISTEN_MINUTES || 20) * 60000;

function santiago(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

// AISStream timestamps look like "2026-10-10 09:12:01.123456789 +0000 UTC".
function aisTime(meta) {
  const t = meta && meta.time_utc;
  if (!t) return new Date().toISOString();
  const m = t.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}Z`).toISOString() : new Date().toISOString();
}

function collect(msg, statics, positions) {
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;
  if (msg.MessageType === 'ShipStaticData') {
    const s = msg.Message.ShipStaticData;
    if (s) statics.set(mmsi, { ...s, _time: aisTime(meta) });
  } else if (msg.MessageType === 'PositionReport') {
    const p = msg.Message.PositionReport;
    if (p && Math.abs(p.Latitude) <= 90 && Math.abs(p.Longitude) <= 180) {
      positions.set(mmsi, { ...p, ShipName: meta.ShipName, _time: aisTime(meta) });
    }
  }
}

// One websocket session. Resolves with the number of messages when the server closes it or `ms` runs out.
function listenOnce(statics, positions, apiKey, ms) {
  let count = 0;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.close(); }, ms);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['ShipStaticData', 'PositionReport']
      }));
    };
    ws.onmessage = ev => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.error) { clearTimeout(timer); ws.close(); reject(new Error(`AISStream: ${msg.error}`)); return; }
      count++;
      collect(msg, statics, positions);
    };
    ws.onerror = e => {
      clearTimeout(timer);
      if (count) resolve(count); // dropped mid-stream: keep what we got and reconnect
      else reject(new Error(`WebSocket error: ${e.message || 'connection failed'}`));
    };
    ws.onclose = () => { clearTimeout(timer); resolve(count); };
  });
}

// AISStream drops long connections now and then, so reconnect until the listening time is used up.
async function listenLive(statics, positions, apiKey) {
  const deadline = Date.now() + LISTEN_MS;
  let total = 0, sessions = 0;
  while (Date.now() < deadline - 15000 && sessions < 15) {
    sessions++;
    try {
      total += await listenOnce(statics, positions, apiKey, deadline - Date.now());
    } catch (e) {
      if (/AISStream:/.test(e.message) || (sessions === 1 && total === 0)) throw e;
      console.log(`Connection ${sessions} failed (${e.message}), retrying…`);
    }
    if (Date.now() < deadline - 15000) {
      console.log(`Connection ${sessions} closed after ${total} messages, reconnecting…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  if (total === 0) throw new Error('AISStream sent no messages (check the API key).');
  return total;
}

async function replayFixture(file, statics, positions) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  for (const line of lines) collect(JSON.parse(line), statics, positions);
  return lines.length;
}

// ── VESSELFINDER ──
// Docs: https://api.vesselfinder.com/docs/vessels.html  (1 credit per terrestrial position, 10 per satellite)
const vfTime = t => (t ? new Date(t.replace(' UTC', 'Z').replace(' ', 'T')).toISOString() : null);

function vfRecords(json) {
  return (Array.isArray(json) ? json : []).map(row => row && row.AIS).filter(Boolean).map(a => ({
    mmsi: a.MMSI, imo: a.IMO || null, name: (a.NAME || '').trim(),
    lat: a.LATITUDE, lon: a.LONGITUDE, sog: a.SPEED, cog: a.COURSE, navStatus: a.NAVSTAT,
    posAt: vfTime(a.TIMESTAMP), dest: (a.DESTINATION || '').trim(),
    eta: a.ETA ? vfTime(a.ETA.length === 19 ? a.ETA + ' UTC' : a.ETA) : null,
    source: a.SRC === 'SAT' ? 'VesselFinder (satellite)' : 'VesselFinder'
  }));
}

// Watchlist entries can be IMO (7 digits), MMSI (9 digits) or a vessel name found in the AIS data.
function resolveWatchlist(watch, db) {
  const imo = new Set(), mmsi = new Set();
  const byName = {};
  for (const v of Object.values(db.vessels || {})) byName[L.compact(v.name)] = v;
  for (const w of watch) {
    const c = L.compact(w);
    if (/^\d{7}$/.test(c)) imo.add(c);
    else if (/^\d{9}$/.test(c)) mmsi.add(c);
    else if (byName[c]) byName[c].imo ? imo.add(String(byName[c].imo)) : mmsi.add(String(byName[c].mmsi));
    else console.log(`Watchlist: "${w}" not found in AIS data yet (use its IMO number).`);
  }
  return { imo: [...imo], mmsi: [...mmsi] };
}

async function fetchVesselFinder(key, ids) {
  if (process.env.VF_FIXTURE) return vfRecords(JSON.parse(await readFile(process.env.VF_FIXTURE, 'utf8')));
  const out = [];
  const chunk = (a, n) => a.length ? [a.slice(0, n), ...chunk(a.slice(n), n)] : [];
  const batches = [...chunk(ids.imo, 50).map(b => `imo=${b.join(',')}`), ...chunk(ids.mmsi, 50).map(b => `mmsi=${b.join(',')}`)];
  for (const q of batches) {
    const res = await fetch(`https://api.vesselfinder.com/vessels?userkey=${encodeURIComponent(key)}&sat=1&${q}`);
    const body = await res.text();
    if (!res.ok) throw new Error(`VesselFinder HTTP ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    if (json && json.error) throw new Error(`VesselFinder: ${json.error}`);
    out.push(...vfRecords(json));
  }
  return out;
}

async function main() {
  const now = new Date();
  const db = await readJson(DB_PATH, { updatedAt: null, vessels: {} });

  if (!process.env.FORCE && !process.env.AIS_FIXTURE) {
    const local = santiago(now);
    const last = db.updatedAt ? santiago(new Date(db.updatedAt)).day : null;
    if (local.hour < 6 || last === local.day) {
      console.log(`Skipping: Santiago ${local.day} ${local.hour}h, last update ${last}.`);
      return;
    }
  }

  const watch = await readJson(WATCH_PATH, []);
  const statics = new Map(), positions = new Map();
  let messages;
  if (process.env.AIS_FIXTURE) {
    messages = await replayFixture(process.env.AIS_FIXTURE, statics, positions);
  } else if (process.env.AISSTREAM_API_KEY) {
    console.log(`Listening to AISStream for ${LISTEN_MS / 60000} min…`);
    messages = await listenLive(statics, positions, process.env.AISSTREAM_API_KEY);
  } else if (!process.env.VESSELFINDER_API_KEY) {
    throw new Error('Set AISSTREAM_API_KEY and/or VESSELFINDER_API_KEY.');
  }

  if (positions.size) {
    let chile = 0, china = 0;
    for (const p of positions.values()) {
      if (L.inChile(p.Latitude, p.Longitude)) chile++;
      if (p.Latitude > 18 && p.Latitude < 42 && p.Longitude > 108 && p.Longitude < 126) china++;
    }
    console.log(`Coverage: ${chile} vessels heard on the Chilean coast, ${china} on the China coast.`);
  }

  const nowIso = process.env.NOW || now.toISOString();
  const stats = L.mergeSnapshot(db, statics, positions, nowIso, watch);
  console.log(`AISStream: messages ${messages || 0}, static ${statics.size}, positions ${positions.size}; ` +
    `vessels added ${stats.added}, updated ${stats.updated}, total ${stats.total}.`);

  // A VesselFinder failure (no credits, bad key) must not lose the AISStream update.
  if (process.env.VESSELFINDER_API_KEY || process.env.VF_FIXTURE) {
    try {
      const ids = resolveWatchlist(watch, db);
      if (ids.imo.length + ids.mmsi.length) {
        const recs = await fetchVesselFinder(process.env.VESSELFINDER_API_KEY, ids);
        const used = L.mergeExternal(db, recs, nowIso);
        console.log(`VesselFinder: ${recs.length} vessels returned, ${used} newer than AISStream.`);
      } else console.log('VesselFinder: watchlist is empty, nothing to ask for.');
    } catch (e) {
      console.error(`VesselFinder skipped: ${e.message}`);
      process.exitCode = 0;
    }
  }

  db.updatedAt = nowIso;
  await writeFile(DB_PATH, JSON.stringify(db));
}

main().catch(err => { console.error(err.message); process.exit(1); });
