import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { loadQuestionBoxAccess } from '../services/questionBoxService.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { Finance } from '../models/finance.js';
import { FinanceBudget } from '../models/financeBudget.js';
import { financeClassification } from '../lib/financeAnnual.js';
import { classificationForEntry } from './associationFinance.js';

export const mobileFinanceRouter = express.Router({ mergeParams: true });
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
const own = req => ({ group: req.financeContext.groupId, user: req.user._id });
const entryFilter = req => {
  if (!mongoose.isValidObjectId(req.params.entryId)) throw fail('会計データが見つかりません。', 404);
  return { ...own(req), _id: req.params.entryId };
};
const dateValue = value => {
  const text = String(value || '');
  const date = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw fail('日付を正しく入力してください。');
  return date;
};
// Legacy entries can omit classification. Match the editor's unique budget lookup without changing stored data.
export const mobileFinanceClassification = (entry, budgets, startMonth = 4) => {
  const stored = financeClassification(entry);
  if (stored !== '未設定') return stored;
  const date = new Date(entry.date);
  const year = String(date.getUTCFullYear() - (date.getUTCMonth() + 1 < startMonth ? 1 : 0));
  const field = entry.cf === '収入' ? 'income_item' : 'expense_item';
  const candidates = new Set(budgets.filter(row => String(row.year) === year && row.cf === entry.cf && row[field] === entry[field]).map(financeClassification));
  return candidates.size === 1 ? [...candidates][0] : stored;
};
export const mobileFinanceEntry = (entry, budgets = [], startMonth = 4) => ({
  id: String(entry._id), date: new Date(entry.date).toISOString().slice(0, 10), cf: entry.cf,
  classification: mobileFinanceClassification(entry, budgets, startMonth), item: (entry.cf === '収入' ? entry.income_item : entry.expense_item) || '',
  content: entry.content || '', amount: Number(entry.amount), paymentType: entry.payment_type || '',
  inputterName: entry.inputterName || '', usedBy: entry.usedBy || entry.inputterName || '',
  memo: entry.memo || '', receiptNo: entry.receiptNo || '', tag: entry.tags?.[0]?.name || ''
});
export const mobileFinanceQuery = (scope, filters) => {
  const query = { ...scope };
  if (filters.cf) { if (!['収入', '支出'].includes(filters.cf)) throw fail('収支区分を確認してください。'); query.cf = filters.cf; }
  if (filters.payment_type) query.payment_type = String(filters.payment_type);
  if (filters.item) query.$and = [{ $or: [{ expense_item: String(filters.item) }, { income_item: String(filters.item) }] }];
  if (filters.keyword) {
    const keyword = String(filters.keyword).slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = ['content', 'memo', 'expense_item', 'income_item'].map(key => ({ [key]: new RegExp(keyword, 'i') }));
  }
  if (filters.from || filters.to) {
    query.date = {};
    if (filters.from) query.date.$gte = dateValue(filters.from);
    if (filters.to) query.date.$lt = new Date(dateValue(filters.to).getTime() + 86400000);
    if (filters.from && filters.to && filters.from > filters.to) throw fail('期間の開始日と終了日を確認してください。');
  }
  return query;
};
mobileFinanceRouter.use(requireLogin, async (req, res, next) => {
  try {
    const access = await loadQuestionBoxAccess({ associationId: req.params.associationId, userId: req.user._id });
    if (!access.canAnswer) throw fail('町内会の役員のみ会計管理を利用できます。', 403);
    if (!access.association.group || !associationFeatureEnabled(access.association, 'finance')) throw fail('この町内会では会計管理を利用していません。', 404);
    req.financeContext = { association: access.association, groupId: access.association.group };
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
}, provideCsrfToken);

mobileFinanceRouter.get('/entries', handle(async (req, res) => {
  const scope = own(req), query = mobileFinanceQuery(scope, req.query);
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const [entries, total, incomeItems, expenseItems, payments, budgets] = await Promise.all([
    Finance.find(query).sort({ date: -1, entry_date: -1, _id: -1 }).skip((page - 1) * 50).limit(50).lean(),
    Finance.countDocuments(query),
    Finance.distinct('income_item', { ...scope, cf: '収入' }),
    Finance.distinct('expense_item', { ...scope, cf: '支出' }),
    Finance.distinct('payment_type', scope),
    FinanceBudget.find({ group: req.financeContext.groupId }).lean()
  ]);
  const clean = values => values.filter(Boolean).sort();
  res.json({ entries: entries.map(entry => mobileFinanceEntry(entry, budgets, req.financeContext.association.financeFiscalStartMonth || 4)), total, page, hasMore: page * 50 < total,
    incomeItems: clean(incomeItems), expenseItems: clean(expenseItems), paymentTypes: clean(payments), csrfToken: res.locals.csrfToken });
}));

mobileFinanceRouter.get('/form', handle(async (req, res) => {
  const { association, groupId } = req.financeContext;
  let entry = null;
  if (req.query.entryId) {
    req.params.entryId = String(req.query.entryId);
    entry = await Finance.findOne(entryFilter(req)).lean();
    if (!entry) throw fail('自分が入力した会計データを確認できません。', 404);
  }
  const budgets = await FinanceBudget.find({ group: groupId }).sort({ year: 1, cf: 1, display_order: 1 }).lean();
  const methods = association.financePaymentMethods?.length
    ? association.financePaymentMethods.filter(method => method.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0)).map(method => method.name)
    : association.financePaymentTypes || [];
  res.json({ entry: entry ? mobileFinanceEntry(entry, budgets, association.financeFiscalStartMonth || 4) : null, fiscalStartMonth: association.financeFiscalStartMonth || 4,
    inputterName: entry?.inputterName || req.user.displayname || req.user.username || '', paymentTypes: methods,
    budgets: budgets.map(row => ({ id: String(row._id), year: String(row.year), cf: row.cf, classification: financeClassification(row),
      item: (row.cf === '収入' ? row.income_item : row.expense_item) || '',
      tags: [...new Set((row.details || []).map(detail => [detail.name, detail.content].map(value => String(value || '').trim()).filter(Boolean).join('：')).filter(Boolean))]
    })), csrfToken: res.locals.csrfToken });
}));

