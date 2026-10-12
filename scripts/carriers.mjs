// Kuai Arrivals — official carrier tracking by container number.
// The container list comes from the KUAI_CONTAINERS repository secret (masked in logs, never public), which the
// owner edits on GitHub. Only the ETA per vessel is published in data/vessels.json, never the container numbers.
// Logs are public on a public repo, so nothing here prints a container number.
//
// Env:
//   KUAI_CONTAINERS        one container per line, "MSKU1234567;MAERSK HORSBURGH" (tab or comma also work)
//   MAERSK_CONSUMER_KEY    Maersk developer portal app key (free)
//   MAERSK_CLIENT_SECRET   optional, when the Maersk app also issues a secret (OAuth client credentials)
//   CARRIER_FIXTURE=path   use a saved response for every container instead of calling the API (tests)
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../js/logic.js');

const MAERSK_BASE = 'https://api.maersk.com';

async function maerskToken(key, secret) {
  if (!secret) return null;
  const res = await fetch(`${MAERSK_BASE}/customer-identity/oauth/v2/access_token`, {
    method: 'POST',
    headers: { 'Consumer-Key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: secret })
  });
  if (!res.ok) throw new Error(`Maersk login HTTP ${res.status}`);
  return (await res.json()).access_token || null;
}

async function maerskEvents(container, key, token) {
  const headers = { 'Consumer-Key': key, Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${MAERSK_BASE}/track-and-trace-private/events?equipmentReference=${encodeURIComponent(container)}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.text()).replace(/[A-Z]{4}\d{7}/g, '[container]').slice(0, 200);
    throw new Error(`Maersk HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// "MSKU1234567;MAERSK HORSBURGH" per line → [{ c, v }]. Lines without a container number are skipped.
export function parseContainerList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z]{4}\s*\d{6,7})\s*[;,\t|]\s*(.+)$/);
    if (m) out.push({ c: L.compact(m[1]), v: m[2].trim() });
  }
  return out;
}

// Updates db.carrier ={ [compact vessel name]: { source, eta, arrivedAt, departedAt, port, at } }.
export async function updateCarriers(db, nowIso) {
  let list = [];
  list = parseContainerList(process.env.KUAI_CONTAINERS || '');
  list = (Array.isArray(list) ? list : []).filter(x => x && x.c && x.v);
  const out = db.carrier || {};
  const wanted = new Set(list.map(x => L.compact(x.v)));
  for (const k of Object.keys(out)) if (!wanted.has(k)) delete out[k];
  db.carrier = out;
  if (!list.length) { console.log('Carriers: no containers shared from the app yet.'); return; }

  const maersk = list.filter(x => L.detectCarrier(x.c) === 'MAERSK');
  const key = process.env.MAERSK_CONSUMER_KEY;
  console.log(`Carriers: ${list.length} containers shared, ${maersk.length} Maersk.`);
  if (!maersk.length) return;
  if (!key && !process.env.CARRIER_FIXTURE) { console.log('Carriers: MAERSK_CONSUMER_KEY not set, skipping Maersk.'); return; }

  let token = null;
  if (!process.env.CARRIER_FIXTURE) {
    try { token = await maerskToken(key, process.env.MAERSK_CLIENT_SECRET); }
    catch (e) { console.log(`Carriers: ${e.message}; trying with the key only.`); }
  }

  let ok = 0, empty = 0, failed = 0;
  const byVessel = {};
  for (const { c, v } of maersk) {
    try {
      const json = process.env.CARRIER_FIXTURE
        ? JSON.parse(await readFile(process.env.CARRIER_FIXTURE, 'utf8'))
        : await maerskEvents(L.compact(c), key, token);
      const info = json && L.parseCarrierEvents(json, 'Maersk');
      if (!info) { empty++; continue; }
      ok++;
      // Several containers on one vessel: keep the latest ETA (the last one to arrive).
      const k = L.compact(v);
      if (!byVessel[k] || Date.parse(info.eta) > Date.parse(byVessel[k].eta)) byVessel[k] = info;
    } catch (e) {
      failed++;
      if (failed <= 3) console.log(`Carriers: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  for (const [k, info] of Object.entries(byVessel)) {
    out[k] = { source: info.source, eta: info.eta, arrivedAt: info.arrivedAt, departedAt: info.departedAt,
      port: info.port, portCode: info.locode, at: nowIso };
  }
  console.log(`Carriers: Maersk answered for ${ok} containers, ${empty} without events, ${failed} failed.`);
}
