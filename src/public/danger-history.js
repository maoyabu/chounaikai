document.querySelectorAll('[data-danger-focus]').forEach(button => button.addEventListener('click', () => {
  const frame = document.getElementById('danger-history-frame');
  if (!frame) return;
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(button.dataset.dangerQuery)}&output=embed`;
  document.querySelectorAll('[data-danger-focus]').forEach(photo => photo.setAttribute('aria-pressed', String(photo === button)));
  document.getElementById('danger-map-status').textContent = `${button.querySelector('img').alt}の場所を表示しています。`;
}));
