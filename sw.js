// Cafeku Service Worker — Chrome 101 compatible (PWA installable)
// Di-deploy ke root (Vercel / GitHub Pages). Semua path relatif terhadap
// lokasi scope script ini.
const CACHE = 'cafeku-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Skip cross-origin (Google Apps Script API, CDN) — always network.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // HTML pages: network-first, fallback to cached index fallback.
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return r;
        })
        .catch(() =>
          // Fallback to cache for the same start page if available.
          caches.match(req).then((cached) =>
            cached || caches.match('index.html')
          ).then((f) => f || Response.error())
        )
    );
    return;
  }

  // Static assets: stale-while-revalidate (fast, updated on next load).
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return r;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
