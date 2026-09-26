import express from 'express';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { RoleAssignment } from '../models/role.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Finance } from '../models/finance.js';
import { FinanceBudget } from '../models/financeBudget.js';
import { Department } from '../models/organization.js';
import { requireLogin } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import ExcelJS from 'exceljs';

export const associationFinanceRouter = express.Router();
associationFinanceRouter.use(requireLogin);
associationFinanceRouter.use('/:associationId/finance', (req, res, next) => {
  const referer = req.get('referer') || '';
  if (req.path === '' && referer.includes(`/associations/${req.params.associationId}/finance/public`)) return res.redirect(`/associations/${req.params.associationId}/finance/public`);
  return next();
});

const fiscalYear = (date, startMonth = 4) => {
  const value = new Date(date);
  return value.getMonth() + 1 >= Number(startMonth) ? value.getFullYear() : value.getFullYear() - 1;
};

async function availableFinanceYears(groupId, startMonth) {
  const [budgetYears, dates] = await Promise.all([FinanceBudget.distinct('year', { group: groupId }), Finance.find({ group: groupId }).select('date').lean()]);
  const years = new Set(budgetYears.map(Number).filter(Number.isFinite));
  dates.forEach((entry) => years.add(fiscalYear(entry.date, startMonth)));
  return [...years].sort((a, b) => b - a);
}

async function loadContext(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).render('error', { title: '町内会が見つかりません', message: '町内会IDが正しくありません。' });
  const association = await NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean();
  if (!association?.group) return res.status(404).render('error', { title: '町内会が見つかりません', message: '会計を利用できる町内会が見つかりません。' });
  const now = new Date();
  const publicAccess = req.originalUrl.includes(`/associations/${req.params.associationId}/finance/public`) || req.path.includes('/public') || req.query.public === '1';
  const [manager, officer, membership] = await Promise.all([
    RoleAssignment.findOne({ association: association._id, user: req.user._id, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }).populate({ path: 'role', match: { active: true, permissions: 'association.manage' } }).lean(),
    AnnualOfficer.findOne({ association: association._id, user: req.user._id, fiscalYear: fiscalYear(now), cancelledAt: null }).lean(),
    publicAccess ? AssociationMembership.findOne({ association: association._id, user: req.user._id, status: { $in: ['active'] } }).lean() : null
  ]);
  if (!manager?.role && !officer && !req.user.isAdmin && !(publicAccess && Boolean(association.financePublic) && membership)) return res.status(403).render('error', { title: '権限がありません', message: '公開設定されていない会計、または町内会の住人限定ページです。' });
  req.financeContext = { association, groupId: association.group, year: fiscalYear(now, association.financeFiscalStartMonth || 4), isManager: Boolean(manager?.role || req.user.isAdmin), publicAccess };
  res.locals.financeYears = await availableFinanceYears(association.group, association.financeFiscalStartMonth || 4);
  return next();
}

associationFinanceRouter.use('/:associationId/finance', loadContext);

