document.querySelectorAll('[data-alert-open], [data-alert-detail]').forEach(button => {
  button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.alertOpen || button.dataset.alertDetail);
    if (dialog && !dialog.open) dialog.showModal();
  });
});
document.querySelectorAll('[data-alert-close]').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog')?.close());
});
document.querySelectorAll('.alert-level-overview, .alert-level-detail').forEach(dialog => {
  dialog.addEventListener('click', event => {
    // Ignore clicks from a nested detail dialog when closing the overview backdrop.
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});
