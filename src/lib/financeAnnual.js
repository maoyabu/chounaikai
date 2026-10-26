export const financeClassification = row => String((row.cf === '収入' ? row.income_category : row.expense_department_name || row.expense_department) || '未設定');
const itemName = row => (row.cf === '収入' ? row.income_item : row.expense_item) || '未分類';
const key = (cf, classification, name) => JSON.stringify([cf, classification, name]);

export function buildAnnualRows(entries, budgets, months) {
  const rows = new Map();
  const ensureRow = (cf, classification, item) => {
    const rowKey = key(cf, classification, item);
    if (!rows.has(rowKey)) rows.set(rowKey, { cf, classification, itemName: item, name: `${classification}・${item}`, budget: 0, details: [], months: months.map(() => 0) });
    return rows.get(rowKey);
  };
  const budgetClasses = new Map();
  budgets.forEach(budget => {
    const classification = financeClassification(budget), item = itemName(budget);
    const row = ensureRow(budget.cf, classification, item);
    row.budget += Number(budget.budget) || 0;
    row.details.push(...(budget.details || []));
    const itemKey = key(budget.cf, '', item);
    if (!budgetClasses.has(itemKey)) budgetClasses.set(itemKey, new Set());
    budgetClasses.get(itemKey).add(classification);
  });
  entries.forEach(entry => {
    const item = itemName(entry);
    let classification = financeClassification(entry);
    const candidates = budgetClasses.get(key(entry.cf, '', item));
    // 過去の分類未記録データは、一意に分かる場合にだけ予算の分類を補う。
    if (classification === '未設定' && candidates?.size === 1) classification = [...candidates][0];
    const row = ensureRow(entry.cf, classification, item);
    const index = months.indexOf(new Date(entry.date).getMonth() + 1);
    if (index >= 0) row.months[index] += Number(entry.amount) || 0;
  });
  const section = cf => {
    const items = [...rows.values()].filter(row => row.cf === cf);
    items.forEach(row => { row.includeLegacy = budgetClasses.get(key(cf, '', row.itemName))?.size === 1; });
    const summary = { name: cf, cf, budget: items.reduce((sum, row) => sum + row.budget, 0), months: months.map((_, index) => items.reduce((sum, row) => sum + row.months[index], 0)), details: items.filter(row => row.details.length).map(row => ({ name: row.name, details: row.details })) };
    return [summary, ...items];
  };
  const incomeRows = section('収入'), expenseRows = section('支出');
  const totalRow = { name: '収支', cf: '収支', budget: incomeRows[0].budget - expenseRows[0].budget, months: months.map((_, index) => incomeRows[0].months[index] - expenseRows[0].months[index]) };
  return { incomeRows, expenseRows, totalRow };
}

export function classificationFilter(query) {
  const income = query.cf === '収入';
  const classification = query[income ? 'income_category' : 'expense_department'];
  if (typeof classification !== 'string') return null;
  const fields = income ? ['income_category'] : ['expense_department_name', 'expense_department'];
  const missing = { $and: fields.map(field => ({ [field]: { $in: ['', null] } })) };
  const matches = fields.map(field => ({ [field]: classification }));
  if (classification === '未設定' || query.includeLegacy === '1') matches.push(missing);
  return { $or: matches };
}
