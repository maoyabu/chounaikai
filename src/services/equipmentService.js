import { equipmentLoanTimes, equipmentLoanWindow, equipmentReservations, equipmentWindowCapacity } from './equipmentTimeService.js';
import { notifyResponsible } from './notificationRecipients.js';
import mongoose from 'mongoose';
import { AssociationEquipment, EquipmentSettings, EquipmentInventory, EquipmentLoan, EquipmentPurchase, EquipmentReminder } from '../models/equipment.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../models/role.js';
import { Notification } from '../models/notification.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';

export const equipmentError = (message, status = 400) => Object.assign(new Error(message), { status });
export const checkedEquipmentId = value => { if (!mongoose.isValidObjectId(value)) throw equipmentError('設備・備品を確認できません。', 404); return value; };
export const japanDate = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
export const validEquipmentDate = (value, optional = false) => {
  if (optional && !value) return '';
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) throw equipmentError('日付を確認してください。');
  return text;
};
export const monthIndex = value => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value))) throw equipmentError('年月を確認してください。'); const [y, m] = value.split('-').map(Number); return y * 12 + m - 1; };
export const monthString = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
export const addMonths = (date, months) => { const [y, m, d] = validEquipmentDate(date).split('-').map(Number); const i = y * 12 + m - 1 + months; const yy = Math.floor(i / 12), mm = i % 12; const day = Math.min(d, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate()); return `${monthString(i)}-${String(day).padStart(2, '0')}`; };
const text = (value, max, label, required = false) => { const result = String(value ?? '').trim(); if ((required && !result) || result.length > max) throw equipmentError(`${label}を${max}文字以内で入力してください。`); return result; };
export const equipmentNumber = (value, label, min = 0, integer = false) => { if (value === '' || value === undefined || value === null) throw equipmentError(`${label}を入力してください。`); const n = Number(value); if (!Number.isFinite(n) || n < min || n > 1000000 || (integer && !Number.isInteger(n))) throw equipmentError(`${label}を正しく入力してください。`); return n; };
const flag = value => ['on', '1', true].includes(value);
export const equipmentUrl = value => { const url = String(value || '').trim(); if (!url) return ''; try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2000) throw new Error(); return parsed.href; } catch { throw equipmentError('商品・画像URLはhttpまたはhttpsで入力してください。'); } };
export const equipmentValues = input => {
  const values = { name: text(input.name, 120, '備品名', true), note: text(input.note, 500, '備品名補足'), place: text(input.place, 100, '保管場所', true), unit: text(input.unit, 20, '単位', true), quantity: equipmentNumber(input.quantity, '数量'), minimumQuantity: equipmentNumber(input.minimumQuantity ?? 0, '必要数量'), stockCategory: text(input.stockCategory, 100, 'ストック分類'), disasterCategory: text(input.disasterCategory, 100, '防災分類'), maintenance: text(input.maintenance, 1000, 'メンテナンス内容'), productUrl: equipmentUrl(input.productUrl), productImageUrl: equipmentUrl(input.productImageUrl), expiryDate: validEquipmentDate(input.expiryDate, true), isConsumable: flag(input.isConsumable), tracked: flag(input.tracked), lendable: flag(input.lendable), wishlist: flag(input.wishlist), availableFrom: validEquipmentDate(input.availableFrom, true), availableUntil: validEquipmentDate(input.availableUntil, true) };
  if (values.wishlist) { values.tracked = false; values.lendable = false; }
  if (values.availableFrom && values.availableUntil && values.availableFrom > values.availableUntil) throw equipmentError('貸出可能期間を確認してください。');
  if (values.lendable && !Number.isInteger(values.quantity)) throw equipmentError('貸出可能な備品の数量は整数で入力してください。');
  return values;
};
export const equipmentSettingsValues = input => {
  monthIndex(input.inventoryStartMonth);
  const inventoryIntervalMonths = equipmentNumber(input.inventoryIntervalMonths, '棚卸し周期', 1, true);
  const expiryAlertMonths = equipmentNumber(input.expiryAlertMonths, '期限アラート期間', 1, true);
  if (inventoryIntervalMonths > 120 || expiryAlertMonths > 120) throw equipmentError('周期とアラート期間は1〜120ヶ月で入力してください。');
  return { inventoryStartMonth: input.inventoryStartMonth, inventoryIntervalMonths, expiryAlertMonths, loanPublic: flag(input.loanPublic) };
};
export const equipmentAccess = async (associationId, userId, manage = false) => { const access = await loadQuestionBoxAccess({ associationId, userId }); if (manage && !access.canAnswer) throw equipmentError('役員のみ設備・備品を管理できます。', 403); if (!access.canAnswer && (await EquipmentSettings.findOne({ association: associationId }).lean())?.loanPublic === false) throw equipmentError('設備・備品の貸出管理は現在公開されていません。', 403); return access; };
export const equipmentSettings = async association => (await EquipmentSettings.findOne({ association }).lean()) || { inventoryIntervalMonths: 3, inventoryStartMonth: japanDate().slice(0, 7), expiryAlertMonths: 1 };
export const inventoryPeriod = (settings, today = japanDate()) => { const start = monthIndex(settings.inventoryStartMonth), current = monthIndex(today.slice(0, 7)), due = reminderPeriod(settings, today); const period = start + Math.max(0, Math.floor((current - start) / settings.inventoryIntervalMonths)) * settings.inventoryIntervalMonths; return monthString(Math.max(period, due ? monthIndex(due) : start)); };
export const reminderPeriod = (settings, today = japanDate()) => {
  const start = monthIndex(settings.inventoryStartMonth), current = monthIndex(today.slice(0, 7));
  let i = start + Math.floor((current + 1 - start) / settings.inventoryIntervalMonths) * settings.inventoryIntervalMonths;
  const dueDate = month => new Date(Date.parse(`${monthString(month)}-01T00:00:00+09:00`) - 86400000);
  if (japanDate(dueDate(i)) > today) i -= settings.inventoryIntervalMonths;
  return i < start ? null : monthString(i);
};
export const equipmentShortage = item => Math.max(0, (item.minimumQuantity || 0) - item.quantity);
export const equipmentGroups = (items, category = 'stockCategory') => [...items.reduce((places, item) => { if (!places.has(item.place)) places.set(item.place, new Map()); const groups = places.get(item.place), name = item[category] || '未分類'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); return places; }, new Map())].map(([name, groups]) => ({ name, groups: [...groups].map(([category, items]) => ({ category, items })) }));
export const loanCapacity = (item, loans, startDate, endDate) => {
  const times = equipmentLoanTimes({ startDate, endDate, allDay: true });
  return equipmentWindowCapacity(item, loans, times.startAt.getTime(), times.endAt.getTime());
};
const reservationVersionFilter = item => ({ reservationVersion: item.reservationVersion ?? { $exists: false }, updatedAt: item.updatedAt });
const activeReservations = async (association, equipment, item) => equipmentReservations(item, await EquipmentLoan.find({ association, equipment }).lean());
const reservationSlots = loans => loans.map(loan => { const window = equipmentLoanWindow(loan); return { loanId: loan._id, startAt: new Date(window.start), endAt: new Date(window.end), quantity: loan.quantity }; });

