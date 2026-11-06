(() => {
  const select = document.getElementById('support-category');
  select?.addEventListener('change', () => select.form.requestSubmit());
})();
