document.querySelectorAll('[data-shelter-open]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.shelterOpen)?.showModal()));
document.querySelectorAll('[data-shelter-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog')?.close()));
document.querySelectorAll('.shelter-dialog').forEach(dialog => {
  dialog.addEventListener('close', () => dialog.querySelector('form')?.reset());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
document.querySelectorAll('[data-shelter-select]').forEach(link => link.addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const frame = document.getElementById('shelter-map-frame');
  if (!frame) return;
  event.preventDefault();
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(link.dataset.shelterAddress)}&output=embed`;
  document.getElementById('shelter-map-external').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(link.dataset.shelterAddress)}`;
  document.getElementById('shelter-map-title').textContent = link.dataset.shelterName;
  document.getElementById('shelter-map-status').textContent = `${link.dataset.shelterName}の場所を表示しています。`;
  document.querySelectorAll('[data-shelter-select]').forEach(item => {
    if (item === link) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-shelter-details]').forEach(item => { item.hidden = item.dataset.shelterDetails !== link.dataset.shelterSelect; });
  document.getElementById('shelter-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const url = new URL(location.href); url.searchParams.set('selected', link.dataset.shelterSelect); url.hash = 'shelter-map'; history.replaceState(null, '', url);
}));