export const saveEquipment = async ({ associationId, userId, equipmentId, input }) => {
  await equipmentAccess(associationId, userId, true); const values = equipmentValues(input);
  if (!equipmentId) return AssociationEquipment.create({ association: associationId, createdBy: userId, ...values });
  checkedEquipmentId(equipmentId);
  const item = await AssociationEquipment.findOne({ _id: equipmentId, association: associationId, deletedAt: null }).lean();
  if (!item) throw equipmentError('備品を確認できません。', 404);
  const loans = await activeReservations(associationId, equipmentId, item);
  const windows = loans.map(equipmentLoanWindow);
  const from = values.availableFrom ? equipmentLoanTimes({ startDate: values.availableFrom, endDate: values.availableFrom, allDay: true }).startAt.getTime() : -Infinity;
  const until = values.availableUntil ? equipmentLoanTimes({ startDate: values.availableUntil, endDate: values.availableUntil, allDay: true }).endAt.getTime() : Infinity;
  if (loans.length && (!values.lendable || values.wishlist || !Number.isInteger(values.quantity) || windows.some(window => window.start < from || window.end > until))) throw equipmentError('貸出申込みがあるため、貸出設定・数量・期間を縮小できません。', 409);
  if (loans.length && equipmentWindowCapacity({ quantity: item.quantity }, loans, Math.min(...windows.map(window => window.start)), Math.max(...windows.map(window => window.end))) < item.quantity - values.quantity) throw equipmentError('貸出申込みに必要な数量を下回ります。', 409);
  // A single-document compare-and-swap works on standalone MongoDB too.
  // Reservations change the version; stock operations change updatedAt.
  const updated = await AssociationEquipment.findOneAndUpdate({
    _id: equipmentId, association: associationId, deletedAt: null,
    reservationVersion: item.reservationVersion ?? { $exists: false }, updatedAt: item.updatedAt
  }, { $set: values, $inc: { reservationVersion: 1 } }, { new: true, runValidators: true });
  if (!updated) throw equipmentError('在庫や貸出の状態が変更されました。画面を開き直して保存してください。', 409);
  return updated;
};
export const checkInventory = async ({ associationId, userId, equipmentId, period, input }) => {
  await equipmentAccess(associationId, userId, true); checkedEquipmentId(equipmentId);
  const settings = await equipmentSettings(associationId);
  if (period !== inventoryPeriod(settings)) throw equipmentError('棚卸し期間が更新されています。画面を開き直してください。', 409);
  const count = equipmentNumber(input.count, '棚卸し数量'), comment = text(input.comment, 1000, 'コメント'), checked = flag(input.checked), at = new Date();
  return mongoose.connection.transaction(async session => {
    const item = await AssociationEquipment.findOneAndUpdate({ _id: equipmentId, association: associationId, deletedAt: null, tracked: true, wishlist: { $ne: true } }, { $inc: { reservationVersion: 1 } }, { new: true, session });
    if (!item) throw equipmentError('棚卸し対象の備品を確認できません。', 404);
    if (checked && item.lendable) { if (!Number.isInteger(count)) throw equipmentError('貸出備品の数量は整数で入力してください。'); const loans = await EquipmentLoan.find({ association: associationId, equipment: equipmentId, status: { $in: ['pending', 'approved'] } }).session(session).lean(); if (loans.length && loanCapacity(item, loans, loans.map(loan => loan.startDate).sort()[0], loans.map(loan => loan.endDate).sort().at(-1)) < item.quantity - count) throw equipmentError('申込み中の貸出数量を下回ります。数量を確認してください。', 409); }
    if (checked) { item.quantity = count; await item.save({ session }); }
    return EquipmentInventory.findOneAndUpdate({ association: associationId, equipment: equipmentId, period }, { $set: { checked, count, comment, checkedBy: userId, checkedAt: at }, $push: { history: { checked, count, comment, actor: userId, at } } }, { upsert: true, new: true, session, runValidators: true });
  });
};
export const requestEquipmentLoan = async ({ associationId, userId, equipmentId, input }) => {
  await equipmentAccess(associationId, userId); checkedEquipmentId(equipmentId);
  const startDate = validEquipmentDate(input.startDate), endDate = validEquipmentDate(input.endDate || input.startDate), quantity = equipmentNumber(input.quantity, '貸出数量', 1, true), purpose = text(input.purpose, 500, '利用目的', true);
  const times = equipmentLoanTimes({ ...input, startDate, endDate });
  if (startDate < japanDate() || endDate < startDate || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 366 || (!times.allDay && times.startAt < new Date())) throw equipmentError('貸出日時は現在以降、最大367日で指定してください。');
  const item = await AssociationEquipment.findOne({ _id: equipmentId, association: associationId, lendable: true, wishlist: { $ne: true }, deletedAt: null }).lean();
  if (!item) throw equipmentError('貸出可能な備品を確認できません。', 404);
  if ((item.availableFrom && startDate < item.availableFrom) || (item.availableUntil && endDate > item.availableUntil)) throw equipmentError('貸出可能期間内で指定してください。');
  const loans = await activeReservations(associationId, equipmentId, item);
  if (equipmentWindowCapacity(item, loans, times.startAt.getTime(), times.endAt.getTime()) < quantity) throw equipmentError('指定時間の空き数量が不足しているか、利用NG日が含まれています。', 409);
  const loanId = new mongoose.Types.ObjectId();
  const slots = [...reservationSlots(loans), { loanId, startAt: times.startAt, endAt: times.endAt, quantity }];
  const claimed = await AssociationEquipment.updateOne({ _id: equipmentId, association: associationId, deletedAt: null, ...reservationVersionFilter(item) }, { $set: { reservations: slots }, $inc: { reservationVersion: 1 } });
  if (!claimed.matchedCount) throw equipmentError('予約状況が変更されました。カレンダーを開き直してください。', 409);
  let loan;
  try { loan = await EquipmentLoan.create({ _id: loanId, association: associationId, equipment: equipmentId, borrower: userId, startDate, endDate, ...times, quantity, purpose }); }
  catch (error) {
    // Release only this request's claim; other concurrent reservations are kept.
    await AssociationEquipment.updateOne({ _id: equipmentId, association: associationId }, { $pull: { reservations: { loanId } }, $inc: { reservationVersion: 1 } });
    throw error;
  }
  await notifyResponsible({ association: associationId, officers: true, type: 'equipment_loan', title: `${item.name}の貸出申込み：${startDate} ${times.allDay ? '終日' : `${times.startTime}〜${times.endTime}`}`, relatedId: equipmentId });
  return loan;
};
export const decideEquipmentLoan = async ({ associationId, userId, loanId, action }) => {
  const access = await equipmentAccess(associationId, userId); checkedEquipmentId(loanId);
  if (!['approved', 'rejected', 'cancelled', 'returned'].includes(action)) throw equipmentError('貸出の操作を確認してください。');
  const existing = await EquipmentLoan.findOne({ _id: loanId, association: associationId }).lean();
  if (!existing) throw equipmentError('申込みを確認できません。', 404);
  if (action === 'cancelled' ? String(existing.borrower) !== String(userId) && !access.canAnswer : !access.canAnswer) throw equipmentError('この申込みを変更できません。', 403);
  const allowed = action === 'returned' ? ['approved'] : action === 'cancelled' ? ['pending', 'approved'] : ['pending'];
  if (!allowed.includes(existing.status)) throw equipmentError('申込みの状態が変更されています。', 409);
  const loan = await EquipmentLoan.findOneAndUpdate({ _id: loanId, association: associationId, status: existing.status }, { $set: { status: action, decidedBy: userId, decidedAt: new Date() } }, { new: true });
  if (!loan) throw equipmentError('申込みの状態が変更されています。', 409);
  if (action !== 'approved') await AssociationEquipment.updateOne({ _id: existing.equipment, association: associationId }, { $pull: { reservations: { loanId: existing._id } }, $inc: { reservationVersion: 1 } });
  try { await Notification.create({ association: associationId, recipient: existing.borrower, type: 'equipment_loan', title: `設備・備品の貸出：${({ approved: '承認', rejected: '却下', cancelled: '取消', returned: '返却済み' })[action]}`, body: `${existing.startDate}〜${existing.endDate} ${existing.allDay === false ? `${existing.startTime}〜${existing.endTime}` : '終日'}`, relatedType: 'AssociationEquipment', relatedId: existing.equipment }); }
  catch (error) { console.error('Equipment loan notification failed:', error.name); }
  return loan;
};
export const setEquipmentLoanBlock = async ({ associationId, userId, equipmentId, input, blockId }) => {
  await equipmentAccess(associationId, userId, true); checkedEquipmentId(equipmentId);
  const item = await AssociationEquipment.findOne({ _id: equipmentId, association: associationId, deletedAt: null }).lean();
  if (!item) throw equipmentError('備品を確認できません。', 404);
  let blocks = [...(item.loanBlocks || [])];
  if (blockId) { checkedEquipmentId(blockId); if (!blocks.some(block => String(block._id) === String(blockId))) throw equipmentError('利用NG日の設定を確認できません。', 404); blocks = blocks.filter(block => String(block._id) !== String(blockId)); }
  else {
    const startDate = validEquipmentDate(input.startDate), endDate = validEquipmentDate(input.endDate || input.startDate), reason = text(input.reason, 500, '利用NGの理由', true);
    if (startDate < japanDate() || endDate < startDate || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 366) throw equipmentError('利用NG日は今日以降、最大367日で指定してください。');
    const times = equipmentLoanTimes({ ...input, startDate, endDate }), loans = await activeReservations(associationId, equipmentId, item);
    if (!times.allDay && times.startAt < new Date()) throw equipmentError('利用NGの開始日時は現在以降で指定してください。');
    if (loans.some(loan => { const window = equipmentLoanWindow(loan); return window.start < times.endAt.getTime() && window.end > times.startAt.getTime(); })) throw equipmentError('予約がある時間帯は利用NGにできません。該当予約を先に取り消してください。', 409);
    blocks.push({ _id: new mongoose.Types.ObjectId(), startDate, endDate, ...times, reason, createdBy: userId, createdAt: new Date() });
  }
  const updated = await AssociationEquipment.updateOne({ _id: equipmentId, association: associationId, deletedAt: null, ...reservationVersionFilter(item) }, { $set: { loanBlocks: blocks }, $inc: { reservationVersion: 1 } });
  if (!updated.matchedCount) throw equipmentError('予約状況が変更されました。カレンダーを開き直してください。', 409);
};

