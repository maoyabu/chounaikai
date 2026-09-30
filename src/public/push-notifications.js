// Call window.enableWebPushNotifications() from the user's notification settings
// after an explicit click. Browsers must not be prompted on page load.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.getRegistration('/assets/push-service-worker.js')
    .then(registration => registration?.update()).catch(() => {});
}
const fetchWebPushPublicKey = async () => {
  const response = await fetch('/api/notifications/push/public-key', { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === 'web_push_not_configured') throw new Error('web_push_not_configured');
    if (response.status === 401) throw new Error('web_push_login_required');
    throw new Error(`web_push_key_http_${response.status}`);
  }
  if (!data.publicKey) throw new Error('web_push_public_key_missing');
  return data.publicKey;
};

window.enableWebPushNotifications = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) throw new Error('web_push_not_supported');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  // Keep the permission request directly inside the user's click handler.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('web_push_permission_denied');
  const publicKey = await fetchWebPushPublicKey();
  const registration = await navigator.serviceWorker.register('/assets/push-service-worker.js');
  if (!registration.active) {
    await new Promise((resolve, reject) => {
      const worker = registration.installing || registration.waiting;
      if (!worker) return reject(new Error('web_push_worker_unavailable'));
      const timeout = setTimeout(() => { worker.removeEventListener('statechange', check); reject(new Error('web_push_worker_timeout')); }, 15000);
      const check = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          clearTimeout(timeout);
          worker.removeEventListener('statechange', check);
          worker.state === 'activated' ? resolve() : reject(new Error('web_push_worker_unavailable'));
        }
      };
      worker.addEventListener('statechange', check);
      check();
    });
  }
  const base64ToBytes = (value) => {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const raw = atob(padded);
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  };
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
  const response = await fetch('/api/notifications/push-subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(subscription) });
  if (!response.ok) throw new Error('web_push_subscription_failed');
  return subscription;
};
