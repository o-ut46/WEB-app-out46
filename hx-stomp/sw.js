// OUT HX-STOMP まるわかり辞典: オフライン対応。ネット優先で更新を届け、圏外や遅い回線ではキャッシュを使う。
const CACHE = 'hx-stomp-v1';
const CORE = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('hx-stomp-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate' ? './' : e.request;
  e.respondWith(caches.open(CACHE).then(c => {
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r && r.ok) c.put(key, r.clone()); return r; });
    const slow = new Promise(res => setTimeout(() => c.match(key).then(m => { if (m) res(m); }), 3000));
    return Promise.race([net.catch(() => c.match(key).then(m => m || Promise.reject(new Error('offline')))), slow]);
  }));
});
