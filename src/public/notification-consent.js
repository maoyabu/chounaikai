(() => {
  const dialog = document.getElementById('notification-permission-dialog');
  if (!dialog) return;
  const profileToggle = document.getElementById('notification-toggle-input');
  const profileStatus = document.getElementById('notification-settings-status');
  const errorBox = document.getElementById('notification-consent-error');
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const currentSubscription = async () => (await navigator.serviceWorker.getRegistration('/assets/push-service-worker.js'))?.pushManager.getSubscription();
  const showError = message => {
    if (profileStatus) profileStatus.textContent = message;
    if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
  };
  const refresh = async () => {
    if (!supported) {
      if (profileToggle) profileToggle.disabled = true;
      if (profileStatus) profileStatus.textContent = 'このブラウザではブラウザ通知を利用できません。';
      return false;
    }
    const subscription = await currentSubscription();
    const registered = subscription && await fetch(`/api/notifications/push/status?endpoint=${encodeURIComponent(subscription.endpoint)}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { enabled: false }).then(data => data.enabled).catch(() => false);
    const enabled = Notification.permission === 'granted' && Boolean(registered);
    if (profileToggle) profileToggle.checked = enabled;
    if (profileStatus) profileStatus.textContent = enabled ? '通知はONです。' : Notification.permission === 'denied' ? '通知がブラウザで拒否されています。ブラウザのサイト設定から許可してください。' : '通知はOFFです。';
    return enabled;
  };
  const acknowledgePrompt = async () => {
    await fetch('/api/notifications/permission-prompt/seen', { method: 'POST', headers: { 'X-CSRF-Token': csrf() } }).catch(() => {});
  };
  const enable = async () => {
    errorBox.hidden = true;
    try {
      await window.enableWebPushNotifications();
      await acknowledgePrompt();
      dialog.close();
      localStorage.setItem('notification-prompt-dismissed', '1');
      await refresh();
    } catch (error) {
      const messages = {
        web_push_permission_denied: '通知は許可されませんでした。ブラウザのサイト設定を確認してください。',
        web_push_not_supported: 'このブラウザまたは接続環境では通知を利用できません。',
        web_push_not_configured: 'サーバーにWeb Push公開鍵が設定されていません。',
        web_push_key_http_503: '通知サーバーに一時的に接続できません。再度お試しください。',
        web_push_login_required: 'ログインの有効期限が切れました。再ログインしてください。',
        web_push_subscription_failed: '通知先の登録に失敗しました。'
      };
      showError(messages[error.message] || `通知を有効にできませんでした（${error.message || '原因不明'}）。`);
      if (profileToggle) profileToggle.checked = false;
    }
  };
  const disable = async () => {
    const subscription = await currentSubscription();
    if (subscription) {
      await fetch('/api/notifications/push-subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
    }
    await refresh();
  };

  document.getElementById('notification-enable-button')?.addEventListener('click', enable);
  document.querySelectorAll('[data-notification-dismiss]').forEach(button => button.addEventListener('click', async () => {
    await acknowledgePrompt();
    localStorage.setItem('notification-prompt-dismissed', '1');
    dialog.close();
  }));
  profileToggle?.addEventListener('change', () => profileToggle.checked ? enable() : disable());

  refresh().then(enabled => {
    if (enabled || !supported) {
      if (dialog.dataset.loginPrompt === 'true') acknowledgePrompt();
      return;
    }
    const loginPrompt = dialog.dataset.loginPrompt === 'true';
    const profilePrompt = location.pathname === '/profile' && Notification.permission === 'default' && !localStorage.getItem('notification-prompt-dismissed');
    if (loginPrompt || profilePrompt) dialog.showModal();
  }).catch(() => {});
  if (profileToggle) window.refreshNotificationSettings = refresh;
})();
