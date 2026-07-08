const CACHE_NAME = `novel-cache-${Date.now()}`;
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
// updated Wed Jul  8 13:55:19 KST 2026
// updated Wed Jul  8 13:59:12 KST 2026
// updated Wed Jul  8 14:03:52 KST 2026
// feature updated Wed Jul  8 14:17:16 KST 2026
// rescue btn updated Wed Jul  8 14:23:58 KST 2026
// empty tag check updated Wed Jul  8 14:25:54 KST 2026
// dump btn updated Wed Jul  8 14:32:58 KST 2026
// syntax fix Wed Jul  8 14:41:23 KST 2026
// cdn fix Wed Jul  8 14:43:24 KST 2026
// remove rescue btn Wed Jul  8 14:44:36 KST 2026
