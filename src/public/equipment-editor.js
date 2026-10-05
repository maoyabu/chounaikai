(() => {
  const syncWishlist = form => {
    const wishlist = form.elements?.namedItem('wishlist');
    if (wishlist?.type !== 'checkbox') return;
    const update = () => {
      for (const name of ['tracked', 'lendable']) {
        const field = form.elements.namedItem(name);
        field.disabled = wishlist.checked;
        if (wishlist.checked) field.checked = false;
      }
    };
    wishlist.addEventListener('change', update);
    update();
  };
  document.querySelectorAll('.equipment-editor-form').forEach(syncWishlist);
  const dialog = document.getElementById('equipment-editor-dialog');
  if (!dialog) return;
  const content = dialog.querySelector('[data-equipment-editor-content]');
  const title = dialog.querySelector('#equipment-editor-title');
  let controller;
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const showError = (element, message) => { element.textContent = message; element.hidden = false; };
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-equipment-dialog]')) dialog.close();
  });
  dialog.addEventListener('close', () => { controller?.abort(); });
  document.querySelectorAll('[data-equipment-editor]').forEach(trigger => {
    trigger.addEventListener('click', async event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      controller?.abort();
      const request = new AbortController(); controller = request;
      title.textContent = trigger.dataset.equipmentEditor === 'edit' ? '備品の編集' : '設備・備品を追加';
      const loading = document.createElement('p'); loading.className = 'equipment-editor-loading'; loading.textContent = '読み込み中…';
      content.replaceChildren(loading); dialog.showModal();
      try {
        const url = new URL(trigger.href); url.searchParams.set('modal', '1');
        const response = await fetch(url, { headers, signal: request.signal });
        if (!response.ok) { const result = await response.json(); throw new Error(result.message || result.error || '処理できませんでした。'); }
        const html = await response.text();
        if (request.signal.aborted) return;
        content.innerHTML = html;
        const form = content.querySelector('.equipment-editor-form');
        if (!form) throw new Error('ログイン状態を確認して、画面を開き直してください。');
        syncWishlist(form);
        const error = form.querySelector('[data-equipment-editor-error]');
        const preview = form.querySelector('[data-equipment-image-preview]');
        const imageUrl = form.elements.namedItem('productImageUrl');
        imageUrl.addEventListener('input', () => {
          try { const image = new URL(imageUrl.value); if (!['http:', 'https:'].includes(image.protocol)) throw new Error(); preview.src = image.href; preview.hidden = false; }
          catch { preview.removeAttribute('src'); preview.hidden = true; }
        });
        preview.addEventListener('error', () => { preview.hidden = true; });
        form.addEventListener('submit', async submitEvent => {
          submitEvent.preventDefault();
          error.hidden = true;
          const save = form.querySelector('button[type="submit"]');
          save.disabled = true; save.textContent = '保存中…';
          try {
            const result = await fetch(form.action, { method: 'POST', headers, body: new URLSearchParams(new FormData(form)) });
            const data = await result.json();
            if (!result.ok || !data.ok) throw new Error(data.message || data.error || '保存できませんでした。');
            window.location.reload();
          } catch (failure) { showError(error, failure.message || '保存できませんでした。'); save.disabled = false; save.textContent = '保存'; }
        });
        form.elements.namedItem('name')?.focus();
      } catch (failure) {
        if (failure.name === 'AbortError') return;
        loading.className = 'alert alert-error'; loading.textContent = failure.message || '読み込めませんでした。'; content.replaceChildren(loading);
      }
    });
  });
})();
