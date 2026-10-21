document.querySelectorAll('[data-danger-position]').forEach(button => button.addEventListener('click', () => {
  const [lat, lng] = button.dataset.dangerPosition.split(',').map(Number);
  const frame = document.getElementById('danger-history-frame');
  if (frame) frame.src = `https://www.google.com/maps?q=${lat},${lng}&output=embed`;
  else window.focusDangerPosition?.(lat, lng);
  (frame || document.getElementById('danger-history-map'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}));

document.querySelectorAll('[data-danger-query]').forEach(button => button.addEventListener('click', () => {
  const frame = document.getElementById('danger-history-frame');
  if (!frame) return;
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(button.dataset.dangerQuery)}&output=embed`;
  frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
}));
