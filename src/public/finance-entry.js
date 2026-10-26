function initializeFinanceEntry(root) {
  const budgets = JSON.parse(root.querySelector('[data-finance-budgets]').textContent);
  const form = root.querySelector('.finance-entry-form');
  const date = form.querySelector('[name="date"]');
  const cf = form.querySelector('[name="cf"]');
  const item = form.querySelector('[name="item"]');
  const department = form.querySelector('[name="expense_department"]');
  const departmentField = root.querySelector('#finance-entry-department-field');
  let initialDepartment = department.dataset.selected;
  const itemLabel = root.querySelector('#finance-entry-item-label');
  const tagField = root.querySelector('#finance-entry-tags-field');
  const tagText = root.querySelector('#finance-entry-tag-input');
  const tagOptions = root.querySelector('#finance-entry-tag-options');
  const tagButtons = root.querySelector('#finance-entry-tags');
  const payment = form.querySelector('[name="payment_type"]');
  const amount = form.querySelector('[name="amount"]');
  let initialItem = item.dataset.selected;
  const fiscalStartMonth = Number(form.dataset.fiscalStartMonth) || 4;
  const yearLabel = root.querySelector('#finance-entry-fiscal-year');
  const selectedYear = () => {
    if (!date.value) return String(form.dataset.year);
    const [calendarYear, month] = date.value.split('-').map(Number);
    return String(calendarYear - (month < fiscalStartMonth ? 1 : 0));
  };
  const renderTags = () => {
    const details = JSON.parse(item.selectedOptions[0]?.dataset.details || '[]');
    const names = [...new Set(details.map(detail => [String(detail.name || '').trim(), String(detail.content || '').trim()].filter(Boolean).join('：')).filter(Boolean))];
    tagOptions.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
    tagButtons.replaceChildren(...names.map(name => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'finance-entry-tag';
      button.textContent = name;
      button.classList.toggle('is-selected', tagText.value === name);
      button.addEventListener('click', () => {
        tagText.value = tagText.value === name ? '' : name;
        tagButtons.querySelectorAll('.finance-entry-tag').forEach(candidate => candidate.classList.toggle('is-selected', candidate.textContent === tagText.value));
      });
      return button;
    }));
  };
  tagText.addEventListener('input', () => tagButtons.querySelectorAll('.finance-entry-tag').forEach(button => button.classList.toggle('is-selected', button.textContent === tagText.value)));
  const renderItems = (selected = '') => {
    const expense = cf.value === '支出';
    const available = budgets.filter(row => row.cf === cf.value && row.year === selectedYear() && row.department === department.value);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = !department.value ? (expense ? '先に部を選択してください' : '先に項目分類を選択してください') : available.length ? '項目を選択してください' : 'この年度の予算項目がありません';
    item.replaceChildren(placeholder, ...available.map(row => { const option = document.createElement('option'); option.value = row.name; option.textContent = row.name; option.dataset.details = JSON.stringify(row.details || []); return option; }));
    item.disabled = !department.value;
    if (available.some(row => row.name === selected)) item.value = selected;
    renderTags();
  };
  const refresh = () => {
    yearLabel.textContent = selectedYear();
    const expense = cf.value === '支出';
    itemLabel.textContent = '項目名';
    root.querySelector('#finance-entry-group-label').textContent = expense ? '部' : '項目分類';
    department.name = expense ? 'expense_department' : 'income_category';
    const available = budgets.filter(row => row.cf === cf.value && row.year === selectedYear());
    const departments = [...new Set(available.map(row => row.department))];
    const previousDepartment = department.value;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = departments.length ? (expense ? '部を選択してください' : '項目分類を選択してください') : 'この年度の予算項目がありません';
    department.replaceChildren(placeholder, ...departments.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
    // 分類・部が未記録の既存データは、項目から一意に判別できる場合だけ復元する。
    const matchingDepartments = [...new Set(available.filter(row => row.name === initialItem).map(row => row.department))];
    const selectedDepartment = initialDepartment || (initialItem && matchingDepartments.length === 1 ? matchingDepartments[0] : previousDepartment);
    if (departments.includes(selectedDepartment)) department.value = selectedDepartment;
    departmentField.hidden = false;
    department.disabled = false;
    department.required = true;
    renderItems(initialItem);
    initialItem = '';
    initialDepartment = '';
    tagField.hidden = !expense;
    tagField.style.display = expense ? 'block' : 'none';
    tagText.disabled = !expense;
    payment.closest('label').style.display = expense ? '' : 'none';
    payment.required = expense;
    payment.disabled = !expense;
    if (!expense) payment.value = '';
    renderTags();
  };
  const clearTags = () => { tagText.value = ''; };
  cf.addEventListener('change', () => { clearTags(); refresh(); });
  date.addEventListener('change', () => { clearTags(); refresh(); });
  department.addEventListener('change', () => { clearTags(); renderItems(); });
  item.addEventListener('change', () => { clearTags(); renderTags(); });
  const normalizeAmount = () => amount.value.normalize('NFKC').replace(/[ ,，]/g, '');
  amount.addEventListener('blur', () => { const value = normalizeAmount(); if (/^\d+$/.test(value)) amount.value = Number(value).toLocaleString('ja-JP'); });
  form.addEventListener('submit', () => { amount.value = normalizeAmount(); });
  refresh();
}
document.querySelectorAll('[data-finance-entry-content]').forEach(initializeFinanceEntry);

