(() => {
  const paths = { disclosure: '/profile/disclosure?embedded=1', withdrawals: '/profile/withdrawals?embedded=1' };
  const updateSuccessor = select => {
    const label = select.form?.querySelector('[data-successor]');
    if (!label) return;
    label.hidden = select.value !== 'representative';
    label.querySelector('select').required = !label.hidden;
  };
  window.loadProfileAccountPanel = async name => {
    if (!Object.hasOwn(paths, name)) return;
    const container = document.querySelector(`[data-account-content="${name}"]`);
    if (!container || container.dataset.loaded || container.dataset.loading) return;
    container.dataset.loading = 'true';
    container.setAttribute('aria-busy', 'true');
    container.textContent = '読み込み中です…';
    try {
      const response = await fetch(paths[name], { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('panel_unavailable');
      // These authenticated same-origin endpoints return escaped EJS form fragments.
      container.innerHTML = await response.text();
      container.querySelectorAll('[data-withdrawal-scope]').forEach(updateSuccessor);
      container.dataset.loaded = 'true';
    } catch {
      container.textContent = '';
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = '読み込めませんでした。ログイン状態と通信を確認して、もう一度お試しください。';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'button button-quiet'; retry.textContent = '再読み込み';
      retry.addEventListener('click', () => window.loadProfileAccountPanel(name));
      container.append(message, retry);
    } finally {
      delete container.dataset.loading;
      container.removeAttribute('aria-busy');
    }
  };
  document.addEventListener('change', event => {
    if (event.target.matches('[data-withdrawal-scope]')) updateSuccessor(event.target);
  });
})();
