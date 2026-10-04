const search = document.getElementById('drive-search');
search?.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase('ja-JP'); let visible = 0;
  document.querySelectorAll('[data-drive-name]').forEach(item => { item.hidden = !item.dataset.driveName.toLocaleLowerCase('ja-JP').includes(query); if (!item.hidden) visible++; });
  document.getElementById('drive-empty').hidden = visible > 0;
});
document.getElementById('drive-upload')?.addEventListener('submit', event => {
  const form = event.currentTarget, file = form.elements.file.files[0];
  if (!file || file.size > 20 * 1024 * 1024) { event.preventDefault(); document.getElementById('drive-upload-status').textContent = '20MB以下のファイルを選択してください。'; return; }
  form.querySelector('button').disabled = true;
  document.getElementById('drive-upload-status').textContent = 'アップロード中です。完了するまでお待ちください。';
});
