const updateBadge = async count => {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    if (Number.isSafeInteger(count) && count >= 0) {
      if (count === 0 && 'clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
      else await self.navigator.setAppBadge(count);
    } else await self.navigator.setAppBadge();
  } catch (_) { /* Badge settings must not interfere with notifications. */ }
};

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'まちの伝言板', body: event.data?.text() || '' }; }
  event.waitUntil(Promise.allSettled([updateBadge(data.unreadCount), self.registration.showNotification(data.title || 'まちの伝言板', {
    body: data.body || '', tag: data.tag || 'chounaikai-notification', data: { url: data.url || '/' }
  })]));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
    const existing = list.find(client => client.url === target);
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});
