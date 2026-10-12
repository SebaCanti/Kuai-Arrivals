// Kuai Tracking — app
(function () {
  'use strict';
  const L = window.KuaiLogic;
  const SAVED_KEY = 'kuai.saved.v1';
  const SETTINGS_KEY = 'kuai.settings.v1';
  const DATA_URL = 'data/vessels.json';

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let data = { updatedAt: null, vessels: {} };
  let saved = load(SAVED_KEY, []);
  let settings = Object.assign({ notifications: false, staleDays: 3, sort: 'eta' }, load(SETTINGS_KEY, {}));
  const open = new Set();
  let activeResult = 0;

  function load(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch { return fallback; } }
  function persist() {
    for (const s of saved) if (s.mmsi && data.vessels[s.mmsi]) s.lastAis = data.vessels[s.mmsi];
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    mirrorToServiceWorker();
  }

  // ── DATA ──
  async function fetchData() {
    $('refreshBtn').classList.add('spin');
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      data.vessels = data.vessels || {};
      $('dataStamp').textContent = data.updatedAt ? `AIS data: ${fmtDateTime(data.updatedAt)}` : 'No AIS data yet';
    } catch (e) {
      $('dataStamp').textContent = 'Offline: showing last saved data';
      try {
        const cached = await caches.match(DATA_URL);
        if (cached) data = await cached.json();
      } catch { /* no cache */ }
    } finally {
      $('refreshBtn').classList.remove('spin');
    }
    reconcile();
    render();
    checkAlerts();
  }

  // A saved vessel keeps its last known AIS record, so it never loses its data if the daily file drops it.
  function vesselOf(s) { return s.mmsi ? data.vessels[s.mmsi] || s.lastAis || null : null; }

  // Link manually added vessels once they appear in AIS data, and freeze the original ETA.
  function reconcile() {
    const byName = {};
    for (const v of Object.values(data.vessels)) byName[L.compact(v.name)] = v;
    for (const s of saved) {
      if (!s.mmsi) {
        const v = byName[L.compact(s.name)];
        if (v) { s.mmsi = v.mmsi; s.imo = v.imo; }
      }
      freezeOriginal(s);
    }
    persist();
  }

  function freezeOriginal(s) {
    const v = vesselOf(s);
    const st = L.computeStatus(Object.assign({}, s, { originalEta: null }), v, Date.now(), settings.staleDays);
    // A new voyage (different destination port) starts a new original ETA.
    if (s.originalEta && s.originalEtaPort && st.port && st.port !== s.originalEtaPort && !s.port) {
      s.originalEta = null;
    }
    if (!s.originalEta && st.originalEta) {
      s.originalEta = st.originalEta;
      s.originalEtaPort = st.port;
    }
  }

  // ── SEARCH ──
  function search(q) {
    const c = L.compact(q);
    if (c.length < 2) return [];
    const savedIds = new Set(saved.map(s => String(s.mmsi)));
    return Object.values(data.vessels)
      .filter(v => L.compact(v.name).includes(c) || String(v.imo || '').startsWith(c) || String(v.mmsi).startsWith(c))
      .map(v => ({ v, score: (L.compact(v.name).startsWith(c) ? 0 : 1) + (v.destPort ? 0 : 2), saved: savedIds.has(String(v.mmsi)) }))
      .sort((a, b) => a.score - b.score || a.v.name.localeCompare(b.v.name))
      .slice(0, 20);
  }

  function renderResults() {
    const q = $('search').value.trim();
    const ul = $('results');
    if (q.length < 2) { ul.hidden = true; ul.innerHTML = ''; return; }
    const items = search(q);
    activeResult = 0;
    ul.innerHTML = items.map((r, i) => {
      const v = r.v;
      const dest = v.destPort ? L.PORTS[v.destPort].name : (v.dest || 'No destination');
      return `<li data-i="${i}" class="${i === 0 ? 'active' : ''}">
        <span><span class="r-name">${esc(v.name)}</span>${r.saved ? ' <span class="muted">· saved</span>' : ''}
          <br><span class="muted">IMO ${esc(v.imo || '—')} · MMSI ${esc(v.mmsi)}</span></span>
        <span class="r-meta">${esc(dest)}<br>${v.eta ? 'ETA ' + L.fmtDate(v.eta) : ''}</span></li>`;
    }).join('') + `<li data-manual="1" class="${items.length ? '' : 'active'}"><span class="r-manual">+ Add “${esc(q.toUpperCase())}” manually</span>
      <span class="r-meta">not in AIS data yet</span></li>`;
    ul.hidden = false;
    ul._items = items;
  }

  function pickResult(li) {
    const ul = $('results');
    if (li.dataset.manual) addVessel({ name: $('search').value.trim().toUpperCase() });
    else addVessel(ul._items[Number(li.dataset.i)].v);
    $('search').value = '';
    renderResults();
    $('search').blur();
  }

  function addVessel(v) {
    if (!v.name) return;
    const exists = saved.find(s => (v.mmsi && String(s.mmsi) === String(v.mmsi)) || (!v.mmsi && s.name === v.name));
    if (exists) { toast(`${v.name} is already saved`); return; }
    const s = { id: v.mmsi ? String(v.mmsi) : `m-${Date.now()}`, mmsi: v.mmsi || null, imo: v.imo || null,
      name: v.name, addedAt: new Date().toISOString(), bls: [] };
    freezeOriginal(s);
    saved.push(s);
    if (!v.mmsi) open.add(s.id);
    persist();
    render();
    toast(`Saved ${v.name}`);
  }

  // ── LIST ──
  function sorted() {
    const rows = saved.map(s => ({ s, v: vesselOf(s), st: L.computeStatus(s, vesselOf(s), Date.now(), settings.staleDays) }));
    const etaKey = r => r.st.eta ? Date.parse(r.st.eta) : Infinity;
    const cmp = {
      eta: (a, b) => (a.st.state === 'arrived') - (b.st.state === 'arrived') ||
        (a.st.state === 'arrived' ? Date.parse(b.st.arrivedAt) - Date.parse(a.st.arrivedAt) : etaKey(a) - etaKey(b)),
      progress: (a, b) => (b.st.progress || 0) - (a.st.progress || 0),
      name: (a, b) => a.s.name.localeCompare(b.s.name),
      added: (a, b) => b.s.addedAt.localeCompare(a.s.addedAt)
    }[settings.sort] || (() => 0);
    return rows.sort(cmp);
  }

  function render() {
    $('savedCount').textContent = saved.length ? `(${saved.length})` : '';
    $('empty').hidden = saved.length > 0;
    $('sortSel').value = settings.sort;
    if (design) {
      $('list').innerHTML = boardHeadHtml() + sorted().map(boardRowHtml).join('');
    } else {
      $('list').innerHTML = sorted().map(cardHtml).join('');
    }
  }

  // ── ARRIVALS BOARD (airport-style designs a / b / c) ──
  const design = (() => {
    try {
      // Default: E (green CRT monitor). ?design=a..f previews another board, ?design=classic shows the old cards.
      const q = new URLSearchParams(location.search).get('design');
      if (q === 'classic') { localStorage.setItem('kuai.design.v2', 'classic'); return null; }
      if (/^[a-f]$/.test(q || '')) { localStorage.setItem('kuai.design.v2', q); return q; }
      const saved = localStorage.getItem('kuai.design.v2');
      return saved === 'classic' ? null : saved || 'e';
    } catch { return 'e'; }
  })();

  // Split each character into a tile for the split-flap design.
  function flap(text, delayBase = 0) {
    if (design !== 'a' && design !== 'd') return esc(text);
    return [...String(text)].map((c, i) =>
      `<span class="fl" style="animation-delay:${delayBase + i * 35}ms">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
  }

  function boardStatus(st) {
    if (st.state === 'arrived') {
      const t = 'ARRIVED \u00a0·\u00a0 ARRIVED \u00a0·\u00a0 ARRIVED \u00a0·\u00a0 ';
      return { cls: 'arrived', html: `<span class="marquee"><span>${t}${t}</span></span>` };
    }
    if (st.daysSinceUpdate == null && !st.eta) return { cls: 'stale', html: 'NO DATA' };
    if (st.stale && st.daysSinceUpdate != null) return { cls: 'stale', html: `NO SIGNAL ${st.daysSinceUpdate}D` };
    if (st.state === 'origin') return { cls: 'origin', html: 'LOADING' };
    if (st.daysLeft != null && st.daysLeft >= 0 && st.daysLeft <= 2) {
      const t = 'ARRIVING SOON \u00a0·\u00a0 ARRIVING SOON \u00a0·\u00a0 ';
      return { cls: 'soon', html: `<span class="marquee"><span>${t}${t}</span></span>` };
    }
    if (st.delayDays > 0) return { cls: 'late', html: `DELAYED +${st.delayDays}D` };
    if (st.delayDays < 0) return { cls: 'early', html: `EARLY ${st.delayDays}D` };
    return { cls: 'ontime', html: 'ON TIME' };
  }

  function boardHeadHtml() {
    return `<div class="b-head" role="row">
      <span>Vessel</span><span>To</span><span>Departed</span><span>Voyage</span><span title="Latest (updated) ETA">Upd ETA</span><span>Days</span><span>Status</span></div>`;
  }

  function boardRowHtml({ s, v, st }, idx) {
    const pct = Math.round((st.progress || 0) * 100);
    const status = boardStatus(st);
    const ck = carrierKey(s);
    const days = st.state === 'arrived' ? '—' : st.daysLeft == null ? '—' : st.daysLeft < 0 ? `+${-st.daysLeft}` : String(st.daysLeft);
    const eta = st.arrivedAt ? L.fmtDate(st.arrivedAt) : L.fmtDate(st.eta);
    const d0 = idx * 120;
    let warn = '';
    if (st.stale) {
      const links = (s.bls || []).map(b => blLink(b)).filter(Boolean).join(' · ');
      const home = ck ? `<a href="${esc(L.CARRIERS[ck].home)}" target="_blank" rel="noopener">${esc(L.CARRIERS[ck].name)} tracking ↗</a>` : '';
      const what = v ? `No update for ${st.daysSinceUpdate} days.` : 'Not found in the AIS data yet.';
      warn = `<div class="warn">⚠ ${what} ${links ? 'Check the ETA with your BL: ' + links : home ? 'Check the ETA on ' + home + ' with a BL or container number.' : 'Set the carrier and add a BL in Details.'}
        ${vfLink(s, v)}</div>`;
    }
    return `<div class="b-row ${status.cls} ${open.has(s.id) ? 'open' : ''}" data-id="${esc(s.id)}" data-act="toggle" role="row" tabindex="0">
      <span class="b-vessel"><b>${flap(s.name, d0)}</b><small>${cntrCount(s)}${st.state === 'arrived' ? `<em class="b-arr-note">Arrived ${esc(L.fmtDate(st.arrivedAt))} at ${esc(st.portName || 'port')}</em> · ` : ''}${esc(ck ? L.CARRIERS[ck].name : '')}${st.originalEta && st.delayDays ? ` · orig. ETA ${L.fmtDate(st.originalEta)}` : ''}</small>${open.has(s.id) ? cntrLine(s) : ''}</span>
      <span class="b-to">${flap((st.portName || '—').toUpperCase(), d0 + 200)}</span>
      <span class="b-dep">${flap(st.departed ? L.fmtDate(st.departed).toUpperCase() : '—', d0 + 300)}</span>
      <span class="b-bar"><span class="bar ${st.progressMode === 'distance' ? 'est' : ''}"><i style="width:${pct}%"></i></span><small>${st.state === 'arrived' ? '100%' : pct + '%'}</small></span>
      <span class="b-eta">${flap(eta.toUpperCase(), d0 + 400)}</span>
      <span class="b-days">${flap(days, d0 + 450)}</span>
      <span class="b-status ${status.cls}">${status.html}</span>
    </div>
    ${open.has(s.id) || warn ? `<div class="b-more" data-id="${esc(s.id)}">${warn}${open.has(s.id) ? detailsHtml(s, v, st) : ''}</div>` : ''}`;
  }

  // The board shows only how many containers a vessel carries; the numbers appear when the vessel is opened.
  function cntrCount(s) {
    const n = (s.bls || []).length;
    return n ? `<span class="b-ncntr">▣ ${n} CNTR</span> · ` : '';
  }

  function cntrLine(s) {
    const list = (s.bls || []).map(b => b.ref);
    if (!list.length) return '';
    return `<small class="b-cntr">${list.map(r => `<span data-cntr="${esc(r)}">${esc(r)}</span>`).join(' · ')}</small>`;
  }

  // ── CONTAINER LOCATOR (slide-out panel) ──
  function cntrSearch(q) {
    const c = L.compact(q);
    const ul = $('cntrResults');
    if (c.length < 3) { ul.innerHTML = ''; return; }
    const hits = [];
    for (const s of saved) for (const b of s.bls || []) if (L.compact(b.ref).includes(c)) hits.push({ s, ref: b.ref });
    if (!hits.length) {
      const url = L.trackingUrl(c);
      ul.innerHTML = `<li class="cp-none">NO MATCH IN YOUR VESSELS${url ? `<br><a href="${esc(url)}" target="_blank" rel="noopener">Track ${esc(c)} on ${esc(L.CARRIERS[L.detectCarrier(c)].name)} ↗</a>` : ''}</li>`;
      return;
    }
    ul.innerHTML = hits.slice(0, 30).map(({ s, ref }) => {
      const st = L.computeStatus(s, vesselOf(s), Date.now(), settings.staleDays);
      const status = st.state === 'arrived' ? `ARRIVED ${L.fmtDate(st.arrivedAt)}` : st.eta ? `ETA ${L.fmtDate(st.eta)}${st.daysLeft != null && st.daysLeft >= 0 ? ` · ${st.daysLeft}D` : ''}` : 'NO ETA';
      return `<li data-goto="${esc(s.id)}" data-ref="${esc(ref)}"><b>${esc(ref)}</b><span>${esc(s.name)} → ${esc((st.portName || '—').toUpperCase())}</span><span>${esc(status)}</span></li>`;
    }).join('');
  }

  function cntrOpen(on) {
    $('cntrPanel').classList.toggle('open', on);
    $('cntrPanel').setAttribute('aria-hidden', String(!on));
    $('cntrTab').setAttribute('aria-expanded', String(on));
    if (on) setTimeout(() => $('cntrInput').focus(), 250);
  }

  function cntrGoto(id, ref) {
    cntrOpen(false);
    if (!open.has(id)) { open.add(id); render(); }
    const row = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('b-flash');
    row.querySelectorAll(`[data-cntr="${CSS.escape(ref)}"]`).forEach(el => el.classList.add('hit'));
    setTimeout(() => { row.classList.remove('b-flash'); row.querySelectorAll('.hit').forEach(el => el.classList.remove('hit')); }, 4000);
  }

  function vfLink(s, v) {
    const url = v ? `https://www.vesselfinder.com/vessels/details/${v.imo || v.mmsi}` : `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(s.name)}`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">VesselFinder ↗</a>`;
  }

  function headline(st) {
    if (st.state === 'arrived') return 'ARRIVED';
    if (st.daysLeft == null) return st.state === 'nodata' ? 'No ETA yet' : 'ETA unknown';
    if (st.daysLeft > 1) return `${st.daysLeft} <small>days left</small>`;
    if (st.daysLeft === 1) return `1 <small>day left</small>`;
    if (st.daysLeft === 0) return 'Due today';
    return `Overdue <small>by ${-st.daysLeft} day${st.daysLeft === -1 ? '' : 's'}</small>`;
  }

  function cardHtml({ s, v, st }) {
    const badge = { arrived: 'ARRIVED', transit: 'IN TRANSIT', origin: 'AT ORIGIN', nodata: 'NO AIS DATA' }[st.state];
    const pct = Math.round((st.progress || 0) * 100);
    const left = st.departed
      ? `Departed: ${L.fmtDate(st.departed)}${st.departedEstimated ? ' <span class="muted">(est.)</span>' : ''}`
      : '<span class="muted">Departure: pending</span>';
    const right = st.arrivedAt ? `Arrived: ${L.fmtDate(st.arrivedAt)}` : `ETA: ${L.fmtDate(st.eta)}`;
    let delay = '';
    if (st.delayDays != null && st.originalEta) {
      const d = st.delayDays;
      const cls = d > 0 ? 'late' : d < 0 ? 'early' : '';
      const txt = d > 0 ? `${d} day${d === 1 ? '' : 's'} delayed` : d < 0 ? `${-d} day${d === -1 ? '' : 's'} early` : 'On schedule';
      delay = `<div class="delay ${cls}">${txt} <span class="muted">· Original ETA ${L.fmtDate(st.originalEta)}</span></div>`;
    }
    let warn = '';
    if (st.stale) {
      const links = (s.bls || []).map(b => blLink(b)).filter(Boolean).join(' · ');
      const what = v ? `No update for ${st.daysSinceUpdate} days.` : 'Not found in the AIS data yet.';
      const ck = carrierKey(s);
      const home = ck ? `<a href="${esc(L.CARRIERS[ck].home)}" target="_blank" rel="noopener">${esc(L.CARRIERS[ck].name)} tracking ↗</a>` : '';
      const next = links ? `Check the ETA with your BL: ${links}`
        : home ? `Check the ETA on ${home} with a BL or container number (add it in Details for a direct link).`
        : 'Set the carrier and add a BL or container number in Details to check the ETA on the carrier\'s site.';
      warn = `<div class="warn">⚠ ${what} ${next}</div>`;
    }
    const ais = v && v.lastSeen
      ? `Updated ${fmtDateTime(v.lastSeen)}${v.sog != null ? ` · ${v.sog.toFixed(1)} kn` : ''}${v.posSource ? ` · ${v.posSource}` : ''}`
      : 'No AIS position';
    return `<article class="card ${st.state === 'arrived' ? 'arrived' : ''}" data-id="${esc(s.id)}">
      <div class="card-head">
        <div><div class="v-name">${esc(s.name)}</div><div class="v-port">→ ${esc(st.portName || 'Destination unknown')}</div></div>
        <span class="badge ${st.state}">${badge}</span>
      </div>
      <div class="days">${headline(st)}</div>
      <div class="bar ${st.progressMode === 'distance' ? 'est' : ''}" title="${st.progressMode === 'distance' ? 'Estimated from distance (departure date unknown)' : pct + '%'}"><i style="width:${pct}%"></i></div>
      <div class="dates"><span>${left}</span><span class="dots"></span><span>${right}</span></div>
      ${delay}${warn}
      <div class="foot"><span>${esc(ais)}</span><button class="link-btn" data-act="toggle">${open.has(s.id) ? 'Hide details' : 'Details'}</button></div>
      ${open.has(s.id) ? detailsHtml(s, v, st) : ''}
    </article>`;
  }

  function dateVal(iso) { return iso ? iso.slice(0, 10) : ''; }

  function detailsHtml(s, v, st) {
    const portOpts = `<option value="">Auto${v && v.destPort ? ` (AIS: ${L.PORTS[v.destPort].name})` : ''}</option>` +
      Object.keys(L.PORTS).map(k => `<option value="${k}" ${s.port === k ? 'selected' : ''}>${L.PORTS[k].name}</option>`).join('');
    const carrierOpts = '<option value="">Auto</option>' +
      Object.keys(L.CARRIERS).map(k => `<option value="${k}">${L.CARRIERS[k].name}</option>`).join('');
    const autoCarrier = L.carrierFromName(s.name);
    const vesselCarrierOpts = `<option value="">Auto${autoCarrier ? ` (${L.CARRIERS[autoCarrier].name})` : ''}</option>` +
      Object.keys(L.CARRIERS).map(k => `<option value="${k}" ${s.carrier === k ? 'selected' : ''}>${L.CARRIERS[k].name}</option>`).join('');
    const bls = (s.bls || []).map((b, i) => `<li><span>${esc(b.ref)} <span class="muted">${esc(L.CARRIERS[b.carrier || L.detectCarrier(b.ref)]?.name || 'Unknown carrier')}</span></span>
      <span>${blLink(b) || ''} <button class="x" data-act="rm-bl" data-i="${i}" aria-label="Remove">×</button></span></li>`).join('');
    const ais = v ? `AIS destination: “${esc(v.dest || '—')}” · IMO ${esc(v.imo || '—')} · MMSI ${esc(v.mmsi)}<br>
      ${v.posSource ? `Source: ${esc(v.posSource)} · ` : ''}${v.lat != null ? `Position ${v.lat.toFixed(2)}, ${v.lon.toFixed(2)} · ` : ''}AIS ETA ${L.fmtDate(v.eta)}
      ${v.etaHistory && v.etaHistory.length > 1 ? `<br>ETA history: ${v.etaHistory.map(h => L.fmtDate(h.eta)).join(' → ')}` : ''}<br>
      <a href="https://www.vesselfinder.com/vessels/details/${esc(v.imo || v.mmsi)}" target="_blank" rel="noopener">VesselFinder</a> ·
      <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${esc(v.mmsi)}" target="_blank" rel="noopener">MarineTraffic</a>`
      : 'This vessel is not in the AIS data yet. It is linked automatically when it appears; meanwhile set the dates by hand.';
    return `<div class="details">
      <div class="grid2">
        <label>Destination port<select data-field="port">${portOpts}</select></label>
        <label>Carrier<select data-field="carrier">${vesselCarrierOpts}</select></label>
      </div>
      <div class="grid2">
        <label>Departure (ATD)<input type="date" data-field="departedManual" value="${dateVal(s.departedManual || st.departed)}"></label>
        <label>ETA override<input type="date" data-field="etaManual" value="${dateVal(s.etaManual)}"></label>
        <label>Original ETA<input type="date" data-field="originalEta" value="${dateVal(s.originalEta)}"></label>
        <label>Arrived on<input type="date" data-field="arrivedManual" value="${dateVal(s.arrivedManual)}"></label>
      </div>
      <label>Containers / BL</label>
      <ul class="bl-list">${bls}</ul>
      <div class="bl-add">
        <input type="text" data-bl-input placeholder="BL or container no." autocapitalize="characters">
        <select data-bl-carrier aria-label="Carrier">${carrierOpts}</select>
        <button class="btn" data-act="add-bl">Add</button>
      </div>
      <div class="info">${ais}</div>
      <div><button class="btn danger" data-act="remove">Remove vessel</button></div>
    </div>`;
  }

  function carrierKey(s) {
    return s.carrier || ((s.bls || [])[0] && L.detectCarrier(s.bls[0].ref)) || L.carrierFromName(s.name);
  }

  function blLink(b) {
    const url = L.trackingUrl(b.ref, b.carrier);
    if (!url) return '';
    const name = L.CARRIERS[b.carrier || L.detectCarrier(b.ref)].name;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} ↗</a>`;
  }

  // ── EVENTS ──
  function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-id]');
    if (!card) return;
    if (btn.dataset.act === 'toggle' && e.target.closest('a, button:not([data-act=toggle]), input, select')) return;
    const s = saved.find(x => x.id === card.dataset.id);
    if (!s) return;
    const act = btn.dataset.act;
    if (act === 'toggle') { open.has(s.id) ? open.delete(s.id) : open.add(s.id); render(); return; }
    if (act === 'remove') {
      if (!confirm(`Remove ${s.name} from your list?`)) return;
      saved = saved.filter(x => x !== s);
    } else if (act === 'add-bl') {
      const ref = card.querySelector('[data-bl-input]').value.trim().toUpperCase();
      if (!ref) return;
      s.bls = s.bls || [];
      s.bls.push({ ref, carrier: card.querySelector('[data-bl-carrier]').value || null });
    } else if (act === 'rm-bl') {
      s.bls.splice(Number(btn.dataset.i), 1);
    }
    persist();
    render();
  }

  function onListChange(e) {
    const el = e.target.closest('[data-field]');
    if (!el) return;
    const s = saved.find(x => x.id === el.closest('[data-id]').dataset.id);
    const f = el.dataset.field;
    if (f === 'port') { s.port = el.value || null; s.originalEta = null; freezeOriginal(s); }
    else if (f === 'carrier') s.carrier = el.value || null;
    else s[f] = el.value ? `${el.value}T12:00:00.000Z` : null;
    if (f === 'originalEta' && !el.value) freezeOriginal(s);
    persist();
    render();
  }

  // ── NOTIFICATIONS ──
  // Dedupe memo and the saved list are mirrored into Cache Storage so the service worker
  // (periodic background sync, where supported) can raise the same alerts.
  async function readMemo() {
    try { const r = await caches.match('./__kuai/memo'); return r ? await r.json() : {}; } catch { return {}; }
  }
  async function writeJson(key, obj) {
    try { const c = await caches.open('kuai-state'); await c.put(key, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } })); } catch { /* ignore */ }
  }
  function mirrorToServiceWorker() {
    writeJson('./__kuai/saved', { saved, settings });
  }

  async function checkAlerts() {
    const memo = await readMemo();
    const alerts = L.pendingAlerts(saved, data, memo, settings, Date.now());
    await writeJson('./__kuai/memo', memo);
    if (!settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.ready.catch(() => null);
    for (const a of alerts) {
      if (reg) reg.showNotification(a.title, { body: a.body, tag: a.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
      else new Notification(a.title, { body: a.body, tag: a.tag });
    }
  }

  async function setNotifications(on) {
    if (on) {
      if (!('Notification' in window)) {
        toast('Notifications are not supported here. On iPhone, add the app to the Home Screen first.');
        $('notifToggle').checked = false; return;
      }
      const p = await Notification.requestPermission();
      if (p !== 'granted') { toast('Notifications were blocked in the browser settings'); $('notifToggle').checked = false; return; }
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.periodicSync) await reg.periodicSync.register('kuai-daily', { minInterval: 12 * 3600 * 1000 });
      } catch { /* periodic sync is optional (Chrome/Android installed apps) */ }
    }
    settings.notifications = on;
    persist();
    if (on) toast('Notifications on');
  }

  // ── VESSEL LIST (CSV) ──

  async function importList(file) {
    const text = await file.text();
    if (/\.(csv|txt|tsv)$/i.test(file.name) || !/^\s*[\[{]/.test(text)) return importCsv(text);
    try {
      const obj = JSON.parse(text);
      const list = Array.isArray(obj) ? obj : obj.saved;
      if (!Array.isArray(list)) throw new Error('bad file');
      const ids = new Set(saved.map(s => s.id));
      list.filter(s => s && s.id && s.name && !ids.has(s.id)).forEach(s => saved.push(s));
      persist(); reconcile(); render();
      toast(`Imported ${list.length} vessels`);
    } catch { toast('Could not read that file'); }
  }

  // CSV with vessel name + departure date (+ optional IMO, BL/container, destination, ETA).
  function importCsv(text) {
    const { rows, errors } = L.parseVesselCsv(text);
    if (!rows.length) { toast('No vessels found in the CSV. It needs a column with the vessel name.'); return; }
    const byImo = {}, byName = {};
    for (const v of Object.values(data.vessels)) { if (v.imo) byImo[v.imo] = v; byName[L.compact(v.name)] = v; }
    let added = 0, updated = 0, found = 0;
    for (const r of rows) {
      const v = (r.imo && byImo[r.imo]) || byName[L.compact(r.name)] || null;
      if (v) found++;
      let s = saved.find(x => (v && String(x.mmsi) === String(v.mmsi)) || L.compact(x.name) === L.compact(r.name));
      if (!s) {
        s = { id: v ? String(v.mmsi) : `m-${Date.now()}-${added}`, mmsi: v ? v.mmsi : null, imo: (v && v.imo) || r.imo || null,
          name: v ? v.name : r.name, addedAt: new Date().toISOString(), bls: [] };
        saved.push(s); added++;
      } else {
        updated++;
        // Lock in the ETA the vessel had before this list, so the new one becomes the UPD ETA.
        freezeOriginal(s);
      }
      if (r.departed) s.departedManual = r.departed;
      if (r.port) s.port = r.port;
      if (r.eta) s.etaManual = r.eta;
      if (!s.imo && r.imo) s.imo = r.imo;
      for (const ref of r.bls) if (!(s.bls || []).some(b => b.ref === ref)) (s.bls = s.bls || []).push({ ref, carrier: null });
      freezeOriginal(s);
    }
    persist(); render();
    const msg = `List: ${added} added, ${updated} updated, ${found} of ${rows.length} found in AIS data.`;
    toast(errors.length ? `${msg} ${errors.length} date(s) not understood.` : msg);
    if (errors.length) console.warn(errors.join('\n'));
  }

  function arrivedOf(s) { return L.computeStatus(s, vesselOf(s), Date.now(), settings.staleDays).arrivedAt; }

  // ── UTIL ──
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── INIT ──
  function init() {
    $('search').addEventListener('input', renderResults);
    $('search').addEventListener('keydown', e => {
      const lis = [...$('results').querySelectorAll('li')];
      if (!lis.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = lis.findIndex(li => li.classList.contains('active'));
        const next = Math.max(0, Math.min(lis.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        lis.forEach((li, i) => li.classList.toggle('active', i === next));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pickResult(lis.find(li => li.classList.contains('active')) || lis[0]);
      } else if (e.key === 'Escape') { $('search').value = ''; renderResults(); }
    });
    $('results').addEventListener('click', e => { const li = e.target.closest('li'); if (li) pickResult(li); });
    $('list').addEventListener('click', onListClick);
    $('list').addEventListener('change', onListChange);
    $('sortSel').addEventListener('change', e => { settings.sort = e.target.value; persist(); render(); });
    $('refreshBtn').addEventListener('click', fetchData);
    $('settingsBtn').addEventListener('click', () => {
      $('notifToggle').checked = settings.notifications && 'Notification' in window && Notification.permission === 'granted';
      $('staleDays').value = settings.staleDays;
      $('settings').showModal();
    });
    $('notifToggle').addEventListener('change', e => setNotifications(e.target.checked));
    $('staleDays').addEventListener('change', e => { settings.staleDays = Math.max(1, Number(e.target.value) || 3); persist(); render(); });
    $('cntrTab').addEventListener('click', () => cntrOpen(!$('cntrPanel').classList.contains('open')));
    $('cntrClose').addEventListener('click', () => cntrOpen(false));
    $('cntrInput').addEventListener('input', e => cntrSearch(e.target.value));
    $('cntrInput').addEventListener('keydown', e => {
      if (e.key === 'Escape') cntrOpen(false);
      if (e.key === 'Enter') { const li = $('cntrResults').querySelector('[data-goto]'); if (li) cntrGoto(li.dataset.goto, li.dataset.ref); }
    });
    $('cntrResults').addEventListener('click', e => { const li = e.target.closest('[data-goto]'); if (li) cntrGoto(li.dataset.goto, li.dataset.ref); });
    $('importFile').addEventListener('change', e => { if (e.target.files[0]) importList(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fetchData(); });

    if (design) {
      document.body.dataset.design = design;
      document.querySelector('.board-title').innerHTML =
        `<span class="bt-en">${flap('KUAI TRACKING')}</span><span class="bt-zh">${flap('快追踪', 500)}</span>`;
      const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
      tick(); setInterval(tick, 10000);
    }
    if ('serviceWorker' in navigator) {
      // When a new version takes over an open page, reload once so it shows right away.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && !reloaded) { reloaded = true; location.reload(); }
      });
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
    }
    render();
    fetchData();
  }

  init();
})();
