// Fast Pedidos - Service Worker com Suporte a Web Push & PWA Offline
const CACHE_NAME = 'fastpedidos-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './pwa-192x192.png',
  './pwa-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Cache parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Manipulação do evento PUSH (Disparado quando a tela está apagada ou o app em segundo plano)
self.addEventListener('push', (event) => {
  let data = {
    title: '🛵 Novo Pedido para Entrega!',
    body: 'Você recebeu um novo pedido para entrega.',
    orderId: 'novo',
    url: '/?portal=motoboy'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = Object.assign({}, data, parsed);
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const notificationTitle = data.title || '🛵 Novo Pedido Chegou!';
  const notificationOptions = {
    body: data.body || 'Um novo pedido foi atribuído a você no Fast Pedidos.',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: data.tag || `order-${data.orderId || Date.now()}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [350, 100, 350, 100, 600],
    data: {
      url: data.url || '/?portal=motoboy',
      orderId: data.orderId
    },
    actions: [
      { action: 'open_order', title: 'Abrir Pedidos 🛵' },
      { action: 'dismiss', title: 'Fechar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(notificationTitle, notificationOptions)
  );
});

// Clique na notificação na tela de bloqueio ou barra de status
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) 
    ? event.notification.data.url 
    : '/?portal=motoboy';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.includes('portal=motoboy') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
