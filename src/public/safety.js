document.querySelectorAll('[data-safety-member]').forEach(row => {
  const checkbox = row.querySelector('[data-safety-confirmed]');
  const select = row.querySelector('[data-safety-select]');
  const refresh = () => { select.disabled = !checkbox.checked; };
  checkbox.addEventListener('change', refresh);
  refresh();
});
