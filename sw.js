const CACHE_NAME = 'choresapp-shell-v2';
const SHELL_ASSETS = ['./', './index.html', './manifest.json', './favicon.ico', './icon-192.png', './icon-512.png'];

// Background push handling -- only one service worker can control this
// scope, so FCM's background-message support is grafted onto the same
// worker that already handles offline shell caching below, rather than
// registering a second competing one. The in-app notification inbox (a
// realtime Firestore listener while the app is open) is the reliable
// backbone regardless; this only matters while the app/tab is closed.
importScripts('https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCITBcYhETNBShiL13zfC1oUbZ1bm6F_1A',
  authDomain: 'chores-app-9e6a3.firebaseapp.com',
  projectId: 'chores-app-9e6a3',
  storageBucket: 'chores-app-9e6a3.firebasestorage.app',
  messagingSenderId: '870507911406',
  appId: '1:870507911406:web:d11d5cd64adf8f1e6ebbff',
});

// onMessage (foreground) is handled in index.html instead -- this only
// fires when the tab isn't in focus, which is exactly when a native OS
// notification is the right way to surface it.
firebase.messaging().onBackgroundMessage((payload) => {
  const { title, body } = (payload && payload.notification) || {};
  if (!title) return;
  self.registration.showNotification(title, {
    body: body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
  });
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
