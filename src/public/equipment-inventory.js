(() => {
  const refreshCounts = place => {
    const counts = {};
    place.querySelectorAll('[data-inventory-group]').forEach(group => {
      const count = group.querySelectorAll('[data-inventory-item]').length;
      counts[group.dataset.inventoryGroup] = count;
      group.querySelector('[data-inventory-count]').textContent = `${count}件`;
    });
    const name = place.querySelector('[name="place"]').value;
    document.querySelectorAll('[data-inventory-place-count]').forEach(label => {
      if (label.dataset.inventoryPlaceCount === name) label.textContent = `未：${counts.unchecked}／済：${counts.checked}`;
    });
  };
  document.querySelectorAll('[data-inventory-form]').forEach(form => {
    const item = form.closest('[data-inventory-item]');
    const place = form.closest('.equipment-inventory-place');
    const checkbox = form.elements.checked;
    const status = form.querySelector('[data-inventory-status]');
    const retry = form.querySelector('[data-inventory-retry]');
    let savedChecked = form.dataset.savedChecked === 'true';
    let revision = 0;
    let queue = Promise.resolve();
    const save = () => {
      if (!form.reportValidity()) { checkbox.checked = savedChecked; return; }
      const current = ++revision;
      const body = new URLSearchParams(new FormData(form));
      status.textContent = '保存中…';
      retry.hidden = true;
      queue = queue.then(async () => {
        try {
          const response = await fetch(form.action, {
            method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, body,
          });
          if (response.redirected) throw new Error('画面を更新してログイン状態を確認してください。');
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || '保存できませんでした。');
          savedChecked = result.checked;
          if (current !== revision) return;
          const target = place.querySelector(`[data-inventory-group="${savedChecked ? 'checked' : 'unchecked'}"]`);
          if (item.parentElement !== target) target.append(item);
          refreshCounts(place);
          status.textContent = '保存しました';
        } catch (error) {
          if (current !== revision) return;
          checkbox.checked = savedChecked;
          // Keep the row in the group of the last successfully saved state.
          const target = place.querySelector(`[data-inventory-group="${savedChecked ? 'checked' : 'unchecked'}"]`);
          if (item.parentElement !== target) target.append(item);
          refreshCounts(place);
          status.textContent = `未保存：${error.message} 数量・コメントを確認して再試行してください。`;
          retry.hidden = false;
        }
      });
    };
    form.addEventListener('change', save);
    form.addEventListener('submit', event => { event.preventDefault(); save(); });
    retry.addEventListener('click', save);
  });
  document.querySelectorAll('.equipment-toolbar a[href^="#place-"]').forEach(link => {
    link.addEventListener('click', () => {
      const place = document.getElementById(link.getAttribute('href').slice(1));
      if (place) place.open = true;
    });
  });
})();
