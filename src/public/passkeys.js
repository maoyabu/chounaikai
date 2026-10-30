(() => {
  const api = window.SimpleWebAuthnBrowser;
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const supported = Boolean(window.PublicKeyCredential && window.isSecureContext && api && csrf);
  const request = async (path, data) => {
    const response = await fetch(`/api/passkeys${path}`, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!response.ok) throw new Error('request_failed');
    return response.json();
  };
  const login = document.getElementById('passkey-login');
  if (login) {
    const message = document.getElementById('passkey-login-message');
    if (!supported) { login.disabled = true; message.textContent = 'このブラウザまたは接続ではパスキーを利用できません。'; }
    login.addEventListener('click', async () => {
      login.disabled = true; message.textContent = '端末で本人確認してください。';
      try {
        const { options, flowId } = await request('/auth/options', {});
        const response = await api.startAuthentication({ optionsJSON: options });
        const result = await request('/auth/verify', { flowId, response });
        location.assign(result.next);
      } catch (error) { message.textContent = error.name === 'NotAllowedError' ? '端末での確認がキャンセルされました。' : 'パスキーで確認できませんでした。もう一度お試しください。'; login.disabled = false; }
    });
  }
  const panel = document.getElementById('passkeys');
  if (!panel) return;
  const message = document.getElementById('passkey-message');
  const status = document.getElementById('passkey-status');
  const list = document.getElementById('passkey-list');
  const password = document.getElementById('passkey-password');
  const register = document.getElementById('passkey-register');
  if (!supported) { register.disabled = true; message.textContent = 'このブラウザまたは接続ではパスキーを利用できません。'; }
  const refresh = async () => {
    const { credentials } = await request('/profile');
    status.textContent = credentials.length ? `${credentials.length}件登録済み` : '未登録';
    list.replaceChildren();
    if (!credentials.length) { const p = document.createElement('p'); p.className = 'help-text'; p.textContent = '登録済みのパスキーはありません。'; list.append(p); }
    credentials.forEach(item => {
      const row = document.createElement('div'); row.className = 'passkey-row';
      const label = document.createElement('span');
      const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString('ja-JP') : '';
      label.textContent = `${item.name || 'パスキー'}（${date}登録${item.lastUsedAt ? '・最終利用 ' + new Date(item.lastUsedAt).toLocaleDateString('ja-JP') : ''}）`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-quiet'; button.textContent = '削除';
      button.addEventListener('click', async () => {
        if (!password.value) { message.textContent = '現在のパスワードを入力してください。'; password.focus(); return; }
        button.disabled = true;
        try { await request('/profile/remove', { id: item._id, currentPassword: password.value }); password.value = ''; message.textContent = 'パスキーを削除しました。'; await refresh(); }
        catch { message.textContent = '削除できませんでした。パスワードを確認して再度お試しください。'; button.disabled = false; }
      });
      row.append(label, button); list.append(row);
    });
  };
  const load = () => refresh().catch(() => { status.textContent = '確認できません'; message.textContent = '登録状況を確認できませんでした。'; });
  load();
  panel.addEventListener('toggle', () => { if (panel.open) load(); });
  register.addEventListener('click', async () => {
    if (!password.value) { message.textContent = '現在のパスワードを入力してください。'; password.focus(); return; }
    register.disabled = true; message.textContent = '端末で本人確認してください。';
    try {
      const { options, flowId } = await request('/profile/register/options', { currentPassword: password.value });
      const response = await api.startRegistration({ optionsJSON: options });
      await request('/profile/register/verify', { flowId, response });
      password.value = ''; message.textContent = 'パスキーを登録しました。'; await refresh();
    } catch (error) { message.textContent = error.name === 'NotAllowedError' ? '端末での確認がキャンセルされました。' : '登録できませんでした。パスワードや端末の設定を確認してください。'; }
    finally { register.disabled = false; }
  });
})();
