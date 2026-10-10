// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const DAY = 86400000;

test('parses free-text AIS destinations', () => {
  assert.equal(L.parseDestination('CN SHA').port, 'SHANGHAI');
  assert.equal(L.parseDestination('CLSAI>CNSHA').port, 'SHANGHAI');
  assert.equal(L.parseDestination('CNNSA').port, 'NANSHA');
  assert.equal(L.parseDestination('YANTIAN').port, 'SHENZHEN');
  assert.equal(L.parseDestination('HK HKG').port, 'HONGKONG');
  assert.equal(L.parseDestination('XINGANG').port, 'TIANJIN');
  assert.equal(L.parseDestination('CNSHA>CLSAI').chile, true);
  assert.equal(L.parseDestination('ROTTERDAM').port, null);
});

test('infers the ETA year', () => {
  assert.equal(L.inferEta({ Month: 1, Day: 5, Hour: 8, Minute: 0 }, '2026-12-10T00:00:00Z'), '2027-01-05T08:00:00.000Z');
  assert.equal(L.inferEta({ Month: 11, Day: 20, Hour: 24, Minute: 60 }, '2026-10-10T00:00:00Z'), '2026-11-20T12:00:00.000Z');
  assert.equal(L.inferEta({ Month: 0, Day: 0 }, '2026-10-10T00:00:00Z'), null);
});

test('carrier links from BL / container', () => {
  assert.equal(L.detectCarrier('MSKU1234567'), 'MAERSK');
  assert.equal(L.detectCarrier('medu 123'), 'MSC');
  assert.equal(L.detectCarrier('CMDU ABC123'), 'CMACGM');
  assert.match(L.trackingUrl('MAEU 123456789'), /maersk\.com\/tracking\/MAEU123456789$/);
  assert.equal(L.trackingUrl('XXXX1'), null);
  assert.match(L.trackingUrl('XXXX1', 'MSC'), /msc\.com/);
});

// Simulate daily runs of the job over a full voyage.
const msg = (type, mmsi, time, body, name = 'MAERSK TEST') => JSON.stringify({
  MessageType: type, MetaData: { MMSI: mmsi, ShipName: name, time_utc: `${time.replace('T', ' ').replace('Z', '')}.000 +0000 UTC` },
  Message: { [type]: body }
});
const stat = (mmsi, time, dest, eta, name = 'MAERSK TEST', type = 71) => msg('ShipStaticData', mmsi, time,
  { Name: name, ImoNumber: 9000001, CallSign: 'ABC', Destination: dest, Eta: eta, Type: type, Dimension: { A: 200, B: 100, C: 20, D: 20 } }, name);
const pos = (mmsi, time, lat, lon, sog, nav = 0) => msg('PositionReport', mmsi, time,
  { Latitude: lat, Longitude: lon, Sog: sog, Cog: 270, NavigationalStatus: nav });

