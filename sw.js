const CACHE = 'rhinos-crm-v4';
const VAPID_PUBLIC_KEY = 'BDvoAlfKmD2fRxvvSH8-IHswdOmwRnnrvjpo3hWpMliFU4XiBq25X_P4fsOX3m-j58LKgECgTenKlcya5tv3l6s';
const STATIC = ['/'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch(err) { d = { title: e.data?.text() || '🦏 RhinosCRM' }; }

  const title = d.title || '🦏 RhinosCRM';
  const options = {
    body: d.body || '',
    icon: '/icon-192.png',
    data: { url: d.url || '/' },
    requireInteraction: false,
    // iOS Safari no soporta badge, vibrate ni actions — se omiten para compatibilidad
  };
  // Solo agregar en plataformas que lo soportan
  if (typeof navigator !== 'undefined' && !navigator.userAgent?.includes('Safari')) {
    options.badge = '/icon-192.png';
    options.vibrate = [200, 100, 200];
  }
  if (d.tag) options.tag = d.tag;

  e.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); try { existing.navigate(url); } catch(err) {} }
      else clients.openWindow(url);
    })
  );
});

// Mantener SW activo (evita que iOS lo termine prematuramente)
self.addEventListener('message', e => {
  if (e.data === 'PING') e.source?.postMessage('PONG');
});
