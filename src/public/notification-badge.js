(() => {
  // Browser tabs and unsupported devices continue to work without a badge.
  if (!('setAppBadge' in navigator)) return;
  let busy = false;
  const refresh = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const response = await fetch('/api/notifications/unread-count', { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) {
        if ('clearAppBadge' in navigator) await navigator.clearAppBadge();
        return;
      }
      if (!response.ok) return;
      const { unreadCount } = await response.json();
      if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) return;
      if (unreadCount === 0 && 'clearAppBadge' in navigator) await navigator.clearAppBadge();
      else await navigator.setAppBadge(unreadCount);
    } catch (_) { /* Offline/API/OS failures leave the existing badge intact. */ }
    finally { busy = false; }
  };
  window.refreshNotificationBadge = refresh;
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  document.addEventListener('notifications-changed', refresh);
  setInterval(refresh, 30000);
  refresh();
})();
