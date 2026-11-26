(() => {
  const form = document.getElementById('attendance-response-form');
  if (!form) return;
  const error = document.getElementById('attendance-response-error');
  const groups = [...form.querySelectorAll('[data-attendance-answer]')];
  for (const group of groups) {
    const input = group.querySelector('input[type="hidden"]');
    const buttons = [...group.querySelectorAll('[data-answer]')];
    for (const button of buttons) button.addEventListener('click', () => {
      input.value = button.dataset.answer;
      for (const choice of buttons) choice.setAttribute('aria-pressed', String(choice === button));
      if (groups.every(row => row.querySelector('input[type="hidden"]').value)) error.hidden = true;
    });
  }
  form.addEventListener('submit', event => {
    const missing = groups.find(group => !group.querySelector('input[type="hidden"]').value);
    if (!missing) return;
    event.preventDefault(); error.hidden = false;
    missing.querySelector('[data-answer]').focus();
  });
})();
