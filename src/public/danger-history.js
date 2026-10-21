document.querySelectorAll('[data-danger-focus]').forEach(button => button.addEventListener('click', () => {
  const element = document.getElementById('danger-history-map');
  const frame = document.getElementById('danger-history-frame');
  if (element) {
    if (window.focusDangerReport) window.focusDangerReport(button.dataset.dangerFocus);
    else window.pendingDangerReport = button.dataset.dangerFocus;
  } else if (frame) {
    frame.src = `https://www.google.com/maps?q=${encodeURIComponent(button.dataset.dangerQuery)}&output=embed`;
    document.querySelectorAll('[data-danger-focus]').forEach(photo => photo.setAttribute('aria-pressed', String(photo === button)));
  }
  (element || frame)?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}));