export const receiveEquipment = async ({ associationId, userId, equipmentId, input }) => {
  await equipmentAccess(associationId, userId, true); checkedEquipmentId(equipmentId);
  const quantity = equipmentNumber(input.quantity, '購入数量', 0.001), expiryDate = validEquipmentDate(input.expiryDate, true);
  return mongoose.connection.transaction(async session => {
    const item = await AssociationEquipment.findOne({ _id: equipmentId, association: associationId, deletedAt: null }).session(session);
    if (!item) throw equipmentError('備品を確認できません。', 404);
    if (item.lendable && !Number.isInteger(quantity)) throw equipmentError('貸出備品の数量は整数で入力してください。');
    if (item.expiryDate && item.quantity > 0 && expiryDate && expiryDate !== item.expiryDate) throw equipmentError('異なる期限の在庫は別の備品として登録してください。');
    item.quantity = equipmentNumber(item.quantity + quantity, '入庫後の数量'); item.wishlist = false; if (expiryDate) item.expiryDate = expiryDate; await item.save({ session });
    await EquipmentPurchase.create([{ association: associationId, equipment: equipmentId, name: item.name, quantity, expiryDate: item.expiryDate, receivedBy: userId }], { session }); return item;
  });
};
export const equipmentOfficerNotice = async ({ associationId, key, type, title, body, relatedId }) => {
  const today = japanDate(), year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0), now = new Date();
  const roles = await RoleDefinition.find({ association: associationId, active: true, permissions: 'association.manage' }).distinct('_id');
  const [officers, managers] = await Promise.all([AnnualOfficer.find({ association: associationId, fiscalYear: year, cancelledAt: null }).distinct('user'), RoleAssignment.find({ association: associationId, role: { $in: roles }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }).distinct('user')]);
  const recipients = await AssociationMembership.find({ association: associationId, status: 'active', user: { $in: [...officers, ...managers].filter(Boolean) } }).distinct('user');
  if (!recipients.length) return;
  try { await mongoose.connection.transaction(async session => {
    await EquipmentReminder.create([{ key, association: associationId }], { session });
    await Notification.insertMany(recipients.map(recipient => ({ association: associationId, recipient, type, title, body, relatedType: 'AssociationEquipment', relatedId })), { session });
  }); } catch (error) { if (error.code !== 11000) throw error; }
};
export const runEquipmentReminders = async (now = new Date()) => {
  const today = japanDate(now);
  const associations = await NeighborhoodAssociation.find({ status: 'active', deletedAt: null }).select('_id').lean();
  for (const association of associations) {
    const settings = await EquipmentSettings.findOne({ association: association._id }).lean();
    if (!settings) continue;
    const period = reminderPeriod(settings, today);
    if (period) await equipmentOfficerNotice({ associationId: association._id, key: `inventory:${association._id}:${period}`, type: 'equipment_inventory', title: `${period.replace('-', '年')}月の設備・備品棚卸し`, body: '保管場所ごとの棚卸しリストを確認してください。' });
    const items = await AssociationEquipment.find({ association: association._id, deletedAt: null, wishlist: { $ne: true }, expiryDate: { $ne: '', $lte: addMonths(today, settings.expiryAlertMonths) }, quantity: { $gt: 0 } }).lean();
    for (const item of items) if (item.expiryDate) await equipmentOfficerNotice({ associationId: association._id, key: `expiry:${item._id}:${item.expiryDate}`, type: 'equipment_expiry', title: `${item.name}の期限が近づいています`, body: `期限：${item.expiryDate}／保管場所：${item.place}`, relatedId: item._id });
  }
};
