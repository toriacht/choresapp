const CACHE_NAME = 'choresapp-shell-v4';
const SHELL_ASSETS = ['./', './index.html', './choresapp.css', './manifest.json', './favicon.ico', './icon-192.png', './icon-512.png'];

// Background push handling -- a raw 'push' listener, not
// firebase-messaging-compat's onBackgroundMessage. Chrome enforces (via a
// per-origin budget, which is why this read as "sporadic") that a push
// event that doesn't result in a shown notification gets a generic
// fallback one instead -- no icon, no message, just a link to the origin.
// onBackgroundMessage relies on an async importScripts()+initializeApp()
// chain and its own payload-shape assumptions; a raw listener that always
// calls showNotification() synchronously within the event removes any
// path to that fallback ever firing. The in-app notification inbox (a
// realtime Firestore listener while the app is open) is the reliable
// backbone regardless; this only matters while the app/tab is closed.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title || 'Choresapp';
  const body = notification.body || data.body || '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: './' },
    })
  );
});

// Without this, clicking a background notification does nothing (Chrome's
// default is a no-op, not "open the app"). Focuses an already-open tab
// rather than always spawning a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

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
