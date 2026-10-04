(() => {
  document.querySelectorAll('[data-system-contact-open]').forEach(button => {
    const dialog = document.getElementById(button.dataset.systemContactOpen);
    if (!dialog) return;
    button.addEventListener('click', () => dialog.showModal());
    dialog.querySelector('[data-system-contact-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    const input = dialog.querySelector('[name="attachments"]');
    if (!input) return;
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.setCustomValidity(files.length > 3 || files.some(file => file.size > 15 * 1024 * 1024 || !file.size) ? '添付ファイルは3個まで、1個15MB以下で選択してください。' : '');
      input.reportValidity();
    });
  });
})();
