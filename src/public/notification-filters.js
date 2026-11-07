(() => {
  const form = document.querySelector('.notification-filters');
  if (!form) return;
  form.addEventListener('change', event => {
    if (event.target.matches('select, input[type="checkbox"]')) form.requestSubmit();
  });
})();
