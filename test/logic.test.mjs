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
const stat = (mmsi, time, dest, eta, name = 'MAERSK TEST', type = 71, len = 300) => msg('ShipStaticData', mmsi, time,
  { Name: name, ImoNumber: 9000001, CallSign: 'ABC', Destination: dest, Eta: eta, Type: type, Dimension: { A: len - 100, B: 100, C: 20, D: 20 } }, name);
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

  // Day 1: loading in San Antonio. A small ferry near Europe is ignored.
  let db = run('2026-10-10T09:10:00Z', [
    stat(111, '2026-10-10T09:01:00Z', 'CNSHA', eta1), pos(111, '2026-10-10T09:02:00Z', -33.59, -71.62, 0, 5),
    stat(222, '2026-10-10T09:01:00Z', 'DOVER', eta1, 'FERRY', 60, 120), pos(222, '2026-10-10T09:02:00Z', 51, 1.3, 15)
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

test('carrier from vessel name', () => {
  assert.equal(L.carrierFromName('MAERSK SKARSTIND'), 'MAERSK');
  assert.equal(L.carrierFromName('MSC CHERRY'), 'MSC');
  assert.equal(L.carrierFromName('EVER GIVEN'), 'EVERGREEN');
  assert.equal(L.carrierFromName('ONEGA STAR'), null);
  assert.equal(L.carrierFromName('RIO BLANCO'), null);
});

test('VesselFinder fills the gap mid-ocean and the freshest source wins', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kuai-'));
  const old = { mmsi: 111, name: 'MAERSK TEST', imo: 9000001, dest: 'CNSHA', destPort: 'SHANGHAI', eta: '2026-11-20T10:00:00.000Z',
    lat: -31.5, lon: -78, sog: 17, posAt: '2026-10-11T09:02:00.000Z', posSource: 'AISStream', staticAt: '2026-10-10T09:01:00.000Z',
    lastChileAt: '2026-10-10T09:02:00.000Z', lastSeen: '2026-10-11T09:02:00.000Z', etaHistory: [{ eta: '2026-11-20T10:00:00.000Z' }],
    voyage: { port: 'SHANGHAI', firstEta: '2026-11-20T10:00:00.000Z', departedAt: '2026-10-10T09:02:00.000Z', arrivedAt: null } };
  writeFileSync(path.join(dir, 'vessels.json'), JSON.stringify({ updatedAt: '2026-10-11T09:10:00Z', vessels: { 111: old } }));
  writeFileSync(path.join(dir, 'watchlist.json'), JSON.stringify(['MAERSK TEST', '9999999']));
  const vf = [
    { AIS: { MMSI: 111, IMO: 9000001, NAME: 'MAERSK TEST', TIMESTAMP: '2026-10-29 22:15:00 UTC', LATITUDE: 12.5, LONGITUDE: -165.2,
      SPEED: 16.1, COURSE: 290, NAVSTAT: 0, DESTINATION: 'CN SHA', ETA: '2026-11-23 06:00:00', SRC: 'SAT' } },
    // An older position than ours for another vessel must not be invented as China-bound data newer than nothing:
    { AIS: { MMSI: 999, IMO: 9999999, NAME: 'OTHER', TIMESTAMP: '2026-10-29 10:00:00 UTC', LATITUDE: 22.3, LONGITUDE: 114.1,
      SPEED: 0.1, NAVSTAT: 5, DESTINATION: 'HKHKG', ETA: '2026-10-29 08:00:00', SRC: 'TER' } }
  ];
  const f = path.join(dir, 'vf.json');
  writeFileSync(f, JSON.stringify(vf));
  const empty = path.join(dir, 'empty.jsonl');
  writeFileSync(empty, '');
  const out = execFileSync('node', ['scripts/update-ais.mjs'], { env: { ...process.env, DATA_DIR: dir, AIS_FIXTURE: empty, VF_FIXTURE: f, NOW: '2026-10-30T09:10:00Z' } }).toString();
  assert.match(out, /VesselFinder: 2 vessels returned, 2 newer/);
  const db = JSON.parse(readFileSync(path.join(dir, 'vessels.json'), 'utf8'));
  const v = db.vessels['111'];
  assert.equal(v.posSource, 'VesselFinder (satellite)');
  assert.equal(v.lat, 12.5);
  assert.equal(v.eta, '2026-11-23T06:00:00.000Z');
  assert.equal(v.voyage.firstEta, '2026-11-20T10:00:00.000Z');
  assert.equal(db.vessels['999'].voyage.arrivedAt, '2026-10-29T10:00:00.000Z');

  // Older data does not overwrite newer data.
  assert.equal(L.mergeExternal(db, [{ mmsi: 111, name: 'MAERSK TEST', lat: 0, lon: 0, posAt: '2026-10-20T00:00:00.000Z', dest: 'X', source: 'VesselFinder' }], '2026-10-30T09:10:00Z'), 0);
  assert.equal(db.vessels['111'].lat, 12.5);

  // Stale alert names the carrier.
  const alerts = L.pendingAlerts([{ id: '111', mmsi: 111, name: 'MAERSK TEST' }], db, {}, { staleDays: 3 }, Date.parse('2026-11-03T12:00:00Z'));
  assert.match(alerts.find(a => a.tag.startsWith('stale')).body, /Maersk website/);
});

test('CSV import: Spanish headers, semicolons, Chilean dates', () => {
  const csv = '﻿Nave;Fecha Zarpe;IMO;Contenedor;Destino\nYM Fountain;05/10/2026;9278090;YMLU1234567;Nansha\n"MSC CHERRY, QUEEN";2026-09-10;;;CNSHA\nBAD SHIP;31/02/2026;;;\n';
  const { rows, errors } = L.parseVesselCsv(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: 'YM FOUNTAIN', departed: '2026-10-05T12:00:00.000Z', imo: 9278090, bls: ['YMLU1234567'], port: 'NANSHA', eta: null });
  assert.equal(rows[1].name, 'MSC CHERRY, QUEEN');
  assert.equal(rows[1].port, 'SHANGHAI');
  assert.equal(rows[2].departed, null);
  assert.equal(errors.length, 1);
});

