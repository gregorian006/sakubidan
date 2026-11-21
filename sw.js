// Service worker Saku Bidan: salinan offline + menampilkan pengingat dari server (Web Push).
const CACHE = 'saku-bidan-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ambil dari jaringan dulu; kalau offline pakai salinan terakhir
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|__)\//.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

// iOS mewajibkan setiap push menampilkan notifikasi, jadi selalu showNotification
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (er) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Saku Bidan', { body: d.body || '', tag: d.tag, icon: '/ikon-192.png' }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(w => w.length ? w[0].focus() : self.clients.openWindow('/#caregiver')));
});
