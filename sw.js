// NF Naseem Fitness — minimal service worker
// Purpose: satisfy Chrome's PWA installability requirement (a registered
// SW with a fetch handler) and give basic offline resilience for the
// app shell. Does NOT cache Supabase/API responses — those always go to
// the network so products, prices and stock stay live.

const CACHE_NAME = 'nf-shell-v1';
const APP_SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET navigation/shell requests.
  // Everything else (Supabase, WhatsApp, third-party CDNs, POST requests)
  // is left completely untouched and goes straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Keep a fresh copy of the shell for offline fallback
        if (req.mode === 'navigate') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('/index.html'))
      )
  );
});