test('CSV import: English headers, commas, month names', () => {
  const { rows } = L.parseVesselCsv('Vessel,Departure,ETA\nMaersk Skarstind,12-Oct-2026,20 Nov 2026\n');
  assert.equal(rows[0].departed, '2026-10-12T12:00:00.000Z');
  assert.equal(rows[0].eta, '2026-11-20T12:00:00.000Z');
});

test('CSV import: template columns, ETA from "Fecha destino", several containers', () => {
  const csv = 'Nave;Fecha Zarpe;Fecha destino;Contenedor;Puerto destino\nYM FOUNTAIN;05/10/2026;14/11/2026;YMLU1234567 / YMLU7654321;Shanghai\nYM FOUNTAIN;05/10/2026;14/11/2026;TGHU1111111;Shanghai\n';
  const { rows } = L.parseVesselCsv(csv);
  assert.equal(rows[0].eta, '2026-11-14T12:00:00.000Z');
  assert.equal(rows[0].port, 'SHANGHAI');
  assert.deepEqual(rows[0].bls, ['YMLU1234567', 'YMLU7654321']);
  assert.deepEqual(rows[1].bls, ['TGHU1111111']);
});

test('a big ship with an odd or empty destination is still kept', () => {
  const db = { vessels: {} };
  const statics = new Map([['333', { Name: 'ODD DEST', Type: 0, Destination: '', Dimension: { A: 150, B: 50 } }],
    ['444', { Name: 'SMALL TUG', Type: 52, Destination: '', Dimension: { A: 20, B: 10 } }]]);
  L.mergeSnapshot(db, statics, new Map(), '2026-10-12T09:00:00Z', []);
  assert.deepEqual(Object.keys(db.vessels), ['333']);
});

