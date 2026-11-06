(() => {
  const select = document.getElementById('support-category');
  select?.addEventListener('change', () => select.form.requestSubmit());
  const dialog = document.querySelector('.faq-image-dialog');
  if (!dialog) return;
  const enlarged = dialog.querySelector('img');
  document.querySelectorAll('.faq-image-trigger').forEach(button => {
    button.addEventListener('click', () => {
      const image = button.querySelector('img');
      enlarged.src = image.src;
      enlarged.alt = image.alt;
      dialog.showModal();
    });
  });
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    enlarged.removeAttribute('src');
    enlarged.alt = '';
  });
})();