(() => {
  const dialog = document.querySelector('.finance-entry-modal');
  if (!dialog) return;
  const body = dialog.querySelector('[data-finance-entry-modal-body]');
  let saved = false;
  let submitting = false;
  const load = async url => {
    url.searchParams.set('modal', '1');
    const response = await fetch(url);
    if (!response.ok || response.redirected) throw new Error('入力画面を開けませんでした。画面を更新して再度お試しください。');
    body.innerHTML = await response.text();
    if (!body.querySelector('.finance-entry-form')) throw new Error('入力画面を開けませんでした。');
    initializeFinanceEntry(body);
    body.querySelector('input[name="date"]').focus();
  };
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[data-finance-entry-modal]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    body.textContent = '読み込み中…';
    dialog.showModal();
    try { await load(new URL(link.href)); }
    catch (error) { body.textContent = error.message; }
  });
  dialog.querySelector('[data-finance-entry-close]').addEventListener('click', () => { if (!submitting) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    body.replaceChildren();
    if (saved) location.reload();
  });
  dialog.addEventListener('submit', async event => {
    const form = event.target.closest('.finance-entry-form');
    if (!form) return;
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    const errorBox = body.querySelector('[data-finance-entry-error]');
    errorBox.hidden = true;
    const data = new URLSearchParams(new FormData(form));
    if (event.submitter?.name) data.set(event.submitter.name, event.submitter.value);
    await window.AppBusy.run(async () => {
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body: data });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || '保存できませんでした。入力内容を確認してください。');
      saved = true;
      if (result.continue) {
        const url = new URL(form.action + '/new');
        url.searchParams.set('year', body.querySelector('#finance-entry-fiscal-year').textContent);
        try { await load(url); }
        catch (_error) {
          body.textContent = '登録は完了しました。次の入力画面を開けませんでしたので、閉じて新規登録を開き直してください。';
          return;
        }
        const notice = body.querySelector('[data-finance-entry-error]');
        notice.className = 'alert alert-success';
        notice.textContent = '入出金を登録しました。続けて入力できます。';
        notice.hidden = false;
      } else {
        location.reload();
      }
    } catch (error) {
      const target = body.querySelector('[data-finance-entry-error]') || errorBox;
      target.className = 'alert alert-danger';
      target.textContent = error.message;
      target.hidden = false;
    } finally { submitting = false; }
    }, '会計を保存中です');
  });
})();