// DCSA Track & Trace events as carriers (Maersk) return them: San Antonio → Shanghai.
const dcsa = [
  { eventType: 'TRANSPORT', eventClassifierCode: 'ACT', transportEventTypeCode: 'DEPA', eventDateTime: '2026-10-01T10:00:00Z',
    transportCall: { UNLocationCode: 'CLSAI', vessel: { vesselName: 'MAERSK TEST' } } },
  { eventType: 'TRANSPORT', eventClassifierCode: 'PLN', transportEventTypeCode: 'ARRI', eventDateTime: '2026-11-10T08:00:00Z',
    eventCreatedDateTime: '2026-09-20T00:00:00Z', transportCall: { UNLocationCode: 'CNSHA', vessel: { vesselName: 'MAERSK TEST' } } },
  { eventType: 'TRANSPORT', eventClassifierCode: 'EST', transportEventTypeCode: 'ARRI', eventDateTime: '2026-11-13T08:00:00Z',
    eventCreatedDateTime: '2026-10-10T00:00:00Z', transportCall: { UNLocationCode: 'CNSHA', vessel: { vesselName: 'MAERSK TEST' } } },
  { eventType: 'EQUIPMENT', equipmentEventTypeCode: 'LOAD', eventClassifierCode: 'ACT', eventDateTime: '2026-09-30T10:00:00Z' }
];

test('carrier events give the final port, estimated ETA and departure', () => {
  const info = L.parseCarrierEvents({ events: dcsa }, 'Maersk');
  assert.equal(info.port, 'SHANGHAI');
  assert.equal(info.eta, '2026-11-13T08:00:00.000Z');
  assert.equal(info.arrivedAt, null);
  assert.equal(info.departedAt, '2026-10-01T10:00:00.000Z');
  const arrived = L.parseCarrierEvents([...dcsa, { eventType: 'TRANSPORT', eventClassifierCode: 'ACT', transportEventTypeCode: 'ARRI',
    eventDateTime: '2026-11-14T02:00:00Z', transportCall: { UNLocationCode: 'CNSHA' } }], 'Maersk');
  assert.equal(arrived.arrivedAt, '2026-11-14T02:00:00.000Z');
});

test('carrier ETA wins over AIS and an older manual ETA, not over a newer one', () => {
  const carrierInfo = { source: 'Maersk', eta: '2026-11-13T08:00:00.000Z', port: 'SHANGHAI', at: '2026-10-12T10:00:00Z' };
  const base = { name: 'MAERSK TEST', originalEta: '2026-11-10T12:00:00.000Z', carrierInfo };
  const now = Date.parse('2026-10-12T12:00:00Z');
  let st = L.computeStatus(Object.assign({}, base, { etaManual: '2026-11-10T12:00:00.000Z', etaManualAt: '2026-10-01T00:00:00Z' }), null, now, 3);
  assert.equal(st.eta, '2026-11-13T08:00:00.000Z');
  assert.equal(st.etaSource, 'Maersk');
  assert.equal(st.delayDays, 3);
  assert.equal(st.stale, false);
  st = L.computeStatus(Object.assign({}, base, { etaManual: '2026-11-20T12:00:00.000Z', etaManualAt: '2026-10-12T11:00:00Z' }), null, now, 3);
  assert.equal(st.eta, '2026-11-20T12:00:00.000Z');
});

test('the hourly job turns the private container list into ETAs per vessel, without printing containers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kuai-'));
  writeFileSync(path.join(dir, 'vessels.json'), JSON.stringify({ updatedAt: null, vessels: {} }));
  writeFileSync(path.join(dir, 'watchlist.json'), '[]');
  writeFileSync(path.join(dir, 'fx.jsonl'), '');
  writeFileSync(path.join(dir, 'maersk.json'), JSON.stringify(dcsa));
  const log = execFileSync('node', ['scripts/update-ais.mjs'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir,
    AIS_FIXTURE: path.join(dir, 'fx.jsonl'), CARRIER_FIXTURE: path.join(dir, 'maersk.json'), NOW: '2026-10-12T10:00:00Z',
    KUAI_CONTAINERS: 'MSKU1234567;Maersk Test\nMSCU7654321;MSC OTHER\njunk line' } });
  const db = JSON.parse(readFileSync(path.join(dir, 'vessels.json'), 'utf8'));
  assert.equal(db.carrier.MAERSKTEST.eta, '2026-11-13T08:00:00.000Z');
  assert.equal(db.carrier.MAERSKTEST.port, 'SHANGHAI');
  assert.ok(!/MSKU|MSCU/.test(log + JSON.stringify(db)));
});
