const CACHE_NAME = 'choresapp-shell-v1';
const SHELL_ASSETS = ['./', './index.html', './manifest.json', './favicon.ico', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests -- the app shell. Never intercept
  // Firebase Auth/Firestore/Storage/Functions calls, which are cross-origin
  // anyway and must always hit the network fresh.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  // Network-first, cache as a fallback -- so the shell never gets stuck
  // stale after a deploy; the cache is only actually used offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
