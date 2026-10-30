const rows = document.getElementById('benefit-rows');
const prototype = rows.firstElementChild.cloneNode(true);
document.getElementById('add-benefit').addEventListener('click', () => {
  if (rows.children.length >= 30) { document.getElementById('benefit-limit').textContent = 'メリットは30件まで登録できます。'; return; }
  const row = prototype.cloneNode(true);
  row.querySelectorAll('input, textarea').forEach(input => { input.value = ''; });
  rows.append(row);
  row.querySelector('input').focus();
});
rows.addEventListener('click', event => {
  if (event.target.closest('.remove-benefit')) { event.target.closest('.benefit-row').remove(); document.getElementById('benefit-limit').textContent = ''; }
});
