(() => {
  const root = document.getElementById('faq-manager');
  if (!root) return;
  const body = document.getElementById('faq-rows'), category = document.getElementById('faq-category');
  const status = document.getElementById('faq-status'), menu = document.getElementById('faq-actions');
  const rows = () => [...body.rows].filter(row => !row.hidden);
  let busy = false, dragged = null, timer, touchStart, touchRow, touchDragging = false, touchMoved = false;
  let menuOrigin;
  const closeMenu = (restoreFocus = false) => {
    menu.hidden = true;
    if (restoreFocus) menuOrigin?.focus();
  };
  const actions = (row, x, y) => {
    if (busy) return;
    menuOrigin = document.activeElement;
    document.getElementById('faq-edit').href = `${root.dataset.base}/${row.dataset.id}/edit`;
    document.getElementById('faq-delete').action = `${root.dataset.base}/${row.dataset.id}/delete`;
    menu.hidden = false;
    const rect = row.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x || rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y || rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
    document.getElementById('faq-edit').focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMenu(); });
  document.addEventListener('focusin', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length].focus();
    }
  });
  window.addEventListener('resize', () => closeMenu());
  document.addEventListener('scroll', () => closeMenu(), true);
  document.getElementById('faq-delete').onsubmit = () => { closeMenu(true); return confirm('このQ&Aを削除しますか？'); };
  category.onchange = () => {
    closeMenu();
    for (const row of body.rows) row.hidden = !!category.value && row.dataset.category !== category.value;
    document.getElementById('faq-empty').hidden = rows().length > 0;
  };
  const save = async () => {
    busy = true;
    category.disabled = true;
    status.textContent = '並び順を保存しています…';
    try {
      const response = await fetch(`${root.dataset.base}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': root.dataset.csrf }, body: JSON.stringify({ ids: rows().map(row => row.dataset.id), category: category.value }) });
      if (!response.ok || !(await response.json()).ok) throw new Error();
      status.textContent = '並び順を保存しました。';
    } catch {
      // Restore the last confirmed order instead of leaving an unsaved order visible.
      confirmed.forEach(row => body.append(row));
      status.textContent = '保存できませんでした。画面を再読み込みして、もう一度お試しください。';
    } finally { confirmed = [...body.rows]; busy = false; category.disabled = false; }
  };
  let confirmed = [...body.rows];
  const move = (source, target) => {
    const visible = rows();
    const order = [...body.rows];
    const from = visible.indexOf(source), to = visible.indexOf(target);
    visible.splice(from, 1); visible.splice(to, 0, source);
    let index = 0;
    order.map(row => row.hidden ? row : visible[index++]).forEach(row => body.append(row));
  };
  body.addEventListener('contextmenu', event => {
    const row = event.target.closest('tr');
    if (row && !event.target.closest('a')) { event.preventDefault(); actions(row, event.clientX, event.clientY); }
  });
  body.addEventListener('dragstart', event => {
    if (busy || !event.target.closest('[data-drag]')) { event.preventDefault(); return; }
    dragged = event.target.closest('tr');
    event.dataTransfer.setData('text/plain', dragged.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
    dragged.classList.add('faq-dragging');
  });
  body.addEventListener('dragover', event => { if (dragged) event.preventDefault(); });
  body.addEventListener('drop', event => {
    const target = event.target.closest('tr');
    if (dragged && target && target !== dragged) { event.preventDefault(); move(dragged, target); save(); }
  });
  body.addEventListener('dragend', () => { dragged?.classList.remove('faq-dragging'); dragged = null; });
  body.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || busy) return;
    const row = event.target.closest('tr');
    if (!row) return;
    touchMoved = false; touchRow = row; touchStart = { x: event.clientX, y: event.clientY };
    touchDragging = !!event.target.closest('[data-drag]');
    if (!touchDragging && !event.target.closest('a,button')) timer = setTimeout(() => { timer = null; actions(row, touchStart.x, touchStart.y); touchRow = null; }, 600);
  });
  body.addEventListener('pointermove', event => {
    if (!touchRow) return;
    if (Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) { clearTimeout(timer); touchMoved = true; }
    if (touchDragging && touchMoved) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('#faq-rows tr');
      if (target && !target.hidden && target !== touchRow) move(touchRow, target);
    }
  });
  const endTouch = () => {
    clearTimeout(timer);
    if (touchRow && touchDragging && touchMoved) save();
    touchRow = null; touchDragging = false;
  };
  document.addEventListener('pointerup', endTouch);
  document.addEventListener('pointercancel', () => { clearTimeout(timer); if (touchDragging) confirmed.forEach(row => body.append(row)); touchRow = null; touchDragging = false; });
})();
