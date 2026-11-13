import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { AssociationEquipment, EquipmentLoan } from '../models/equipment.js';
import { equipmentAccess, equipmentError, checkedEquipmentId, japanDate, monthIndex, monthString, requestEquipmentLoan, decideEquipmentLoan } from '../services/equipmentService.js';
import { equipmentDaySchedule } from '../services/equipmentTimeService.js';

export const mobileEquipmentRouter = express.Router({ mergeParams: true });
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
export const mobileEquipmentItem = item => ({
  id: String(item._id), name: item.name, note: item.note || '', place: item.place,
  unit: item.unit, quantity: item.quantity, category: item.stockCategory || '',
  availableFrom: item.availableFrom || '', availableUntil: item.availableUntil || ''
});
export const mobileEquipmentLoan = loan => ({
  id: String(loan._id), startDate: loan.startDate, endDate: loan.endDate,
  startTime: loan.startTime || '', endTime: loan.endTime || '', allDay: loan.allDay !== false,
  quantity: loan.quantity, purpose: loan.purpose || '', status: loan.status
});
export const mobileEquipmentCalendar = (item, loans, month, today = japanDate()) => {
  const index = monthIndex(month);
  if (month < '1900-01' || month > '2200-12') throw equipmentError('年月は1900年〜2200年で指定してください。');
  const start = `${month}-01`, next = monthString(index + 1);
  const days = new Date(Date.parse(`${next}-01`) - 86400000).getUTCDate();
  const cells = Array((new Date(start).getUTCDay() + 6) % 7).fill(null);
  for (let day = 1; day <= days; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const segments = equipmentDaySchedule(item, loans, date);
    const capacity = Math.max(0, ...segments.map(segment => segment.available));
    cells.push({ date, day, segments, capacity, available: date >= today && capacity > 0 });
  }
  return { month, previousMonth: monthString(index - 1), nextMonth: next, today, cells };
};
mobileEquipmentRouter.use(requireLogin, async (req, res, next) => {
  try {
    const access = await equipmentAccess(req.params.associationId, req.user._id);
    if (!associationFeatureEnabled(access.association, 'equipment')) throw equipmentError('この町内会では設備の貸出を利用していません。', 404);
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
}, provideCsrfToken);

mobileEquipmentRouter.get('/', handle(async (req, res) => {
  const items = await AssociationEquipment.find({ association: req.params.associationId, deletedAt: null, lendable: true, wishlist: { $ne: true } }).sort({ place: 1, stockCategory: 1, name: 1 }).lean();
  res.json({ items: items.map(mobileEquipmentItem) });
}));
mobileEquipmentRouter.get('/:equipmentId/calendar', handle(async (req, res) => {
  const association = req.params.associationId;
  const item = await AssociationEquipment.findOne({ _id: checkedEquipmentId(req.params.equipmentId), association, deletedAt: null, lendable: true, wishlist: { $ne: true } }).lean();
  if (!item) throw equipmentError('貸出可能な設備を確認できません。', 404);
  const today = japanDate(), month = req.query.month || today.slice(0, 7);
  const loans = await EquipmentLoan.find({ association, equipment: item._id }).lean();
  // Availability contains totals only; personal application details are returned only to their borrower.
  const requests = loans.filter(loan => String(loan.borrower) === String(req.user._id))
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ item: mobileEquipmentItem(item), ...mobileEquipmentCalendar(item, loans, month, today), requests: requests.map(mobileEquipmentLoan), csrfToken: res.locals.csrfToken });
}));
mobileEquipmentRouter.post('/:equipmentId/loans', verifyCsrfToken, handle(async (req, res) => {
  const loan = await requestEquipmentLoan({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, input: req.body });
  res.status(201).json({ loan: mobileEquipmentLoan(loan) });
}));
mobileEquipmentRouter.post('/loans/:loanId/cancel', verifyCsrfToken, handle(async (req, res) => {
  const own = await EquipmentLoan.exists({ _id: checkedEquipmentId(req.params.loanId), association: req.params.associationId, borrower: req.user._id });
  if (!own) throw equipmentError('自分の申込みだけ取り消せます。', 403);
  const loan = await decideEquipmentLoan({ associationId: req.params.associationId, userId: req.user._id, loanId: req.params.loanId, action: 'cancelled' });
  res.json({ loan: mobileEquipmentLoan(loan) });
}));