associationFinanceRouter.get('/:associationId/finance', async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext;
    const year = Number(req.query.year) || currentYear;
    const fiscalYears = await availableFinanceYears(groupId, association.financeFiscalStartMonth || 4);
    const budgets = await FinanceBudget.find({ group: groupId, year: String(year) }).sort({ display_order: 1 }).lean();
    const start = new Date(year, (association.financeFiscalStartMonth || 4) - 1, 1);
    const end = new Date(year + 1, (association.financeFiscalStartMonth || 4) - 1, 1);
    const rows = await Finance.aggregate([{ $match: { group: new mongoose.Types.ObjectId(groupId), date: { $gte: start, $lt: end } } }, { $group: { _id: { cf: '$cf', item: { $ifNull: ['$expense_item', '$income_item'] } }, total: { $sum: '$amount' } } }]);
    const actual = new Map(rows.map((row) => [`${row._id.cf}:${row._id.item || '未分類'}`, row.total]));
    const budgetItems = budgets.map((item) => { const name = item.expense_item || item.income_item || '未分類'; const value = actual.get(`${item.cf}:${name}`) || 0; return { ...item, name, actual: value, rate: item.budget ? Math.round(value / item.budget * 1000) / 10 : 0 }; });
    const totalBudget = budgets.reduce((sum, item) => sum + (Number(item.budget) || 0), 0);
    const budgetTotals = budgets.reduce((result, item) => { result[item.cf] = (result[item.cf] || 0) + (Number(item.budget) || 0); return result; }, {});
    const totals = rows.reduce((result, row) => { result[row._id.cf] = (result[row._id.cf] || 0) + row.total; return result; }, {});
    ['収入', '支出'].forEach((type) => { const actualValue = totals[type] || 0; const budgetValue = budgetTotals[type] || 0; totals[type] = { toLocaleString: () => `${actualValue.toLocaleString()} / ¥${budgetValue.toLocaleString()}` }; });
    return res.render('association-finance-dashboard', { title: `${association.name} 町内会会計管理`, association, year, fiscalYears, totals, totalBudget, budgetTotals, budgetItems, isManager: req.financeContext.isManager });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/entries', async (req, res, next) => {
  try {
    const { association, groupId } = req.financeContext;
    const query = { group: groupId };
    if (req.query.cf) query.cf = req.query.cf;
    if (req.query.payment_type) query.payment_type = req.query.payment_type;
    if (req.query.item) query.$and = [{ $or: [{ expense_item: req.query.item }, { income_item: req.query.item }] }];
    if (req.query.month && req.query.year) { const selectedMonth = Number(req.query.month); const selectedYear = Number(req.query.year) + (selectedMonth < Number(req.financeContext.association.financeFiscalStartMonth || 4) ? 1 : 0); query.date = { $gte: new Date(selectedYear, selectedMonth - 1, 1), $lt: new Date(selectedYear, selectedMonth, 1) }; }
    if (req.query.keyword) query.$or = [{ content: new RegExp(req.query.keyword, 'i') }, { memo: new RegExp(req.query.keyword, 'i') }, { expense_item: new RegExp(req.query.keyword, 'i') }, { income_item: new RegExp(req.query.keyword, 'i') }];
    if (req.query.from || req.query.to) query.date = {}; if (req.query.from) query.date.$gte = new Date(req.query.from); if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999`);
    const entries = await Finance.find(query).populate('user', 'displayname username').sort(req.query.sort === 'updated' ? { update_date: -1, entry_date: -1 } : { date: -1, entry_date: -1 }).limit(300).lean();
    const [expenseItems, incomeItems, paymentTypes] = await Promise.all([Finance.distinct('expense_item', { group: groupId, expense_item: { $nin: ['', null] } }), Finance.distinct('income_item', { group: groupId, income_item: { $nin: ['', null] } }), Finance.distinct('payment_type', { group: groupId, payment_type: { $nin: ['', null] } })]);
    return res.render('association-finance-entries', { title: `${association.name} 会計入力一覧`, association, entries, filters: req.query, exportQuery: new URLSearchParams(req.query).toString(), filterItemsByCf: { 収入: incomeItems.filter(Boolean).sort(), 支出: expenseItems.filter(Boolean).sort() }, filterPaymentTypes: paymentTypes.sort() });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/public/annual', (req, res) => res.redirect(`/associations/${req.params.associationId}/finance/annual?public=1`));
associationFinanceRouter.get('/:associationId/finance/public', async (req, res, next) => { try { const { association, groupId, year: currentYear } = req.financeContext; const year = Number(req.query.year) || currentYear; const startMonth = Number(association.financeFiscalStartMonth || 4); const start = new Date(year, startMonth - 1, 1); const end = new Date(year + 1, startMonth - 1, 1); const [rows, budgets] = await Promise.all([Finance.aggregate([{ $match: { group: new mongoose.Types.ObjectId(groupId), date: { $gte: start, $lt: end } } }, { $group: { _id: '$cf', total: { $sum: '$amount' } } }]), FinanceBudget.find({ group: groupId, year: String(year) }).lean()]); const actual = rows.reduce((result, row) => ({ ...result, [row._id]: row.total }), {}); const budget = budgets.reduce((result, item) => ({ ...result, [item.cf]: (result[item.cf] || 0) + Number(item.budget || 0) }), {}); return res.render('association-finance-public', { title: `${association.name} 会計報告`, association, year, fiscalYears: await availableFinanceYears(groupId, startMonth), startMonth, endMonth: startMonth === 1 ? 12 : startMonth - 1, endYear: startMonth === 1 ? year : year + 1, actual, budget }); } catch (error) { return next(error); } });
associationFinanceRouter.get('/:associationId/finance/public/entries', async (req, res, next) => { try { const { association, groupId } = req.financeContext; const query = { group: groupId }; if (req.query.cf) query.cf = req.query.cf; if (req.query.payment_type) query.payment_type = req.query.payment_type; if (req.query.item) query.$and = [{ $or: [{ expense_item: req.query.item }, { income_item: req.query.item }] }]; if (req.query.keyword) query.$or = [{ content: new RegExp(req.query.keyword, 'i') }, { memo: new RegExp(req.query.keyword, 'i') }, { expense_item: new RegExp(req.query.keyword, 'i') }, { income_item: new RegExp(req.query.keyword, 'i') }]; if (req.query.month && req.query.year) { const month = Number(req.query.month); const fiscalYear = Number(req.query.year) + (month < Number(association.financeFiscalStartMonth || 4) ? 1 : 0); query.date = { $gte: new Date(fiscalYear, month - 1, 1), $lt: new Date(fiscalYear, month, 1) }; } else if (req.query.from || req.query.to) { query.date = {}; if (req.query.from) query.date.$gte = new Date(req.query.from); if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999`); } const entries = await Finance.find(query).sort({ date: -1, entry_date: -1 }).lean(); const [expenseItems, incomeItems, paymentTypes] = await Promise.all([Finance.distinct('expense_item', { group: groupId, expense_item: { $nin: ['', null] } }), Finance.distinct('income_item', { group: groupId, income_item: { $nin: ['', null] } }), Finance.distinct('payment_type', { group: groupId, payment_type: { $nin: ['', null] } })]); return res.render('association-finance-public-entries', { title: `${association.name} 会計報告 入力一覧`, association, entries, filters: req.query, filterItemsByCf: { 収入: incomeItems.filter(Boolean).sort(), 支出: expenseItems.filter(Boolean).sort() }, filterPaymentTypes: paymentTypes.filter(Boolean).sort() }); } catch (error) { return next(error); } });

