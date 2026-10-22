document.querySelectorAll('[data-danger-focus]').forEach(button => button.addEventListener('click', () => {
  const frame = document.getElementById('danger-history-frame');
  if (!frame) return;
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(button.dataset.dangerQuery)}&output=embed`;
  document.querySelectorAll('[data-danger-focus]').forEach(photo => photo.setAttribute('aria-pressed', String(photo === button)));
  if (button.hasAttribute?.('data-good-place-enlarge')) {
    const dialog = document.getElementById('good-place-photo-dialog');
    const source = button.querySelector('img');
    if (dialog) {
      const photo = dialog.querySelector('img');
      photo.src = source.currentSrc || source.src;
      photo.alt = source.alt;
      dialog.showModal();
    }
  }
  document.getElementById('danger-map-status').textContent = `${button.querySelector('img').alt}の場所を表示しています。`;
}));

const photoDialog = document.getElementById('good-place-photo-dialog');
if (photoDialog?.querySelector) {
  photoDialog.querySelector('[data-close-good-place-photo]').addEventListener('click', () => photoDialog.close());
  photoDialog.addEventListener('click', event => {
    if (event.target !== photoDialog) return;
    const bounds = photoDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) photoDialog.close();
  });
}

document.querySelectorAll('[data-good-place-sort]').forEach(select => {
  select.addEventListener('change', () => select.form.requestSubmit());
});
