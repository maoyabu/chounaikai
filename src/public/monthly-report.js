(() => {
  const selector = document.querySelector('[data-monthly-report-selector]');
  const month = selector?.querySelector('[data-report-month]');
  month?.addEventListener('change', () => {
    if (month.value && month.checkValidity()) selector.requestSubmit();
  });
  const dialog = document.getElementById('monthly-information-dialog');
  if (!dialog) return;
  const information = dialog.querySelector('textarea[name="information"]');
  document.querySelector('[data-monthly-information-open]')?.addEventListener('click', () => {
    // Cancelled edits must not replace the saved content when the editor is reopened.
    dialog.querySelector('form').reset();
    dialog.showModal();
    information?.focus();
  });
  dialog.querySelectorAll('[data-monthly-information-close]').forEach(button => {
    button.addEventListener('click', () => dialog.close());
  });
})();
