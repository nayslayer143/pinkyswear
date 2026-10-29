const CACHE_VERSION = 'pinkyswear-v9';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './app.js',
  './db.js',
  './offlineSync.js',
  './populateTemplates.js',
  './templateThumbnails.js',
  './templateSchema.js',
  './manifest.json',
  './icon.svg'
];
const PINNED_DEPENDENCIES = [
  'https://cdn.quilljs.com/1.3.6/quill.snow.css',
  'https://cdn.jsdelivr.net/npm/dexie@3.2.2/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/signature_pad@4.0.0/dist/signature_pad.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.quilljs.com/1.3.6/quill.min.js'
];

const LOGO_HOST = 'storage.ning.com';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_SHELL);
    await Promise.allSettled(PINNED_DEPENDENCIES.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('pinkyswear-') && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  const trustedAsset = url.origin === self.location.origin
    || ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'cdn.quilljs.com', LOGO_HOST].includes(url.hostname);
  if (trustedAsset) event.respondWith(staleWhileRevalidate(request, event));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE_VERSION)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match('./index.html'));
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  try { return await refresh; } catch {
    return new Response('Offline asset unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
