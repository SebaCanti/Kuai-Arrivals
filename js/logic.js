// Kuai Tracking — shared logic (browser app, service worker and the daily AIS job)
// Classic script: exposes self.KuaiLogic in the browser and module.exports in Node.
(function (root) {
  'use strict';

  const DAY = 86400000;

  // ── DESTINATION PORTS (China) ──
  // radiusKm: distance from the port centre at which a slow/stopped vessel counts as arrived.
  const PORTS = {
    SHANGHAI: { name: 'Shanghai',  lat: 30.95, lon: 121.95, radiusKm: 70,
      codes: ['CNSHA', 'SHANGHAI', 'YANGSHAN', 'CNYSA', 'WAIGAOQIAO', 'CNWGQ'] },
    TIANJIN:  { name: 'Tianjin',   lat: 38.97, lon: 117.85, radiusKm: 45,
      codes: ['CNTXG', 'CNTSN', 'TIANJIN', 'XINGANG'] },
    HONGKONG: { name: 'Hong Kong', lat: 22.32, lon: 114.10, radiusKm: 22,
      codes: ['HKHKG', 'HONGKONG', 'HONGKONG'] },
    NANSHA:   { name: 'Nansha',    lat: 22.68, lon: 113.66, radiusKm: 25,
      codes: ['CNNSA', 'NANSHA', 'CNCAN', 'GUANGZHOU'] },
    SHENZHEN: { name: 'Shenzhen',  lat: 22.52, lon: 114.08, radiusKm: 28,
      codes: ['CNSZX', 'SHENZHEN', 'YANTIAN', 'CNYTN', 'SHEKOU', 'CNSHK', 'CHIWAN', 'CNCWN', 'DACHAN', 'CNDCB'] }
  };

  // Chilean loading ports (used to recognise vessels on the lane before they sail).
  const CHILE_CODES = ['CLSAI', 'SANANTONIO', 'CLVAP', 'VALPARAISO', 'CLCNL', 'CORONEL', 'CLLQN', 'LIRQUEN',
    'CLSVE', 'SANVICENTE', 'CLTAL', 'TALCAHUANO', 'CLIQQ', 'IQUIQUE', 'CLARI', 'ARICA', 'CLANF', 'ANTOFAGASTA'];
  // Rough box around the Chilean coast and its port approaches.
  const CHILE_BOX = { latMin: -46, latMax: -17.5, lonMin: -75.5, lonMax: -69.5 };
  const CHILE_REF = { lat: -33.59, lon: -71.62 }; // San Antonio, for distance-based progress

  function compact(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9>]/g, '');
  }

  // AIS destinations are free text typed by the crew: "CN SHA", "CLSAI>CNSHA", "YANTIAN", ...
  function parseDestination(raw) {
    const parts = compact(raw).split('>').filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : '';
    if (!last) return { port: null, chile: false };
    for (const key of Object.keys(PORTS)) {
      if (PORTS[key].codes.some(c => last.includes(c))) return { port: key, chile: false };
    }
    return { port: null, chile: CHILE_CODES.some(c => last.includes(c)) };
  }

  // AIS ETA has month/day/hour/minute but no year. Pick the year that puts it closest to `ref`.
  function inferEta(eta, refIso) {
    if (!eta || !eta.Month || !eta.Day || eta.Month > 12 || eta.Day > 31) return null;
    const ref = new Date(refIso || Date.now());
    const hour = eta.Hour >= 24 ? 12 : (eta.Hour || 0);
    const minute = eta.Minute >= 60 ? 0 : (eta.Minute || 0);
    let best = null;
    for (const y of [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]) {
      const d = new Date(Date.UTC(y, eta.Month - 1, eta.Day, hour, minute));
      if (d.getUTCMonth() !== eta.Month - 1) continue; // e.g. 31 Feb
      // Bias towards the future: a past ETA more than ~2 months old is probably next year's.
      const diff = d - ref;
      const score = diff < -60 * DAY ? Math.abs(diff) * 4 : Math.abs(diff);
      if (!best || score < best.score) best = { score, d };
    }
    return best ? best.d.toISOString() : null;
  }

  function distanceKm(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180;
    const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  function inChile(lat, lon) {
    return lat >= CHILE_BOX.latMin && lat <= CHILE_BOX.latMax && lon >= CHILE_BOX.lonMin && lon <= CHILE_BOX.lonMax;
  }

  function isAtPort(portKey, lat, lon, sog, navStatus) {
    const p = PORTS[portKey];
    if (!p || lat == null || lon == null) return false;
    const stopped = (sog != null && sog < 1.5) || navStatus === 1 || navStatus === 5; // 1 anchored, 5 moored
    return stopped && distanceKm(lat, lon, p.lat, p.lon) <= p.radiusKm;
  }

  // ── DAILY MERGE (used by scripts/update-ais.mjs) ──
  // db: { updatedAt, vessels: { [mmsi]: record } }
  // statics / positions: Map(mmsi -> latest AISStream message body + meta)
  function mergeSnapshot(db, statics, positions, nowIso, watch) {
    const vessels = db.vessels || {};
    const watchSet = new Set((watch || []).map(w => compact(w)));
    const mmsis = new Set([...statics.keys(), ...positions.keys()]);
    let added = 0, updated = 0;

    for (const mmsi of mmsis) {
      const st = statics.get(mmsi);
      const pos = positions.get(mmsi);
      let v = vessels[mmsi];

      if (!v) {
        // Only keep vessels relevant to the Chile → China lane.
        const name = st ? (st.Name || '').trim() : (pos && pos.ShipName || '').trim();
        const dest = st ? parseDestination(st.Destination) : { port: null, chile: false };
        const cargo = st && st.Type >= 70 && st.Type <= 79;
        const length = st && st.Dimension ? (st.Dimension.A || 0) + (st.Dimension.B || 0) : 0;
        const nearChile = pos && inChile(pos.Latitude, pos.Longitude) && cargo && length >= 100;
        const watched = watchSet.has(compact(name)) || watchSet.has(String(mmsi)) ||
          (st && st.ImoNumber && watchSet.has(String(st.ImoNumber)));
        // Large cargo/container ships anywhere are kept too, so they can be found in search before they head for China.
        const bigCargo = cargo && length >= 150;
        if (!(dest.port || (dest.chile && cargo) || nearChile || watched || bigCargo)) continue;
        if (!name) continue;
        v = vessels[mmsi] = { mmsi: Number(mmsi), name, etaHistory: [], firstSeen: nowIso };
        added++;
      } else {
        updated++;
      }

      if (st && (!v.staticAt || (st._time || nowIso) >= v.staticAt)) {
        v.name = (st.Name || v.name).trim();
        if (st.ImoNumber) v.imo = st.ImoNumber;
        if (st.CallSign) v.callsign = st.CallSign.trim();
        v.type = st.Type;
        if (st.Dimension) v.length = (st.Dimension.A || 0) + (st.Dimension.B || 0);
        v.dest = (st.Destination || '').trim();
        v.destPort = parseDestination(st.Destination).port;
        const eta = inferEta(st.Eta, st._time || nowIso);
        v.eta = eta;
        v.staticAt = st._time || nowIso;
        if (eta) {
          const last = v.etaHistory[v.etaHistory.length - 1];
          if (!last || last.eta !== eta) v.etaHistory.push({ eta, seen: nowIso });
          if (v.etaHistory.length > 15) v.etaHistory = v.etaHistory.slice(-15);
        }
      }
      if (pos && (!v.posAt || (pos._time || nowIso) >= v.posAt)) {
        v.posSource = 'AISStream';
        v.lat = round(pos.Latitude, 4);
        v.lon = round(pos.Longitude, 4);
        v.sog = pos.Sog;
        v.cog = pos.Cog;
        v.navStatus = pos.NavigationalStatus;
        v.posAt = pos._time || nowIso;
        if (inChile(v.lat, v.lon)) v.lastChileAt = v.posAt;
      }
      v.lastSeen = [v.posAt, v.staticAt].filter(Boolean).sort().pop();
      updateVoyage(v, nowIso);
    }

    // Prune vessels not seen for 120 days (unless watched).
    for (const [mmsi, v] of Object.entries(vessels)) {
      const watched = watchSet.has(compact(v.name)) || watchSet.has(String(mmsi)) || (v.imo && watchSet.has(String(v.imo)));
      if (!watched && v.lastSeen && Date.parse(nowIso) - Date.parse(v.lastSeen) > 120 * DAY) delete vessels[mmsi];
    }

    db.vessels = vessels;
    db.updatedAt = nowIso;
    return { added, updated, total: Object.keys(vessels).length };
  }

  // Records from other sources (e.g. VesselFinder API). Each field group is only taken when it is
  // newer than what the vessel already has, so the freshest source always wins.
  // rec: { mmsi, imo, name, lat, lon, sog, cog, navStatus, posAt, dest, eta, staticAt, source }
  function mergeExternal(db, records, nowIso) {
    const vessels = db.vessels || (db.vessels = {});
    let used = 0;
    for (const r of records) {
      if (!r || !r.mmsi || !r.name) continue;
      const mmsi = String(r.mmsi);
      const v = vessels[mmsi] || (vessels[mmsi] = { mmsi: Number(mmsi), name: r.name, etaHistory: [], firstSeen: nowIso });
      let changed = false;
      if (r.imo) v.imo = r.imo;
      if (r.posAt && r.lat != null && (!v.posAt || r.posAt > v.posAt)) {
        Object.assign(v, { lat: round(r.lat, 4), lon: round(r.lon, 4), sog: r.sog, cog: r.cog, navStatus: r.navStatus,
          posAt: r.posAt, posSource: r.source });
        if (inChile(v.lat, v.lon)) v.lastChileAt = v.posAt;
        changed = true;
      }
      const stAt = r.staticAt || r.posAt;
      if (stAt && r.dest != null && (!v.staticAt || stAt > v.staticAt)) {
        v.name = r.name;
        v.dest = r.dest;
        v.destPort = parseDestination(r.dest).port;
        v.eta = r.eta || null;
        v.staticAt = stAt;
        if (r.eta) {
          const last = v.etaHistory[v.etaHistory.length - 1];
          if (!last || last.eta !== r.eta) v.etaHistory.push({ eta: r.eta, seen: nowIso });
          if (v.etaHistory.length > 15) v.etaHistory = v.etaHistory.slice(-15);
        }
        changed = true;
      }
      if (changed) {
        used++;
        v.lastSeen = [v.posAt, v.staticAt].filter(Boolean).sort().pop();
        updateVoyage(v, nowIso);
      }
    }
    return used;
  }

  // A voyage = one trip to one China port. Tracks first ETA, estimated departure and arrival.
  function updateVoyage(v, nowIso) {
    if (v.destPort) {
      const voyage = v.voyage;
      const isNew = !voyage || voyage.port !== v.destPort ||
        (voyage.arrivedAt && v.lastChileAt && v.lastChileAt > voyage.arrivedAt);
      if (isNew) {
        v.voyage = { port: v.destPort, firstEta: v.eta || null, firstEtaAt: v.eta ? nowIso : null,
          departedAt: null, arrivedAt: null, startedAt: nowIso };
      } else if (!voyage.firstEta && v.eta) {
        voyage.firstEta = v.eta; voyage.firstEtaAt = nowIso;
      }
    }
    const voy = v.voyage;
    if (!voy) return;
    // Departure: last time it was seen on the Chilean coast, once it is seen outside it.
    if (!voy.departedAt && v.lastChileAt && v.lat != null && !inChile(v.lat, v.lon) && v.posAt > v.lastChileAt) {
      voy.departedAt = v.lastChileAt;
      voy.departedEstimated = true;
    }
    if (!voy.arrivedAt && isAtPort(voy.port, v.lat, v.lon, v.sog, v.navStatus) &&
        (!voy.departedAt || v.posAt > voy.departedAt)) {
      voy.arrivedAt = v.posAt;
    }
  }

  function round(n, d) { return n == null ? n : Math.round(n * 10 ** d) / 10 ** d; }

  // ── VIEW MODEL (app + service worker) ──
  // saved: the user's record in localStorage; v: the vessel record from data/vessels.json (or null)
  function computeStatus(saved, v, nowMs, staleDays) {
    nowMs = nowMs || Date.now();
    const voy = v && v.voyage && (!saved.port || v.voyage.port === saved.port) ? v.voyage : null;
    const port = saved.port || (voy && voy.port) || (v && v.destPort) || null;
    const eta = saved.etaManual || (v && v.destPort === port ? v.eta : null) || (voy && voy.firstEta) || null;
    const departed = saved.departedManual || (voy && voy.departedAt) || null;
    const departedEstimated = !saved.departedManual && !!(voy && voy.departedEstimated);
    const arrivedAt = saved.arrivedManual || (voy && voy.arrivedAt) || null;
    const originalEta = saved.originalEta || (voy && voy.firstEta) || eta;

    let progress = null, progressMode = null;
    if (arrivedAt) { progress = 1; progressMode = 'arrived'; }
    else if (departed && eta && Date.parse(eta) > Date.parse(departed)) {
      progress = clamp((nowMs - Date.parse(departed)) / (Date.parse(eta) - Date.parse(departed)), 0, 0.99);
      progressMode = 'time';
    } else if (v && v.lat != null && port && PORTS[port] && !inChile(v.lat, v.lon)) {
      const total = distanceKm(CHILE_REF.lat, CHILE_REF.lon, PORTS[port].lat, PORTS[port].lon);
      const left = distanceKm(v.lat, v.lon, PORTS[port].lat, PORTS[port].lon);
      progress = clamp(1 - left / total, 0, 0.99);
      progressMode = 'distance';
    } else if (v && v.lat != null && inChile(v.lat, v.lon)) {
      progress = 0; progressMode = 'origin';
    }

    const daysLeft = !arrivedAt && eta ? Math.ceil((Date.parse(eta) - nowMs) / DAY) : null;
    const ref = arrivedAt || eta;
    const delayDays = ref && originalEta ? Math.round((startOfDay(ref) - startOfDay(originalEta)) / DAY) : null;
    const lastSeen = v ? v.lastSeen : null;
    const daysSinceUpdate = lastSeen ? Math.floor((nowMs - Date.parse(lastSeen)) / DAY) : null;
    const stale = !arrivedAt && (v ? daysSinceUpdate >= (staleDays || 3) : true);

    let state = 'nodata';
    if (arrivedAt) state = 'arrived';
    else if (departed || progressMode === 'distance') state = 'transit';
    else if (v) state = 'origin';

    return { port, portName: port && PORTS[port] ? PORTS[port].name : null, eta, originalEta, departed,
      departedEstimated, arrivedAt, progress, progressMode, daysLeft, delayDays, lastSeen, daysSinceUpdate,
      stale, state };
  }

  function startOfDay(iso) { const d = new Date(iso); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  // Events to notify about. `memo` is a plain object persisted by the caller (dedupe store).
  function pendingAlerts(savedList, data, memo, settings, nowMs) {
    const out = [];
    const vessels = (data && data.vessels) || {};
    for (const s of savedList) {
      const v = s.mmsi ? vessels[s.mmsi] : null;
      const st = computeStatus(s, v, nowMs, settings.staleDays);
      if (st.arrivedAt) {
        const k = `arr:${s.id}:${st.arrivedAt.slice(0, 10)}`;
        if (!memo[k]) { memo[k] = 1; out.push({ tag: k, title: `${s.name} ARRIVED`, body: `Arrived at ${st.portName || 'port'} on ${fmtDate(st.arrivedAt)}.` }); }
        continue;
      }
      if (st.eta) {
        const lk = `lastEta:${s.id}`, day = st.eta.slice(0, 10);
        if (memo[lk] && memo[lk] !== day) {
          const d = st.delayDays;
          out.push({ tag: `eta:${s.id}:${day}`, title: `${s.name}: new ETA ${fmtDate(st.eta)}`,
            body: d ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ${d > 0 ? 'delayed' : 'early'} vs original ETA ${fmtDate(st.originalEta)}.` : 'Back on the original ETA.' });
        }
        memo[lk] = day;
      }
      if (st.stale && v) {
        const k = `stale:${s.id}:${(st.lastSeen || '').slice(0, 10)}`;
        if (!memo[k]) { memo[k] = 1; out.push({ tag: k, title: `${s.name}: no AIS update`, body: `No position for ${st.daysSinceUpdate} days. Check the ETA on ${carrierLabel(s)} with a BL or container number.` }); }
      }
    }
    return out;
  }

  function carrierLabel(s) {
    const key = s.carrier || ((s.bls || [])[0] && detectCarrier(s.bls[0].ref)) || carrierFromName(s.name);
    return key && CARRIERS[key] ? `the ${CARRIERS[key].name} website` : "the carrier's website";
  }

  // ── CSV IMPORT ──
  // Accepts comma, semicolon or tab separated text with a header row. Column names can be in English or
  // Spanish: vessel/nave/buque, departure/zarpe/ATD, IMO, BL/contenedor, destination/destino/POD, ETA.
  // Order matters: "Fecha destino" is the ETA column, so ETA is matched before the destination port.
  const CSV_COLS = {
    name: /^(vessel|vessel name|ship|nave|buque|barco|name|nombre|motonave|m\/n|mn)$/,
    eta: /(^eta|fecha\s*(de\s*)?(destino|llegada|arribo)|arrival|llegada|arribo)/,
    departed: /(depart|zarpe|atd|etd|sail|salida)/,
    imo: /^imo/,
    bl: /(^bl|b\/l|bill|container|contenedor|cntr|booking)/,
    port: /(puerto|^pod|port|^destin)/
  };

  function splitCsvLine(line, sep) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  // Dates as DD/MM/YYYY (Chile), YYYY-MM-DD, DD-Mon-YYYY or DD Mon YYYY. Returns ISO at 12:00 UTC.
  const MON = { JAN: 1, ENE: 1, FEB: 2, MAR: 3, APR: 4, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DEC: 12, DIC: 12 };
  function parseDate(str) {
    const t = String(str || '').trim().toUpperCase();
    if (!t) return null;
    let y, m, d, mm;
    if ((mm = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
    else if ((mm = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) {
      d = +mm[1]; m = +mm[2]; y = +mm[3];
      if (m > 12 && d <= 12) [d, m] = [m, d]; // US order
    } else if ((mm = t.match(/^(\d{1,2})[-\s\/.]*([A-Z]{3})[A-Z]*[-\s\/.,]*(\d{2,4})/))) { d = +mm[1]; m = MON[mm[2]]; y = +mm[3]; }
    else return null;
    if (y < 100) y += 2000;
    if (!m || m > 12 || !d || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return dt.getUTCMonth() === m - 1 ? dt.toISOString() : null;
  }

  function portFromText(t) {
    const p = parseDestination(t).port;
    if (p) return p;
    const c = compact(t);
    return Object.keys(PORTS).find(k => compact(PORTS[k].name) === c) || null;
  }

  function parseVesselCsv(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { rows: [], errors: ['Empty file'] };
    const sep = [';', '\t', ','].map(c => [c, lines[0].split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const head = splitCsvLine(lines[0], sep).map(h => h.toLowerCase().trim());
    const idx = {};
    for (const [key, re] of Object.entries(CSV_COLS)) {
      const i = head.findIndex((h, j) => re.test(h) && !Object.values(idx).includes(j));
      if (i >= 0) idx[key] = i;
    }
    const hasHeader = idx.name != null || idx.departed != null;
    if (!hasHeader) { idx.name = 0; idx.departed = 1; }
    const rows = [], errors = [];
    lines.slice(hasHeader ? 1 : 0).forEach((line, n) => {
      const c = splitCsvLine(line, sep);
      const name = (c[idx.name] || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!name) return;
      const rawDep = idx.departed != null ? c[idx.departed] : '';
      const departed = parseDate(rawDep);
      if (rawDep && !departed) errors.push(`Row ${n + 2}: could not read the date "${rawDep}"`);
      rows.push({
        name, departed,
        imo: idx.imo != null && /^\d{7}$/.test((c[idx.imo] || '').trim()) ? Number(c[idx.imo]) : null,
        // One cell can hold several containers: "MSKU1234567 / MSKU7654321"
        bls: idx.bl != null ? (c[idx.bl] || '').toUpperCase().split(/[\s,\/|+&]+/).filter(x => x.length >= 4) : [],
        port: idx.port != null ? portFromText(c[idx.port]) : null,
        eta: idx.eta != null ? parseDate(c[idx.eta]) : null
      });
    });
    return { rows, errors };
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
  }

  // ── CARRIER TRACKING LINKS (BL / container fallback) ──
  // names: words in a vessel name that usually identify the operator (used when no BL is saved).
  // home: the carrier's tracking page, where a BL or container number can be entered.
  const CARRIERS = {
    MAERSK:  { name: 'Maersk',      names: ['MAERSK'], home: 'https://www.maersk.com/tracking/', prefixes: ['MAEU', 'MSKU', 'MRKU', 'MRSU', 'MCPU', 'MSFU', 'MNBU', 'MMAU', 'MSAU', 'MVIU', 'SUDU', 'SEAU'],
      url: r => `https://www.maersk.com/tracking/${encodeURIComponent(r)}` },
    MSC:     { name: 'MSC',         names: ['MSC'], home: 'https://www.msc.com/en/track-a-shipment', prefixes: ['MSCU', 'MEDU', 'MSDU', 'MSMU', 'MSNU', 'MSBU'],
      url: r => `https://www.msc.com/en/track-a-shipment?trackingNumber=${encodeURIComponent(r)}` },
    CMACGM:  { name: 'CMA CGM',     names: ['CMA CGM', 'APL'], home: 'https://www.cma-cgm.com/ebusiness/tracking', prefixes: ['CMAU', 'CGMU', 'CMDU', 'APLU', 'APZU', 'ANNU', 'ECMU', 'TCLU'],
      url: r => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=BL&Reference=${encodeURIComponent(r)}` },
    HAPAG:   { name: 'Hapag-Lloyd', names: [], home: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html', prefixes: ['HLCU', 'HLXU', 'HLBU', 'UACU'],
      url: r => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${encodeURIComponent(r)}` },
    COSCO:   { name: 'COSCO / OOCL', names: ['COSCO', 'OOCL'], home: 'https://elines.coscoshipping.com/ebusiness/cargoTracking', prefixes: ['COSU', 'CBHU', 'CSNU', 'OOLU', 'CCLU'],
      url: r => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${encodeURIComponent(r)}` },
    ONE:     { name: 'ONE',         names: ['ONE'], home: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking', prefixes: ['ONEY', 'ONEU'],
      url: r => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trkNoParam=${encodeURIComponent(r)}` },
    EVERGREEN: { name: 'Evergreen', names: ['EVER'], home: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do', prefixes: ['EGLV', 'EGHU', 'EISU', 'EMCU'],
      url: () => 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do' },
    ZIM:     { name: 'ZIM',         names: ['ZIM'], home: 'https://www.zim.com/tools/track-a-shipment', prefixes: ['ZIMU', 'ZCSU'],
      url: r => `https://www.zim.com/tools/track-a-shipment?consnumber=${encodeURIComponent(r)}` },
    HMM:     { name: 'HMM',         names: ['HMM', 'HYUNDAI'], home: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do', prefixes: ['HDMU', 'HMMU'],
      url: () => 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do' },
    YANGMING: { name: 'Yang Ming',  names: ['YM '], home: 'https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx', prefixes: ['YMLU', 'YMMU'],
      url: () => 'https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx' }
  };

  // Guess the operator from the vessel name ("MAERSK SKARSTIND", "MSC ...", "EVER GIVEN").
  function carrierFromName(name) {
    const n = ' ' + String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim() + ' ';
    for (const key of Object.keys(CARRIERS)) {
      if (CARRIERS[key].names.some(w => n.startsWith(' ' + w.trim() + ' ') || (w.length > 3 && n.includes(' ' + w.trim() + ' ')))) return key;
    }
    return null;
  }

  function detectCarrier(ref) {
    const p = compact(ref).slice(0, 4);
    for (const key of Object.keys(CARRIERS)) if (CARRIERS[key].prefixes.includes(p)) return key;
    return null;
  }

  function trackingUrl(ref, carrierKey) {
    const key = carrierKey || detectCarrier(ref);
    return key && CARRIERS[key] ? CARRIERS[key].url(compact(ref)) : null;
  }

  const api = { DAY, PORTS, CARRIERS, CHILE_BOX, parseDestination, inferEta, distanceKm, inChile, isAtPort,
    parseVesselCsv, parseDate, mergeSnapshot, mergeExternal, updateVoyage, carrierFromName, computeStatus, pendingAlerts, fmtDate, detectCarrier, trackingUrl, compact };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KuaiLogic = api;
})(typeof self !== 'undefined' ? self : this);
