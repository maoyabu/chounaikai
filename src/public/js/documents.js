const search = document.getElementById('drive-search');
search?.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase('ja-JP'); let visible = 0;
  document.querySelectorAll('[data-drive-name]').forEach(item => { item.hidden = !item.dataset.driveName.toLocaleLowerCase('ja-JP').includes(query); if (!item.hidden) visible++; });
  document.getElementById('drive-empty').hidden = visible > 0;
});
document.getElementById('drive-upload')?.addEventListener('submit', event => {
  const form = event.currentTarget, files = Array.from(form.elements.file.files);
  const status = document.getElementById('drive-upload-status');
  let error = '';
  if (!files.length || files.length > 10) error = 'ファイルは1〜10件選択してください。';
  else if (files.some(file => !file.size || file.size > 20 * 1024 * 1024)) error = '各ファイルは空でない20MB以下のものを選択してください。';
  else if (files.some(file => !/\.(pdf|xlsx|xls)$/i.test(file.name))) error = 'PDFまたはExcel（.xlsx・.xls）を選択してください。';
  if (error) { event.preventDefault(); status.textContent = error; return; }
  form.querySelector('button').disabled = true;
  status.textContent = `${files.length}件のファイルをアップロード中です。完了するまでお待ちください。`;
});

document.getElementById('drive-copy-uri')?.addEventListener('click', async event => {
  const input = document.getElementById('drive-callback-uri');
  const status = document.getElementById('drive-copy-status');
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = '';
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(input.value); copied = true; } catch { /* Try manual selection below. */ }
    }
    if (!copied) {
      input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
      copied = document.execCommand('copy');
    }
    status.textContent = copied ? 'コピーしました' : 'コピーできませんでした。URLを選択してコピーしてください。';
  } catch {
    status.textContent = 'コピーできませんでした。URLを選択してコピーしてください。';
  } finally { button.disabled = false; }
});
