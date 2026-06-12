const CACHE = 'erbsenzaehler-v3';
const PRECACHE = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API and photo requests: always network-first, no caching
  if (url.pathname.startsWith('/api/')) return;

  // App shell: cache-first, fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push notifications ────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || '🌿 Erbsenzähler';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'erbsenzaehler',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// ── Re-subscribe when the browser rotates the push subscription ───
// The page records which gardens this device subscribed to in IndexedDB
// (store 'push-gardens'); we replay them against the fresh subscription.
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('erbsenzaehler', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('push-gardens', { keyPath: 'gardenId' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbAllGardens() {
  return idbOpen().then(db => new Promise(res => {
    const req = db.transaction('push-gardens', 'readonly').objectStore('push-gardens').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => res([]);
  })).catch(() => []);
}

function urlB64ToUint8Array(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const gardens = await idbAllGardens();
      if (!gardens.length) return;

      const keyRes = await fetch('/api/push/key');
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json();

      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
      const json = newSub.toJSON();
      const oldEndpoint = e.oldSubscription && e.oldSubscription.endpoint;

      for (const g of gardens) {
        await fetch(`/api/gardens/${g.gardenId}/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, user_name: g.userName || undefined }),
        }).catch(() => {});
        if (oldEndpoint) {
          await fetch(`/api/gardens/${g.gardenId}/push/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: oldEndpoint }),
          }).catch(() => {});
        }
      }
    } catch (_) { /* best effort */ }
  })());
});