export async function mobileFinanceValues(req) {
  const body = req.body, date = dateValue(body.date), cf = body.cf;
  if (!['収入', '支出'].includes(cf)) throw fail('収支区分を選択してください。');
  const amountText = String(body.amount ?? '').normalize('NFKC').replace(/[ ,，]/g, '');
  const amount = Number(amountText);
  if (!amountText || !Number.isFinite(amount) || amount < 0) throw fail('金額を正しく入力してください。');
  const content = String(body.content || '').trim(), paymentType = String(body.payment_type || '').trim();
  if (!content) throw fail('内容を入力してください。');
  if (cf === '支出' && !paymentType) throw fail('支払種別を選択してください。');
  const classification = await classificationForEntry(req, date, cf);
  const tag = cf === '支出' ? String(body.tagText || '').trim() : '';
  return { ...classification, date, month: date.getUTCMonth() + 1, day: date.getUTCDate(), cf,
    income_item: cf === '収入' ? String(body.item) : '', expense_item: cf === '支出' ? String(body.item) : '',
    content, amount, payment_type: cf === '支出' ? paymentType : '', tags: tag ? [{ name: tag }] : [],
    receiptNo: String(body.receiptNo || ''), memo: String(body.memo || ''),
    usedBy: String(body.usedBy || '').trim() || req.user.displayname || req.user.username || '' };
}
mobileFinanceRouter.post('/entries', verifyCsrfToken, handle(async (req, res) => {
  const values = await mobileFinanceValues(req);
  const entry = await Finance.create({ ...values, ...own(req), inputterName: req.user.displayname || req.user.username || '' });
  res.status(201).json({ entry: mobileFinanceEntry(entry) });
}));
mobileFinanceRouter.post('/entries/:entryId/update', verifyCsrfToken, handle(async (req, res) => {
  const filter = entryFilter(req);
  if (!await Finance.exists(filter)) throw fail('自分が入力した会計データを確認できません。', 404);
  const values = await mobileFinanceValues(req);
  const entry = await Finance.findOneAndUpdate(filter, { $set: values }, { new: true, runValidators: true });
  if (!entry) throw fail('会計データが見つかりません。', 404);
  res.json({ entry: mobileFinanceEntry(entry) });
}));
mobileFinanceRouter.post('/entries/:entryId/delete', verifyCsrfToken, handle(async (req, res) => {
  const result = await Finance.deleteOne(entryFilter(req));
  if (!result.deletedCount) throw fail('自分が入力した会計データを確認できません。', 404);
  res.json({ ok: true });
}));
