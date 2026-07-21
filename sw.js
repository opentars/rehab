// Cache-first service worker: after the first visit the whole app lives on the
// device and runs with no server at all (airplane mode included). Bump VERSION
// on every app change or installed phones keep the old copy forever.
const VERSION = 'rehab-lite-v12';
const FILES = ['./', 'app.js', 'style.css', 'manifest.json', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) => hit || fetch(e.request)
    )
  );
});