associationFinanceRouter.get('/:associationId/finance/annual', async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext;
    const year = Number(req.query.year) || currentYear;
    const fiscalYears = await availableFinanceYears(groupId, association.financeFiscalStartMonth || 4);
    const startMonth = Number(association.financeFiscalStartMonth || 4);
    const months = Array.from({ length: 12 }, (_, index) => (startMonth - 1 + index) % 12 + 1);
    const start = new Date(year, startMonth - 1, 1);
    const end = new Date(year + 1, startMonth - 1, 1);
    const [entries, budgets] = await Promise.all([Finance.find({ group: groupId, date: { $gte: start, $lt: end } }).lean(), FinanceBudget.find({ group: groupId, year: String(year) }).sort({ cf: 1, display_order: 1 }).lean()]);
    const makeRow = (name, cf, budget = 0) => ({ name, cf, budget: Number(budget) || 0, months: months.map((month) => entries.filter((entry) => entry.cf === cf && new Date(entry.date).getMonth() + 1 === month && (name === '収入' || name === '支出' || (entry.expense_item || entry.income_item || '未分類') === name)).reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0)) });
    const income = makeRow('収入', '収入', budgets.filter((item) => item.cf === '収入').reduce((sum, item) => sum + Number(item.budget || 0), 0));
    const expense = makeRow('支出', '支出', budgets.filter((item) => item.cf === '支出').reduce((sum, item) => sum + Number(item.budget || 0), 0));
    const incomeRows = [income]; const expenseRows = [expense];
    budgets.forEach((item) => { const name = item.expense_item || item.income_item || '未分類'; (item.cf === '支出' ? expenseRows : incomeRows).push(makeRow(name, item.cf, item.budget)); });
    const totalRow = { name: '収支', cf: '収支', budget: income.budget - expense.budget, months: income.months.map((value, index) => value - expense.months[index]) };
    return res.render('association-finance-annual', { title: `${association.name} 年度集計`, association, year, fiscalYears, months, incomeRows, expenseRows, totalRow, publicMode: req.financeContext.publicAccess });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/annual/export', async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext;
    const year = Number(req.query.year) || currentYear; const startMonth = Number(association.financeFiscalStartMonth || 4);
    const months = Array.from({ length: 12 }, (_, index) => (startMonth - 1 + index) % 12 + 1); const start = new Date(year, startMonth - 1, 1); const end = new Date(year + 1, startMonth - 1, 1);
    const [entries, budgets] = await Promise.all([Finance.find({ group: groupId, date: { $gte: start, $lt: end } }).lean(), FinanceBudget.find({ group: groupId, year: String(year) }).sort({ cf: 1, display_order: 1 }).lean()]);
    const row = (name, cf, budget = 0) => { const values = months.map((month) => entries.filter((entry) => entry.cf === cf && new Date(entry.date).getMonth() + 1 === month && (name === '収入' || name === '支出' || (entry.expense_item || entry.income_item || '未分類') === name)).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)); return [name, Number(budget) || 0, ...values, values.reduce((a, b) => a + b, 0)]; };
    const incomeBudget = budgets.filter((item) => item.cf === '収入').reduce((sum, item) => sum + Number(item.budget || 0), 0); const expenseBudget = budgets.filter((item) => item.cf === '支出').reduce((sum, item) => sum + Number(item.budget || 0), 0);
    const incomeSummary = row('収入', '収入', incomeBudget); const expenseSummary = row('支出', '支出', expenseBudget); const balanceSummary = ['収支', incomeSummary[1] - expenseSummary[1], ...incomeSummary.slice(2).map((value, index) => value - expenseSummary[index + 2])];
    const rows = [incomeSummary, ...budgets.filter((item) => item.cf === '収入').map((item) => row(item.income_item || '未分類', '収入', item.budget)), balanceSummary, Array(15).fill(''), expenseSummary, ...budgets.filter((item) => item.cf === '支出').map((item) => row(item.expense_item || '未分類', '支出', item.budget))];
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('年度集計'); sheet.addRow(['項目', '予算', ...months.map((month) => `${month}月`), '累計', '累計差']); rows.forEach((values) => sheet.addRow([...values, values[1] - values[values.length - 1]])); sheet.columns.forEach((column, index) => { column.width = index === 0 ? 22 : 13; }); sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalDpi: 300, verticalDpi: 300 }; sheet.pageMargins = { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E4E38' } }; sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' }; sheet.eachRow((row, rowNumber) => { if (rowNumber > 1) { const name = row.getCell(1).value; const subtotal = name === '収入' || name === '支出'; row.font = { bold: subtotal, color: { argb: 'FF17231F' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: subtotal ? 'FFC7E3D4' : (rowNumber % 2 === 0 ? 'FFE5F2EB' : 'FFFFFFFF') } }; row.alignment = { vertical: 'middle' }; row.eachCell((cell, columnNumber) => { cell.border = { top: { style: 'thin', color: { argb: 'FFCBD9D1' } }, bottom: { style: 'thin', color: { argb: 'FFCBD9D1' } }, left: { style: 'thin', color: { argb: 'FFCBD9D1' } }, right: { style: 'thin', color: { argb: 'FFCBD9D1' } } }; if (columnNumber > 1) { cell.alignment = { horizontal: 'right', vertical: 'middle' }; cell.numFmt = '#,##0'; } }); } }); sheet.getColumn(2).numFmt = '#,##0';
    const balanceRow = sheet.getRows(1, sheet.rowCount).find((currentRow) => currentRow.getCell(1).value === '収支');
    if (balanceRow) { balanceRow.font = { bold: true, color: { argb: 'FF17231F' } }; balanceRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8DCAE' } }; }); }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${association.name}-${year}年度集計.xlsx`)}`); return res.send(await workbook.xlsx.writeBuffer());
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/expense-chart', async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext;
    const latest = Number(req.query.year) || currentYear; const years = Array.from({ length: 5 }, (_, index) => latest - 4 + index); const startMonth = Number(association.financeFiscalStartMonth || 4);
    const data = await Promise.all(years.map(async (year) => { const start = new Date(year, startMonth - 1, 1); const end = new Date(year + 1, startMonth - 1, 1); const rows = await Finance.aggregate([{ $match: { group: new mongoose.Types.ObjectId(groupId), cf: '支出', date: { $gte: start, $lt: end } } }, { $group: { _id: { $ifNull: ['$expense_item', '未分類'] }, total: { $sum: '$amount' } } }]); return { year, values: Object.fromEntries(rows.map((row) => [row._id, row.total])) }; }));
    const items = [...new Set(data.flatMap((entry) => Object.keys(entry.values)))].sort(); return res.render('association-finance-expense-chart', { title: `${association.name} 支出項目別グラフ`, association, years, data, items, publicMode: req.financeContext.publicAccess });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/monthly-expense-chart', async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext; const latest = Number(req.query.year) || currentYear; const selected = [...new Set((Array.isArray(req.query.years) ? req.query.years : [req.query.years]).filter(Boolean).map(Number).filter(Number.isFinite))].slice(0, 3); const years = selected.length ? selected : [latest]; const startMonth = Number(association.financeFiscalStartMonth || 4); const months = Array.from({ length: 12 }, (_, index) => (startMonth - 1 + index) % 12 + 1);
    const data = await Promise.all(years.map(async (year) => { const start = new Date(year, startMonth - 1, 1); const end = new Date(year + 1, startMonth - 1, 1); const rows = await Finance.aggregate([{ $match: { group: new mongoose.Types.ObjectId(groupId), cf: '支出', date: { $gte: start, $lt: end } } }, { $group: { _id: { month: { $month: '$date' }, item: { $ifNull: ['$expense_item', '未分類'] } }, total: { $sum: '$amount' } } }]); return { year, values: Object.fromEntries(months.map((month) => [month, Object.fromEntries(rows.filter((row) => row._id.month === month).map((row) => [row._id.item, row.total]))])) }; }));
    const items = [...new Set(data.flatMap((entry) => Object.values(entry.values).flatMap((month) => Object.keys(month))))].sort(); return res.render('association-finance-monthly-expense-chart', { title: `${association.name} 月別支出項目別グラフ`, association, years, months, data, items, publicMode: req.financeContext.publicAccess });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/entries/export', async (req, res, next) => {
  try {
    const { association, groupId } = req.financeContext;
    const query = { group: groupId };
    if (req.query.cf) query.cf = req.query.cf;
    if (req.query.payment_type) query.payment_type = req.query.payment_type;
    if (req.query.item) query.$and = [{ $or: [{ expense_item: req.query.item }, { income_item: req.query.item }] }];
    if (req.query.keyword) query.$or = [{ content: new RegExp(req.query.keyword, 'i') }, { memo: new RegExp(req.query.keyword, 'i') }, { expense_item: new RegExp(req.query.keyword, 'i') }, { income_item: new RegExp(req.query.keyword, 'i') }];
    if (req.query.from || req.query.to) query.date = {};
    if (req.query.from) query.date.$gte = new Date(req.query.from);
    if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999`);
    const entries = await Finance.find(query).populate('user', 'displayname username').sort(req.query.sort === 'updated' ? { update_date: -1, entry_date: -1 } : { date: -1, entry_date: -1 }).lean();
    const date = (value) => value ? new Date(value).toLocaleDateString('ja-JP') : '';
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('会計入力一覧');
    sheet.columns = [
      { header: '使用日', key: 'date', width: 14 }, { header: '収支区分', key: 'cf', width: 12 }, { header: '小区分', key: 'item', width: 22 }, { header: '内容', key: 'content', width: 36 }, { header: '金額', key: 'amount', width: 16 }, { header: '支払い種別', key: 'paymentType', width: 18 }, { header: '領収書番号', key: 'receiptNo', width: 16 }, { header: '入力者', key: 'inputter', width: 18 }, { header: '使用者', key: 'usedBy', width: 18 }, { header: 'メモ', key: 'memo', width: 36 }
    ];
    entries.forEach((entry) => sheet.addRow({ date: date(entry.date), cf: entry.cf, item: entry.expense_item || entry.income_item || '', content: entry.content || '', amount: Number(entry.amount || 0), paymentType: entry.payment_type || '', receiptNo: entry.receiptNo || '', inputter: entry.inputterName || entry.user?.displayname || entry.user?.username || '', usedBy: entry.usedBy || entry.inputterName || entry.user?.displayname || entry.user?.username || '', memo: entry.memo || '' }));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B50' } };
    sheet.getColumn('amount').numFmt = '#,##0';
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const filename = encodeURIComponent(`${association.name}-会計入力一覧.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    return res.send(workbookBuffer);
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/entries/new', async (req, res) => {
  const { association, groupId, year } = req.financeContext;
  const budgets = await FinanceBudget.find({ group: groupId, year: String(req.query.year || year) }).sort({ cf: 1, display_order: 1 }).lean();
  const paymentMethods = association.financePaymentMethods?.filter((item) => item.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)) || (association.financePaymentTypes || []).map((name, index) => ({ name, order: index + 1, active: true }));
  return res.render('association-finance-entry', { title: '会計を入力', association, entry: null, year: Number(req.query.year || year), budgets, paymentMethods });
});

