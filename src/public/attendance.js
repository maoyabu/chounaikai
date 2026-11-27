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
    const dateInput = document.createElement('input'); dateInput.type = 'date'; dateInput.name = 'candidateDate'; dateInput.required = true; dateInput.min = todayText(); dateInput.value = date; dateInput.setAttribute('aria-label', '候補の日付');
    const timeFields = document.createElement('div'); timeFields.className = 'attendance-time-fields';
    const time = document.createElement('input'); time.type = 'hidden'; time.name = 'candidateTime';
    const makeSelect = (label, values) => {
      const select = document.createElement('select'); select.required = true; select.setAttribute('aria-label', label);
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = label; select.append(blank);
      for (const value of values) { const option = document.createElement('option'); option.value = pad(value); option.textContent = pad(value); select.append(option); }
      select.value = ''; return select;
    };
    const hours = makeSelect('時', Array.from({ length: 24 }, (_, i) => i));
    const minutes = makeSelect('分', [0, 10, 20, 30, 40, 50]);
    if (!date) { hours.value = '12'; minutes.value = '00'; }
    const separator = document.createElement('span'); separator.textContent = ':'; separator.setAttribute('aria-hidden', 'true');
    timeFields.append(time, hours, separator, minutes);
    const updateTimePrompt = () => {
      time.value = hours.value && minutes.value ? `${hours.value}:${minutes.value}` : '';
      for (const select of [hours, minutes]) {
        select.classList.toggle('attendance-time-required', !select.value);
        select.setAttribute('aria-invalid', String(!select.value));
      }
    };
    updateTimePrompt();
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button button-quiet'; remove.textContent = '削除'; remove.addEventListener('click', () => { row.remove(); render(); });
    let saved = null;
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button button-quiet'; confirm.textContent = '候補に追加';
    const update = () => {
      updateTimePrompt();
      const unchanged = saved && saved.date === dateInput.value && saved.time === time.value;
      row.classList.toggle('attendance-candidate-draft', !unchanged);
      row.classList.toggle('attendance-candidate-added', Boolean(unchanged));
      confirm.disabled = Boolean(unchanged); confirm.textContent = saved ? '修正' : '候補に追加';
      render();
    };
    confirm.addEventListener('click', () => {
      dateInput.min = todayText();
      if (!dateInput.reportValidity() || !hours.reportValidity() || !minutes.reportValidity()) return;
      const isNew = !saved;
      saved = { date: dateInput.value, time: time.value };
      if (isNew) candidates.append(row);
      update();
    });
    dateInput.addEventListener('input', update);
    for (const select of [hours, minutes]) {
      select.addEventListener('input', update); select.addEventListener('change', update);
      select.addEventListener('focus', () => { if (!hours.value && !minutes.value) { hours.value = '12'; minutes.value = '00'; update(); } });
    }
    row.append(dateInput, timeFields, confirm, remove); candidates.prepend(row); render();
    if (!date) dateInput.focus();
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
