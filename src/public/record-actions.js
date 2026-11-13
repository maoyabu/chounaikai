(() => {
  const menu = document.querySelector('.record-actions-dialog');
  const confirmation = document.querySelector('.record-delete-dialog');
  if (!menu || !confirmation) return;
  const selector = '.association-event-manage-item, [data-member-row], [data-open-record], .annual-officer-record-list > article, [data-open-plan-edit]';
  const rows = document.querySelectorAll(selector);
  let selected;
  let pendingDelete;
  const deleteButton = menu.querySelector('[data-record-actions-delete]');
  const deleteForm = row => [...row.querySelectorAll('form[action]')].find(form => form.getAttribute('action').endsWith('/delete') && !form.closest('dialog'));
  const title = row => row.querySelector('strong')?.textContent.trim() || '選択した項目';
  const open = row => {
    if (menu.open || confirmation.open) return;
    selected = row;
    menu.querySelector('[data-record-actions-name]').textContent = title(row);
    deleteButton.hidden = !deleteForm(row);
    menu.querySelector('[data-record-actions-report]').hidden = !row.querySelector('.association-event-completed-tag');
    menu.showModal();
  };
  menu.querySelector('[data-record-actions-edit]').addEventListener('click', () => {
    menu.close();
    const trigger = selected.querySelector('[data-event-open^="edit-event-"]');
    if (trigger) trigger.click();
    else selected.dispatchEvent(new CustomEvent('record-edit'));
  });
  menu.querySelector('[data-record-actions-report]').addEventListener('click', () => {
    menu.close();
    selected.querySelector('.association-event-completed-tag')?.dispatchEvent(new CustomEvent('record-report', { bubbles: true }));
  });
  deleteButton.addEventListener('click', () => {
    const form = deleteForm(selected);
    menu.close();
    form?.requestSubmit();
  });
  menu.querySelectorAll('[data-record-actions-close]').forEach(button => button.addEventListener('click', () => menu.close()));
  confirmation.querySelector('[data-record-delete-cancel]').addEventListener('click', () => confirmation.close());
  confirmation.querySelector('[data-record-delete-confirm]').addEventListener('click', () => {
    const form = pendingDelete;
    confirmation.close();
    if (!form) return;
    form.dataset.deleteConfirmed = 'true';
    form.requestSubmit();
  });
  [menu, confirmation].forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  rows.forEach(row => {
    row.classList.add('record-actions-enabled');
    row.tabIndex = 0;
    row.setAttribute('aria-haspopup', 'dialog');
    row.setAttribute('aria-label', `${title(row)}：長押しで操作（Enter・右クリックでも開けます）`);
    const form = deleteForm(row);
    if (form) {
      form.hidden = true;
      form.onsubmit = null;
      form.addEventListener('submit', event => {
        if (form.dataset.deleteConfirmed === 'true') { delete form.dataset.deleteConfirmed; return; }
        event.preventDefault();
        selected = row;
        pendingDelete = form;
        confirmation.querySelector('[data-record-delete-name]').textContent = title(row);
        confirmation.showModal();
      });
    }
    let timer;
    let origin;
    let pressed = false;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const interactive = target => target.closest('a, button, input, select, textarea, form, dialog, label');
    row.addEventListener('pointerdown', event => {
      cancel();
      pressed = false;
      if (!event.isPrimary || event.button !== 0 || interactive(event.target)) return;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { pressed = true; open(row); }, 600);
    });
    row.addEventListener('pointermove', event => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(type => row.addEventListener(type, cancel));
    row.addEventListener('click', event => {
      if (pressed && !interactive(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); pressed = false; }
    }, true);
    row.addEventListener('contextmenu', event => {
      if (interactive(event.target)) return;
      event.preventDefault(); cancel(); open(row);
    });
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (['Enter', ' ', 'ContextMenu'].includes(event.key) || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); open(row);
      }
    });
  });
  document.querySelectorAll('.association-event-manage-list, .member-directory-list, .annual-officer-record-list, .annual-plan-list, .resident-selection-list:has([data-open-record])').forEach(list => {
    if (!list.querySelector('.record-actions-enabled')) return;
    const help = document.createElement('p');
    help.className = 'help-text record-actions-help';
    help.textContent = '項目を長押しすると操作を選べます（パソコンでは右クリック、または項目を選択してEnter）。';
    list.before(help);
  });
})();
