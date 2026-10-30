const rows = document.getElementById('benefit-rows');
const dialog = document.getElementById('benefit-dialog');
const editor = document.getElementById('benefit-editor');
const add = document.getElementById('add-benefit');
const status = document.getElementById('benefit-status');
let editingRow = null;
let returnFocus = null;
const names = ['Title', 'Content', 'Color', 'Icon'];
function refresh() {
  const items = [...rows.children];
  add.disabled = items.length >= 10;
  document.getElementById('benefit-empty').hidden = items.length > 0;
}
function openEditor(row, trigger) {
  editingRow = row;
  returnFocus = trigger;
  editor.reset();
  editor.elements.title.value = row?.querySelector('[name="benefitTitle"]').value || '';
  editor.elements.content.value = row?.querySelector('[name="benefitContent"]').value || '';
  editor.elements.color.value = row?.querySelector('[name="benefitColor"]').value || 'green';
  editor.elements.icon.value = row?.querySelector('[name="benefitIcon"]').value || 'town';
  document.getElementById('benefit-dialog-title').textContent = row ? 'メリットを編集' : 'メリットを追加';
  dialog.showModal();
  editor.elements.title.focus();
}
add.addEventListener('click', () => { if (rows.children.length < 10) openEditor(null, add); });
document.getElementById('cancel-benefit').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); });
rows.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('.benefit-row');
  const action = button.dataset.action;
  if (action === 'edit') { openEditor(row, button); return; }
  if (action === 'delete') {
    if (!window.confirm(`「${row.querySelector('.benefit-row-title').textContent}」を削除しますか？`)) return;
    row.remove(); add.focus();
  }
  refresh();
  status.textContent = '変更は未保存です。「変更を保存する」を押してください。';
});
editor.addEventListener('submit', event => {
  event.preventDefault();
  const title = editor.elements.title.value.trim();
  const content = editor.elements.content.value.trim();
  if (!title || !content) { editor.elements[title ? 'content' : 'title'].focus(); return; }
  if (!editingRow && rows.children.length >= 10) return;
  const row = editingRow || document.createElement('li');
  if (!editingRow) {
    row.className = 'content-card benefit-row';
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'benefit-drag-handle'; handle.textContent = '⠿'; handle.setAttribute('aria-label', 'ドラッグして並べ替え。上下キーでも移動できます'); row.append(handle);
    const summary = document.createElement('div'); summary.className = 'benefit-row-summary';
    const icon = document.createElement('span'); icon.className = 'benefit-row-icon'; icon.setAttribute('role', 'img'); summary.append(icon);
    const heading = document.createElement('strong'); heading.className = 'benefit-row-title'; summary.append(heading);
    const color = document.createElement('span'); color.className = 'benefit-row-color';
    const swatch = document.createElement('span'); swatch.className = 'benefit-color-swatch'; swatch.setAttribute('aria-hidden', 'true'); color.append(swatch);
    const colorName = document.createElement('span'); colorName.className = 'benefit-row-color-name'; color.append(colorName); summary.append(color); row.append(summary);
    names.forEach(name => { const input = document.createElement('input'); input.type = 'hidden'; input.name = `benefit${name}`; row.append(input); });
    const actions = document.createElement('div'); actions.className = 'benefit-row-actions';
    [['edit', '編集'], ['delete', '削除']].forEach(([action, label, aria]) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-quiet'; button.dataset.action = action; button.textContent = label; if (aria) button.setAttribute('aria-label', aria); if (action === 'delete') {
        button.classList.add('benefit-delete-button'); button.setAttribute('aria-label', '削除'); button.title = '削除';
        const template = document.createElement('template'); template.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>'; button.replaceChildren(template.content.cloneNode(true));
      }
      actions.append(button);
    });
    row.append(actions); rows.append(row);
  }
  const values = [title, content, editor.elements.color.value, editor.elements.icon.value];
  names.forEach((name, index) => { row.querySelector(`[name="benefit${name}"]`).value = values[index]; });
  row.querySelector('.benefit-row-title').textContent = title;
  const colorOption = editor.querySelector('input[name="color"]:checked').closest('label');
  const iconOption = editor.querySelector('input[name="icon"]:checked').closest('label');
  row.querySelector('.benefit-row-summary').className = `benefit-row-summary benefit-color-${editor.elements.color.value}`;
  row.querySelector('.benefit-row-color-name').textContent = colorOption.lastElementChild.textContent;
  const iconPreview = row.querySelector('.benefit-row-icon');
  iconPreview.replaceChildren(iconOption.querySelector('svg').cloneNode(true));
  iconPreview.setAttribute('aria-label', iconOption.lastElementChild.textContent);
  refresh(); dialog.close();
  row.querySelector('[data-action="edit"]').focus();
  status.textContent = '変更は未保存です。「変更を保存する」を押してください。';
});
refresh();

let drag = null;
let scrollFrame;
function announceOrder(row) {
  status.textContent = `${row.querySelector('.benefit-row-title').textContent}を${[...rows.children].indexOf(row) + 1}番目に移動しました。「変更を保存する」を押してください。`;
}
function placeDraggedRow() {
  const before = [...rows.children].filter(row => row !== drag.row).find(row => {
    const rect = row.getBoundingClientRect();
    return drag.y < rect.top + rect.height / 2;
  });
  if (drag.row.nextElementSibling !== (before || null)) rows.insertBefore(drag.row, before || null);
}
function scrollWhileDragging() {
  if (!drag) return;
  const delta = drag.y < 70 ? -12 : drag.y > window.innerHeight - 70 ? 12 : 0;
  if (delta) { window.scrollBy(0, delta); placeDraggedRow(); }
  scrollFrame = requestAnimationFrame(scrollWhileDragging);
}
rows.addEventListener('pointerdown', event => {
  const handle = event.target.closest('.benefit-drag-handle');
  if (!handle || !event.isPrimary || event.button !== 0) return;
  event.preventDefault(); handle.focus();
  const row = handle.closest('.benefit-row');
  drag = { row, handle, pointerId: event.pointerId, y: event.clientY, original: [...rows.children] };
  handle.setPointerCapture(event.pointerId);
  row.classList.add('is-dragging');
  scrollFrame = requestAnimationFrame(scrollWhileDragging);
});
rows.addEventListener('pointermove', event => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault(); drag.y = event.clientY; placeDraggedRow();
});
function finishDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const current = drag; drag = null;
  cancelAnimationFrame(scrollFrame);
  current.row.classList.remove('is-dragging');
  if (event.type === 'pointercancel') current.original.forEach(row => rows.append(row));
  if (current.handle.hasPointerCapture(event.pointerId)) current.handle.releasePointerCapture(event.pointerId);
  current.handle.focus();
  if (current.original.some((row, index) => rows.children[index] !== row)) announceOrder(current.row);
}
rows.addEventListener('pointerup', finishDrag);
rows.addEventListener('pointercancel', finishDrag);
rows.addEventListener('lostpointercapture', finishDrag);
rows.addEventListener('keydown', event => {
  const handle = event.target.closest('.benefit-drag-handle');
  if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key) || drag) return;
  event.preventDefault();
  const row = handle.closest('.benefit-row');
  if (event.key === 'ArrowUp' && row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling);
  else if (event.key === 'ArrowDown' && row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row);
  else return;
  handle.focus(); announceOrder(row);
});
