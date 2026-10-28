(() => {
  const dialog = document.getElementById('good-place-detail-modal');
  if (!dialog) return;
  const frame = dialog.querySelector('[data-good-place-detail-frame]');
  const map = document.getElementById('danger-history-frame');
  const items = [...document.querySelectorAll('[data-danger-report]')];
  function openDetail(url, item) {
    items.forEach(row => row.classList.toggle('is-selected', row === item));
    document.querySelectorAll('[data-danger-focus]').forEach(button => {
      button.setAttribute('aria-pressed', String(item?.contains(button) || false));
    });
    if (item && map) {
      const photo = item.querySelector('[data-danger-query]');
      map.src = `https://www.google.com/maps?q=${encodeURIComponent(photo.dataset.dangerQuery)}&output=embed`;
      document.getElementById('danger-map-status').textContent = `${photo.querySelector('img').alt}の場所を表示しています。`;
    }
    frame.src = url;
    if (!dialog.open) dialog.showModal();
  }
  document.querySelectorAll('[data-good-place-detail]').forEach(link => {
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      openDetail(link.dataset.goodPlaceDetail, link.closest('[data-danger-report]'));
    });
  });
  dialog.querySelector('[data-close-good-place-detail]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  frame.addEventListener('load', () => {
    // Keep the existing detail actions and their redirects inside the modal.
    const doc = frame.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = 'body>header,body>footer,.good-place-detail-page>.back-link{display:none!important}.good-place-detail-page{padding:12px;margin:0 auto}';
    doc.head.append(style);
    const detailMap = doc.querySelector('.good-place-location-link iframe');
    if (detailMap && map) map.src = detailMap.src;
  });
  const selected = new URLSearchParams(location.search).get('selected');
  if (selected && /^[a-f\d]{24}$/i.test(selected)) {
    const item = items.find(row => row.dataset.dangerReport === selected);
    const base = location.pathname.replace(/\/$/, '');
    const params = new URLSearchParams(location.search);
    params.delete('selected');
    params.delete('page');
    params.delete('sort');
    openDetail(`${base}/${selected}${params.size ? `?${params}` : ''}${location.hash || ''}`, item);
    item?.scrollIntoView({ block: 'nearest' });
  }
})();
