(() => {
  const calendar = document.getElementById('attendance-calendar');
  if (!calendar) return;
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  let month = new Date(today.getFullYear(), today.getMonth(), 1);
  const pad = n => String(n).padStart(2, '0');
  const dateText = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dialog = document.getElementById('attendance-dialog');
  const form = document.getElementById('attendance-form');
  const candidates = document.getElementById('attendance-candidates');
  const todayText = () => dateText(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })));
  const add = (date = '') => {
    if (date && date < todayText()) return;
    if (candidates.children.length >= 60) { alert('日程候補は60件までです。'); return; }
    const row = document.createElement('div'); row.className = 'attendance-candidate attendance-candidate-draft';
    const dateLabel = document.createElement('label'); dateLabel.textContent = '日付';
    const dateInput = document.createElement('input'); dateInput.type = 'date'; dateInput.name = 'candidateDate'; dateInput.required = true; dateInput.min = todayText(); dateInput.value = date;
    dateLabel.append(dateInput);
    const timeLabel = document.createElement('label'); timeLabel.textContent = '時間';
    const time = document.createElement('input'); time.type = 'time'; time.name = 'candidateTime'; time.required = true; time.value = '09:00'; timeLabel.append(time);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-quiet'; remove.textContent = '削除'; remove.addEventListener('click', () => { row.remove(); render(); });
    const status = document.createElement('span'); status.className = 'attendance-candidate-status'; status.textContent = '入力中の候補'; status.setAttribute('aria-live', 'polite');
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button button-quiet'; confirm.textContent = '候補に追加';
    confirm.addEventListener('click', () => {
      dateInput.min = todayText();
      if (!dateInput.reportValidity() || !time.reportValidity()) return;
      row.classList.replace('attendance-candidate-draft', 'attendance-candidate-added'); status.textContent = '追加済み候補'; confirm.disabled = true; confirm.textContent = '追加済み'; render();
    });
    const edit = () => { row.classList.replace('attendance-candidate-added', 'attendance-candidate-draft'); status.textContent = '入力中の候補'; confirm.disabled = false; confirm.textContent = '候補に追加'; render(); };
    dateInput.addEventListener('input', edit); time.addEventListener('input', edit);
    row.append(status, dateLabel, timeLabel, confirm, remove); candidates.append(row); render();
    if (date) time.focus(); else dateInput.focus();
  };
  const polls = JSON.parse(document.getElementById('attendance-calendar-data').textContent);
  const render = () => {
    calendar.replaceChildren();
    document.getElementById('attendance-month').textContent = `${month.getFullYear()}年${month.getMonth()+1}月`;
    ['月','火','水','木','金','土','日'].forEach(day => { const el = document.createElement('strong'); el.textContent = day; calendar.append(el); });
    for (let i = 0; i < (month.getDay() + 6) % 7; i++) calendar.append(document.createElement('span'));
    const count = new Date(month.getFullYear(), month.getMonth()+1, 0).getDate();
    const selected = [...candidates.querySelectorAll('[name="candidateDate"]')].map(input => input.value);
    for (let day = 1; day <= count; day++) {
      const date = dateText(new Date(month.getFullYear(), month.getMonth(), day));
      const cell = document.createElement('div'); cell.className = 'attendance-day';
      const button = document.createElement('button'); button.type = 'button'; button.disabled = date < todayText(); button.className = `equipment-calendar-day${button.disabled ? '' : ' equipment-calendar-available'}`; button.textContent = day; button.setAttribute('aria-label', `${date}のイベントを作成`);
      button.setAttribute('aria-pressed', String(selected.includes(date))); button.addEventListener('click', () => { if (date < todayText()) return; dialog.showModal(); add(date); form.elements.title.focus(); }); cell.append(button);
      for (const poll of polls.filter(p => p.dates.includes(date))) { const link = document.createElement('a'); link.href = poll.url; link.textContent = poll.title; cell.append(link); }
      calendar.append(cell);
    }
  };
  document.getElementById('attendance-prev').addEventListener('click', () => { month.setMonth(month.getMonth()-1); render(); });
  document.getElementById('attendance-next').addEventListener('click', () => { month.setMonth(month.getMonth()+1); render(); });
  document.getElementById('attendance-add').addEventListener('click', () => add());
  const audience = document.getElementById('attendance-audience');
  const updateAudience = () => {
    if (audience) {
      const officer = form.querySelector('[name="targetKind"]:checked').value === 'officer';
      const officerOptions = document.getElementById('attendance-officer-options');
      const residentOptions = document.getElementById('attendance-resident-options');
      officerOptions.hidden = !officer; residentOptions.hidden = officer;
      officerOptions.querySelectorAll('input').forEach(input => { input.disabled = !officer; });
      residentOptions.querySelectorAll('input').forEach(input => { input.disabled = officer; });
      audience.value = form.querySelector(officer ? '[name="officerAudience"]:checked' : '[name="residentAudience"]:checked').value;
    }
    const value = audience ? audience.value : form.querySelector('[name="audience"]:checked').value;
    const selected = ['selected', 'officer-selected'].includes(value);
    document.getElementById('attendance-members').hidden = !selected;
    document.querySelectorAll('[data-is-officer]').forEach(label => {
      const hidden = value === 'officer-selected' && label.dataset.isOfficer !== 'true';
      label.hidden = hidden; const input = label.querySelector('input'); input.disabled = !selected || hidden;
    });
    const department = document.getElementById('attendance-department'), leaders = document.getElementById('attendance-leaders');
    if (department) { department.hidden = value !== 'department'; department.querySelectorAll('input').forEach(input => { input.disabled = department.hidden; }); }
    if (leaders) { leaders.hidden = !['officers','department','officer-selected'].includes(value); leaders.querySelector('input').disabled = leaders.hidden; }
  };
  form.addEventListener('change', updateAudience);
  document.querySelectorAll('[data-day-close], [data-attendance-cancel]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { form.reset(); candidates.replaceChildren(); updateAudience(); render(); });
  updateAudience(); render();
  document.querySelector('[name="deadline"]').min = dateText(today);
  document.getElementById('attendance-form').addEventListener('submit', event => { if (!candidates.children.length) { event.preventDefault(); alert('日程候補を追加してください。'); return; } if (audience?.value === 'department' && !form.querySelector('[name="department"]:checked')) { event.preventDefault(); alert('部会を1つ以上選択してください。'); } });
})();
