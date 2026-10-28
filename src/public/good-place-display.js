document.querySelectorAll('[data-good-place-display]').forEach(toggle => {
  const target = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!target) return;
  const key = `good-place-display:${toggle.dataset.goodPlaceDisplay}`;
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === 'hidden' || saved === 'visible') toggle.checked = saved === 'visible';
  } catch { /* Display controls also work when storage is unavailable. */ }
  const apply = () => { target.hidden = !toggle.checked; };
  apply();
  toggle.addEventListener('change', () => {
    apply();
    try { window.localStorage.setItem(key, toggle.checked ? 'visible' : 'hidden'); } catch { /* Storage is optional. */ }
  });
});
