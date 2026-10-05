(() => {
  const data = JSON.parse(document.getElementById('equipment-day-data').textContent);
  const dialog = document.getElementById('equipment-day-dialog');
  const loanForm = document.getElementById('equipment-day-loan');
  const error = document.getElementById('equipment-day-error');
  const submit = async form => {
    error.hidden = true;
    const buttons = [...form.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams(new FormData(form)) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || '処理できませんでした。');
      location.reload();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { buttons.forEach(button => button.disabled = false); }
  };
  document.querySelectorAll('[data-day-form]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); submit(form); }));
  document.querySelector('[data-day-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  document.querySelectorAll('[data-day-form]').forEach(form => { if (form.elements.allDay) form.elements.allDay.addEventListener('change', () => { ['startTime', 'endTime'].forEach(name => form.elements[name].disabled = form.elements.allDay.checked); }); });
  document.querySelectorAll('[data-loan-date]').forEach(button => button.addEventListener('click', () => {
    const date = button.dataset.loanDate, cell = data.cells.find(cell => cell?.date === date);
    error.hidden = true; document.getElementById('equipment-day-title').textContent = `${date}の利用状況`;
    dialog.querySelectorAll('form input[name=startDate], form input[name=endDate]').forEach(input => input.value = date);
    const bar = document.getElementById('equipment-time-bar'), details = document.getElementById('equipment-time-details'); bar.replaceChildren(); details.replaceChildren();
    for (const segment of cell.segments || []) {
      const label = `${segment.startTime}〜${segment.endTime}：${segment.blocked ? '利用不可' : `空き ${segment.available}${data.unit} / 貸出中 ${segment.used}${data.unit}`}`;
      const part = document.createElement('button'); part.type = 'button'; part.title = label; part.setAttribute('aria-label', label);
      part.style.flex = String(segment.endMinute - segment.startMinute);
      part.className = segment.blocked ? 'time-blocked' : !segment.available ? 'time-full' : segment.used ? 'time-partial' : 'time-free';
      const row = document.createElement('button'); row.type = 'button'; row.className = 'equipment-time-row'; row.textContent = label;
      const choose = () => { if (!loanForm || !segment.available || date < data.today) return; loanForm.elements.allDay.checked = false; ['startTime','endTime'].forEach(name => loanForm.elements[name].disabled = false); loanForm.elements.startTime.value = segment.startTime; loanForm.elements.endTime.value = segment.endTime; loanForm.elements.quantity.max = String(segment.available); loanForm.elements.purpose.focus(); };
      part.addEventListener('click', choose); row.addEventListener('click', choose); bar.append(part); details.append(row);
    }
    if (loanForm) { loanForm.hidden = date < data.today; loanForm.elements.quantity.max = String(data.cells.find(c => c?.date === date)?.capacity || 1); }
    const blockForm = document.getElementById('equipment-day-block'); if (blockForm) blockForm.hidden = date < data.today;
    const blocks = document.getElementById('equipment-day-blocks');
    if (blocks) { blocks.replaceChildren(); for (const block of data.blocks.filter(block => block.startDate <= date && block.endDate >= date)) {
      const form = document.createElement('form'); form.action = data.blockUrl; form.method = 'post';
      const label = document.createElement('p'); label.textContent = `${block.startDate}〜${block.endDate} ${block.allDay === false ? `${block.startTime}〜${block.endTime}` : '終日'}：${block.reason}`; form.append(label);
      for (const [name, value] of [['_csrf',data.csrfToken], ['removeBlockId',block._id]]) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input); }
      const remove = document.createElement('button'); remove.className = 'button button-quiet button-small'; remove.textContent = '利用NGを解除'; form.append(remove); form.addEventListener('submit', event => { event.preventDefault(); submit(form); }); blocks.append(form);
    } }
    dialog.showModal();
  }));
})();
