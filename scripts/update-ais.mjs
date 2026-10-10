// Kuai Tracking — daily AIS update.
// Listens to the AISStream.io feed for a few minutes, keeps the latest static data (name, destination, ETA)
// and position of every vessel on the Chile → China lane, and writes data/vessels.json for the app.
//
// Env:
//   AISSTREAM_API_KEY  required (GitHub secret)
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

async function listenLive(statics, positions, apiKey) {
  let count = 0;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.close(); }, LISTEN_MS);
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
    ws.onerror = e => { clearTimeout(timer); reject(new Error(`WebSocket error: ${e.message || 'connection failed'}`)); };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
  });
  if (count === 0) throw new Error('AISStream sent no messages (check the API key).');
  return count;
}

async function replayFixture(file, statics, positions) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  for (const line of lines) collect(JSON.parse(line), statics, positions);
  return lines.length;
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
  } else {
    const key = process.env.AISSTREAM_API_KEY;
    if (!key) throw new Error('AISSTREAM_API_KEY is not set.');
    console.log(`Listening to AISStream for ${LISTEN_MS / 60000} min…`);
    messages = await listenLive(statics, positions, key);
  }

  const stats = L.mergeSnapshot(db, statics, positions, process.env.NOW || now.toISOString(), watch);
  await writeFile(DB_PATH, JSON.stringify(db));
  console.log(`Messages ${messages}, static ${statics.size}, positions ${positions.size}; ` +
    `vessels added ${stats.added}, updated ${stats.updated}, total ${stats.total}.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
