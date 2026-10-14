// Kuai Arrivals — Service Worker
const CACHE_NAME = 'kuai-v22';
const DATA_URL = 'data/vessels.json';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/board.css',
  './js/logic.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

importScripts('js/logic.js');

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(STATIC_ASSETS.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('precache fail', u, err)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'kuai-state').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Icons and the manifest go straight to the network: iOS fails to read the home-screen icon when a
  // service worker answers that request, and shows a letter instead.
  if (/\/icons\/|manifest\.json$/.test(url.pathname)) return;

  // The encrypted shared list: always from the network (never cached, so each ?t= query adds nothing).
  if (url.pathname.endsWith('/data/mylist.json')) return;

  // Vessel data: network first, cached copy when offline.
  if (url.pathname.endsWith('/' + DATA_URL)) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(DATA_URL, copy));
        }
        return res;
      }).catch(() => caches.match(DATA_URL))
    );
    return;
  }

  // App shell: network first so new versions show on the next load; cached copy when offline.
  // Rebuild cached responses so iOS never sees a redirect.
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).then(res => {
      if (res.ok && res.type === 'basic' && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
        return res;
      }
      return res.redirected ? res.blob().then(b => new Response(b, { headers: res.headers, status: res.status })) : res;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (!cached || !cached.redirected) return cached;
      return cached.blob().then(b => new Response(b, { headers: cached.headers, status: cached.status }));
    }))
  );
});

// Background check (Chrome / Android installed app): raise the same alerts as the app.
self.addEventListener('periodicsync', event => {
  if (event.tag === 'kuai-daily') event.waitUntil(backgroundCheck());
});

async function backgroundCheck() {
  const stateRes = await caches.match('./__kuai/saved');
  if (!stateRes) return;
  const { saved, settings } = await stateRes.json();
  if (!settings || !settings.notifications || !saved || !saved.length) return;
  let data;
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    data = await res.json();
    (await caches.open(CACHE_NAME)).put(DATA_URL, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  } catch { return; }
  const memoRes = await caches.match('./__kuai/memo');
  const memo = memoRes ? await memoRes.json() : {};
  const alerts = self.KuaiLogic.pendingAlerts(saved, data, memo, settings, Date.now());
  (await caches.open('kuai-state')).put('./__kuai/memo', new Response(JSON.stringify(memo), { headers: { 'Content-Type': 'application/json' } }));
  for (const a of alerts) {
    await self.registration.showNotification(a.title, { body: a.body, tag: a.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});