associationFinanceRouter.get('/:associationId/finance/entries/:entryId/edit', async (req, res, next) => {
  try {
    const { association, groupId, year } = req.financeContext;
    const entry = await Finance.findOne({ _id: req.params.entryId, group: groupId }).lean();
    if (!entry) return res.status(404).render('error', { title: '会計データが見つかりません', message: '編集対象の会計データが見つかりません。' });
    const budgets = await FinanceBudget.find({ group: groupId, year: String(year) }).sort({ cf: 1, display_order: 1 }).lean();
    const paymentMethods = association.financePaymentMethods?.filter((item) => item.active !== false) || (association.financePaymentTypes || []).map((name, index) => ({ name, order: index + 1 }));
    return res.render('association-finance-entry', { title: '会計を編集', association, year, budgets, paymentMethods, entry });
  } catch (error) { return next(error); }
});

associationFinanceRouter.get('/:associationId/finance/settings', async (req, res) => {
  const { association, groupId, year } = req.financeContext;
  const [budgets, departments] = await Promise.all([FinanceBudget.find({ group: groupId, year: String(req.query.year || year) }).sort({ cf: 1, display_order: 1 }).lean(), Department.find({ association: association._id, active: true }).sort({ sortOrder: 1, name: 1 }).lean()]);
  const departmentNames = new Map(departments.map(department => [String(department._id), department.name]));
  budgets.forEach(item => { if (!item.expense_department_name && item.expense_department) item.expense_department_name = departmentNames.get(String(item.expense_department)) || item.expense_department; });
  const paymentMethods = association.financePaymentMethods?.length ? association.financePaymentMethods : (association.financePaymentTypes || []).map((name, index) => ({ name, order: index + 1, active: true }));
  return res.render('association-finance-settings', { title: `${association.name} 会計設定`, association, budgets, departments, paymentMethods, year: Number(req.query.year || year) });
});

