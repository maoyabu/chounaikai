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
  items.forEach((row, index) => {
    row.querySelector('[data-action="up"]').disabled = index === 0;
    row.querySelector('[data-action="down"]').disabled = index === items.length - 1;
  });
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
  if (action === 'up' && row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling);
  if (action === 'down' && row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row);
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
    const heading = document.createElement('strong'); heading.className = 'benefit-row-title'; row.append(heading);
    names.forEach(name => { const input = document.createElement('input'); input.type = 'hidden'; input.name = `benefit${name}`; row.append(input); });
    const actions = document.createElement('div'); actions.className = 'benefit-row-actions';
    [['up', '↑', '上に移動'], ['down', '↓', '下に移動'], ['edit', '編集'], ['delete', '削除']].forEach(([action, label, aria]) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-quiet'; button.dataset.action = action; button.textContent = label; if (aria) button.setAttribute('aria-label', aria); actions.append(button);
    });
    row.append(actions); rows.append(row);
  }
  const values = [title, content, editor.elements.color.value, editor.elements.icon.value];
  names.forEach((name, index) => { row.querySelector(`[name="benefit${name}"]`).value = values[index]; });
  row.querySelector('.benefit-row-title').textContent = title;
  refresh(); dialog.close();
  row.querySelector('[data-action="edit"]').focus();
  status.textContent = '変更は未保存です。「変更を保存する」を押してください。';
});
refresh();
