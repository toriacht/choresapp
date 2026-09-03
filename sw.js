const CACHE_NAME = 'choresapp-shell-v5';
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
  // A chore_marked_done push carries enough (familyId + the choreLog
  // entry's own id, both plain strings -- see notify.js's
  // sendPushBestEffort) to offer real Approve/Send back action buttons
  // right on the OS notification, no app open required
  // (notificationclick below performs the write itself). Every other
  // notification type keeps the plain tap-to-open behavior it already had.
  const canReviewInline = data.type === 'chore_marked_done' && data.relatedId && data.familyId;
  const options = {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './', type: data.type || '', relatedId: data.relatedId || '', familyId: data.familyId || '' },
  };
  if (canReviewInline) {
    options.tag = `chorereview-${data.relatedId}`;
    options.actions = [
      { action: 'approve_chore', title: 'Approve' },
      { action: 'reject_chore', title: 'Send back' },
    ];
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------------------
// Background Approve/Send back -- see frontend/index.html's
// mirrorAdminCredentialForBackgroundActions for why this reads from a
// separate IndexedDB store rather than the page's own auth session
// (browserLocalPersistence/localStorage, invisible to a service worker).
// Deliberately plain fetch() calls to Firebase's REST endpoints, not the
// Firestore/Auth JS SDK -- loading that SDK into a service worker (via
// importScripts + the compat build) is exactly the kind of async,
// multi-step chain this file's own push handler above was already
// rewritten away from once for reliability reasons. Two REST calls, each
// with an explicit timeout so a hung network request can't strand the
// event: mint a fresh ID token from the mirrored refresh token, then a
// narrowly-scoped Firestore PATCH (an explicit update mask -- omitting
// it would silently replace the ENTIRE document, wiping every other
// field). Firestore Security Rules are enforced identically for a REST
// write as for an SDK write, so this has exactly the same permission
// boundary the in-app Approve button already has (only an admin may move
// a choreLog entry's status to approved/rejected -- see firestore.rules).
// Falls back to opening/focusing the app on ANY failure at any step
// (missing mirror, network error, expired/revoked refresh token, a rules
// rejection) -- the one thing this must never do is leave the admin
// thinking a tap worked when it silently didn't.
const SW_AUTH_DB_NAME = 'choresAppSwAuth';
const SW_AUTH_STORE = 'credential';
const FIREBASE_API_KEY = 'AIzaSyCITBcYhETNBShiL13zfC1oUbZ1bm6F_1A';
const FIREBASE_PROJECT_ID = 'chores-app-9e6a3';

function readMirroredAdminCredential() {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(SW_AUTH_DB_NAME, 1);
    openReq.onupgradeneeded = () => { openReq.result.createObjectStore(SW_AUTH_STORE); };
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = () => {
      const idb = openReq.result;
      const tx = idb.transaction(SW_AUTH_STORE, 'readonly');
      const getReq = tx.objectStore(SW_AUTH_STORE).get('admin');
      getReq.onsuccess = () => { idb.close(); resolve(getReq.result || null); };
      getReq.onerror = () => { idb.close(); reject(getReq.error); };
    };
  });
}

function writeMirroredRefreshToken(uid, refreshToken) {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(SW_AUTH_DB_NAME, 1);
    openReq.onupgradeneeded = () => { openReq.result.createObjectStore(SW_AUTH_STORE); };
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = () => {
      const idb = openReq.result;
      const tx = idb.transaction(SW_AUTH_STORE, 'readwrite');
      tx.objectStore(SW_AUTH_STORE).put({ uid, refreshToken }, 'admin');
      tx.oncomplete = () => { idb.close(); resolve(); };
      tx.onerror = () => { idb.close(); reject(tx.error); };
    };
  });
}

async function mintIdTokenFromRefreshToken(refreshToken) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return res.json(); // { id_token, refresh_token, user_id, ... }
}

async function reviewChoreLogEntryInBackground({ familyId, entryId, newStatus }) {
  const credential = await readMirroredAdminCredential();
  if (!credential || !credential.refreshToken) throw new Error('no mirrored admin credential');
  const tokenResult = await mintIdTokenFromRefreshToken(credential.refreshToken);
  const idToken = tokenResult.id_token;
  const docPath = `families/${familyId}/choreLog/${entryId}`;
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`
    + '?updateMask.fieldPaths=status&updateMask.fieldPaths=reviewedBy&updateMask.fieldPaths=reviewedAt';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        status: { stringValue: newStatus },
        reviewedBy: { stringValue: credential.uid || '' },
        reviewedAt: { timestampValue: new Date().toISOString() },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`choreLog update failed: ${res.status}`);
  // Firebase can rotate the refresh token on a grant -- write the
  // (possibly new) one back so this keeps working next time, rather
  // than quietly breaking once the original stops refreshing.
  if (tokenResult.refresh_token && tokenResult.refresh_token !== credential.refreshToken) {
    await writeMirroredRefreshToken(credential.uid, tokenResult.refresh_token);
  }
}

function focusOrOpenApp(url) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  });
}

// Without this, clicking a background notification does nothing (Chrome's
// default is a no-op, not "open the app"). Focuses an already-open tab
// rather than always spawning a new one.
self.addEventListener('notificationclick', (event) => {
  const notifData = event.notification.data || {};
  const url = notifData.url || './';

  if (event.action === 'approve_chore' || event.action === 'reject_chore') {
    const newStatus = event.action === 'approve_chore' ? 'approved' : 'rejected';
    event.waitUntil(
      reviewChoreLogEntryInBackground({ familyId: notifData.familyId, entryId: notifData.relatedId, newStatus })
        // Same tag as the original -- this replaces it in place rather
        // than stacking a second notification, which is the only
        // feedback the admin gets that a background tap actually worked.
        .then(() => self.registration.showNotification(
          newStatus === 'approved' ? 'Approved ✓' : 'Sent back',
          { tag: event.notification.tag, body: '', icon: './icon-192.png', badge: './icon-192.png' }
        ))
        .catch((err) => {
          console.error('[choresapp sw] background review failed, opening app instead:', err);
          event.notification.close();
          return focusOrOpenApp(url);
        })
    );
    return;
  }

  event.notification.close();
  event.waitUntil(focusOrOpenApp(url));
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