associationFinanceRouter.post('/:associationId/finance/settings', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association } = req.financeContext;
    const names = Array.isArray(req.body.paymentName) ? req.body.paymentName : [req.body.paymentName].filter(Boolean);
    const active = Array.isArray(req.body.paymentActive) ? req.body.paymentActive : [req.body.paymentActive].filter(Boolean);
    const paymentMethods = names.filter(Boolean).map((name, index) => ({ name: String(name).trim(), order: index + 1, active: active.includes(String(index)) }));
    await NeighborhoodAssociation.updateOne({ _id: association._id }, { $set: { financePublic: req.body.financePublic === 'on' || req.body.financePublic === 'true' || req.body.financePublic === '1', financeFiscalStartMonth: Number(req.body.fiscalStartMonth) || association.financeFiscalStartMonth || 4, financePaymentTypes: paymentMethods.map((item) => item.name), financePaymentMethods: paymentMethods } });
    return res.redirect(`/associations/${association._id}/finance/settings`);
  } catch (error) { return next(error); }
});

associationFinanceRouter.post('/:associationId/finance/settings/budgets/copy', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, groupId, year: currentYear } = req.financeContext;
    const targetYear = String(req.body.targetYear || currentYear);
    const sourceYear = String(req.body.sourceYear || '');
    if (!/^\d{4}$/.test(sourceYear) || sourceYear === targetYear) return res.status(400).json({ message: 'コピー元とコピー先の年度を正しく選択してください。' });
    const source = await FinanceBudget.find({ group: groupId, year: sourceYear }).sort({ cf: 1, display_order: 1 }).lean();
    if (!source.length) return res.status(404).json({ message: 'コピー元年度に予算項目が登録されていません。' });
    const hasTarget = await FinanceBudget.exists({ group: groupId, year: targetYear });
    if (hasTarget && req.body.overwrite !== '1') return res.status(409).json({ message: `${targetYear}年度には既に予算項目が登録されています。上書きしてコピーしますか？` });
    if (hasTarget) await FinanceBudget.deleteMany({ group: groupId, year: targetYear });
    await FinanceBudget.insertMany(source.map(({ _id, ...item }) => ({ ...item, year: targetYear })));
    return res.json({ redirect: `/associations/${association._id}/finance/settings?year=${targetYear}` });
  } catch (error) { return next(error); }
});

