(() => {
  const rows = document.querySelectorAll('[data-finance-entry-row]');
  const menu = document.querySelector('.finance-entry-operation-dialog');
  const confirmation = document.querySelector('.finance-entry-delete-dialog');
  if (!menu || !confirmation) return;
  const edit = menu.querySelector('[data-finance-operation-edit]');
  const form = confirmation.querySelector('[data-finance-delete-form]');
  let selected;
  const open = row => {
    if (menu.open || confirmation.open) return;
    selected = row;
    const description = row.innerText.trim();
    menu.querySelector('[data-finance-operation-description]').textContent = description;
    confirmation.querySelector('[data-finance-delete-description]').textContent = description;
    edit.href = row.dataset.editUrl;
    form.action = row.dataset.deleteUrl;
    menu.showModal();
  };
  rows.forEach(row => {
    let timer;
    let origin;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    row.addEventListener('pointerdown', event => {
      cancel();
      if (!event.isPrimary || event.button !== 0) return;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { timer = undefined; open(row); }, 600);
    });
    row.addEventListener('pointermove', event => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(type => row.addEventListener(type, cancel));
    row.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); open(row); });
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        open(row);
      }
    });
  });
  edit.addEventListener('click', () => menu.close());
  menu.querySelector('[data-finance-operation-close]').addEventListener('click', () => menu.close());
  menu.querySelector('[data-finance-operation-delete]').addEventListener('click', () => {
    menu.close();
    confirmation.showModal();
  });
  confirmation.querySelector('[data-finance-delete-cancel]').addEventListener('click', () => confirmation.close());
  [menu, confirmation].forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => selected?.focus());
  });
})();
