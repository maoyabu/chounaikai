(() => {
  const dialog = document.querySelector('.notification-modal');
  if (!dialog) return;
  const content = dialog.querySelector('[data-notification-content]');
  const error = dialog.querySelector('[data-notification-error]');
  let changed = false;
  let controller;
  dialog.querySelector('[data-notification-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    controller?.abort();
    if (changed) {
      const url = new URL(location.href);
      if (url.pathname === '/dashboard') url.searchParams.set('notifications', 'open');
      location.replace(url.href);
    }
  });
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[data-notification-modal]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    controller?.abort();
    controller = new AbortController();
    content.textContent = '読み込み中…';
    error.hidden = true;
    dialog.showModal();
    try {
      const url = new URL(link.href);
      url.searchParams.set('modal', '1');
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok || response.redirected) throw new Error();
      const html = await response.text();
      if (!dialog.open) return;
      const documentFragment = new DOMParser().parseFromString(html, 'text/html');
      const main = documentFragment.querySelector('main');
      content.replaceChildren(...(main || documentFragment.body).childNodes);
      changed = true;
      document.dispatchEvent(new Event('notifications-changed'));
    } catch (failure) {
      if (failure.name === 'AbortError') return;
      content.replaceChildren();
      error.textContent = 'お知らせを読み込めませんでした。閉じてからもう一度お試しください。';
      error.hidden = false;
    }
  });
  dialog.addEventListener('submit', async event => {
    const form = event.target;
    if (!/^\/notifications\/[^/]+\/(state|delete)$/.test(new URL(form.action).pathname)) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.submitter;
    if (button) button.disabled = true;
    error.hidden = true;
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      if (!response.ok || response.redirected) throw new Error();
      changed = true;
      dialog.close();
    } catch (_) {
      error.textContent = '操作を保存できませんでした。もう一度お試しください。';
      error.hidden = false;
    } finally { if (button) button.disabled = false; }
  });
})();