associationFinanceRouter.post('/:associationId/finance/settings/budgets', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, groupId, year } = req.financeContext;
    const rows = Array.isArray(req.body.itemName) ? req.body.itemName : [req.body.itemName];
    const submittedTypes = [...new Set((Array.isArray(req.body.itemCf) ? req.body.itemCf : [req.body.itemCf]).filter(Boolean))];
    await FinanceBudget.deleteMany({ group: groupId, year: String(req.body.year || year), cf: { $in: submittedTypes } });
    const typeIndexes = { 収入: 0, 支出: 0 };
    await FinanceBudget.insertMany(rows.filter(Boolean).map((name, index) => { const cf = Array.isArray(req.body.itemCf) ? req.body.itemCf[index] : req.body.itemCf; const typeIndex = typeIndexes[cf] || 0; typeIndexes[cf] = typeIndex + 1; const value = (key, local = false) => { const raw = req.body[key]; if (!Array.isArray(raw)) return raw; return raw[local ? typeIndex : index]; }; const department = String(value('itemDepartment', true) || '').trim(); return { group: groupId, year: String(req.body.year || year), cf, expense_item: cf === '支出' ? name : undefined, income_item: cf === '収入' ? name : undefined, income_category: cf === '収入' ? String(value('itemCategory', true) || '').trim() : undefined, expense_department: cf === '支出' ? department : undefined, expense_department_name: cf === '支出' ? department : undefined, budget: Number(String(value('itemBudget') || '').replace(/,/g, '')) || 0, display_order: Number(value('itemOrder')) || index + 1 }; }));
    return res.redirect(`/associations/${association._id}/finance/settings?year=${encodeURIComponent(String(req.body.year || year))}`);
  } catch (error) { return next(error); }
});