test('daily job tracks a voyage end to end', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kuai-'));
  writeFileSync(path.join(dir, 'vessels.json'), JSON.stringify({ updatedAt: null, vessels: {} }));
  writeFileSync(path.join(dir, 'watchlist.json'), '[]');
  const run = (now, lines) => {
    const f = path.join(dir, 'fx.jsonl');
    writeFileSync(f, lines.join('\n'));
    execFileSync('node', ['scripts/update-ais.mjs'], { env: { ...process.env, DATA_DIR: dir, AIS_FIXTURE: f, NOW: now } });
    return JSON.parse(readFileSync(path.join(dir, 'vessels.json'), 'utf8'));
  };
  const eta1 = { Month: 11, Day: 20, Hour: 10, Minute: 0 };
  const eta2 = { Month: 11, Day: 24, Hour: 10, Minute: 0 };

  // Day 1: loading in San Antonio. A ferry near Europe is ignored.
  let db = run('2026-10-10T09:10:00Z', [
    stat(111, '2026-10-10T09:01:00Z', 'CNSHA', eta1), pos(111, '2026-10-10T09:02:00Z', -33.59, -71.62, 0, 5),
    stat(222, '2026-10-10T09:01:00Z', 'DOVER', eta1, 'FERRY', 60), pos(222, '2026-10-10T09:02:00Z', 51, 1.3, 15)
  ]);
  assert.deepEqual(Object.keys(db.vessels), ['111']);
  let v = db.vessels['111'];
  assert.equal(v.voyage.port, 'SHANGHAI');
  assert.equal(v.voyage.firstEta, '2026-11-20T10:00:00.000Z');
  assert.equal(v.voyage.departedAt, null);
  let st = L.computeStatus({ id: '111', mmsi: 111 }, v, Date.parse('2026-10-10T12:00:00Z'));
  assert.equal(st.state, 'origin');

  // Day 2: sailed. Departure estimated from last time seen on the Chilean coast.
  db = run('2026-10-11T09:10:00Z', [pos(111, '2026-10-11T09:02:00Z', -31.5, -78.0, 17)]);
  v = db.vessels['111'];
  assert.equal(v.voyage.departedAt, '2026-10-10T09:02:00.000Z');
  assert.equal(v.voyage.departedEstimated, true);

  // Day 20: ETA slips 4 days.
  db = run('2026-10-30T09:10:00Z', [stat(111, '2026-10-30T09:00:00Z', 'CN SHA', eta2), pos(111, '2026-10-30T09:00:00Z', 10, -170, 16)]);
  v = db.vessels['111'];
  assert.equal(v.eta, '2026-11-24T10:00:00.000Z');
  const saved = { id: '111', mmsi: 111, name: 'MAERSK TEST', originalEta: '2026-11-20T10:00:00.000Z' };
  st = L.computeStatus(saved, v, Date.parse('2026-10-30T12:00:00Z'), 3);
  assert.equal(st.state, 'transit');
  assert.equal(st.delayDays, 4);
  assert.equal(st.daysLeft, 25);
  assert.ok(st.progress > 0.4 && st.progress < 0.5, `progress ${st.progress}`);
  // Not seen for 5 days -> stale.
  st = L.computeStatus(saved, v, Date.parse('2026-11-04T12:00:00Z'), 3);
  assert.equal(st.stale, true);

  // Alerts: first pass only records the ETA, a later change notifies, stale notifies once.
  const memo = { 'lastEta:111': '2026-11-20' };
  let alerts = L.pendingAlerts([saved], db, memo, { staleDays: 3 }, Date.parse('2026-11-04T12:00:00Z'));
  assert.deepEqual(alerts.map(a => a.title), ['MAERSK TEST: new ETA 24 Nov', 'MAERSK TEST: no AIS update']);
  assert.match(alerts[0].body, /4 days delayed/);
  alerts = L.pendingAlerts([saved], db, memo, { staleDays: 3 }, Date.parse('2026-11-04T12:00:00Z'));
  assert.equal(alerts.length, 0);

  // Day 45: anchored off Yangshan -> arrived.
  db = run('2026-11-24T09:10:00Z', [pos(111, '2026-11-24T08:00:00Z', 30.6, 122.1, 0.3, 1)]);
  v = db.vessels['111'];
  assert.equal(v.voyage.arrivedAt, '2026-11-24T08:00:00.000Z');
  st = L.computeStatus(saved, v, Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(st.state, 'arrived');
  assert.equal(st.progress, 1);
  alerts = L.pendingAlerts([saved], db, memo, { staleDays: 3 }, Date.parse('2026-11-25T12:00:00Z'));
  assert.equal(alerts[0].title, 'MAERSK TEST ARRIVED');

  // Next voyage: back in Chile with a new China destination starts a fresh voyage.
  db = run('2026-12-30T09:10:00Z', [stat(111, '2026-12-30T09:00:00Z', 'CLSAI>CNNSA', { Month: 2, Day: 5, Hour: 0, Minute: 0 }),
    pos(111, '2026-12-30T09:00:00Z', -33.6, -71.6, 0, 5)]);
  v = db.vessels['111'];
  assert.equal(v.voyage.port, 'NANSHA');
  assert.equal(v.voyage.arrivedAt, null);
  assert.equal(v.voyage.firstEta, '2027-02-05T00:00:00.000Z');
});

test('time guard skips runs before 6 AM Chile or twice a day', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kuai-'));
  const today = new Date().toISOString();
  writeFileSync(path.join(dir, 'vessels.json'), JSON.stringify({ updatedAt: today, vessels: {} }));
  const out = execFileSync('node', ['scripts/update-ais.mjs'], { env: { ...process.env, DATA_DIR: dir, AISSTREAM_API_KEY: '', FORCE: '' } }).toString();
  assert.match(out, /Skipping/);
});
