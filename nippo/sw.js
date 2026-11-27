/* O-UT 乗務日報リーダー Service Worker (PWA)
   - アプリ本体（index.html / アイコン等）はキャッシュ優先で、オフラインでも開けるようにする
   - 天気・イベントのデータ（cal-data.js / ev-data.js）はネットワーク優先で、更新があれば新しいものを使う
   - データや本体を更新したら CACHE の日付を変えること（変えないと古い本体が残ることがある） */
const CACHE = "out-nippo-v20261127c";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png", "詳しい地図/index.html"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // CDN等は対象外
  const isData = url.pathname.endsWith("cal-data.js") || url.pathname.endsWith("ev-data.js");
  if (isData) {
    // データはネットワーク優先、ダメならキャッシュ
    e.respondWith(fetch(e.request).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // 本体はキャッシュ優先、無ければネットワーク（成功したらキャッシュへ）
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