associationFinanceRouter.post('/:associationId/finance/entries', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, groupId } = req.financeContext; const date = new Date(req.body.date); const cf = req.body.cf === '収入' ? '収入' : '支出'; const amount = Number(String(req.body.amount || '').replace(/,/g, '')); if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('金額を正しく入力してください。'), { status: 400 });
    const inputterName = req.user.displayname || req.user.username || '';
    await Finance.create({ date, month: date.getMonth() + 1, day: date.getDate(), cf, income_item: cf === '収入' ? req.body.item : undefined, expense_item: cf === '支出' ? req.body.item : undefined, content: req.body.content, amount, payment_type: req.body.payment_type, receiptNo: req.body.receiptNo, memo: req.body.memo, user: req.user._id, inputterName, usedBy: String(req.body.usedBy || '').trim() || inputterName, group: groupId });
    return res.redirect(req.body.continue ? `/associations/${association._id}/finance/entries/new` : `/associations/${association._id}/finance/entries`);
  } catch (error) { return next(error); }
});

associationFinanceRouter.post('/:associationId/finance/entries/:entryId/update', verifyCsrfToken, async (req, res, next) => {
  try {
    const { association, groupId } = req.financeContext; const date = new Date(req.body.date); const cf = req.body.cf === '収入' ? '収入' : '支出'; const amount = Number(String(req.body.amount || '').replace(/,/g, '')); if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('金額を正しく入力してください。'), { status: 400 }); const inputterName = req.user.displayname || req.user.username || '';
    await Finance.updateOne({ _id: req.params.entryId, group: groupId }, { $set: { date, month: date.getMonth() + 1, day: date.getDate(), cf, income_item: cf === '収入' ? req.body.item : undefined, expense_item: cf === '支出' ? req.body.item : undefined, content: req.body.content, amount, payment_type: req.body.payment_type, receiptNo: req.body.receiptNo, memo: req.body.memo, usedBy: String(req.body.usedBy || '').trim() || inputterName } });
    return res.redirect(`/associations/${association._id}/finance/entries`);
  } catch (error) { return next(error); }
});

associationFinanceRouter.post('/:associationId/finance/entries/:entryId/delete', verifyCsrfToken, async (req, res, next) => {
  try { await Finance.deleteOne({ _id: req.params.entryId, group: req.financeContext.groupId }); return res.redirect(`/associations/${req.params.associationId}/finance/entries`); } catch (error) { return next(error); }
});
