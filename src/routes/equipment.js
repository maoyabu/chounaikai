import { equipmentDaySchedule } from '../services/equipmentTimeService.js';
import express from 'express';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { verifyCsrfToken } from '../middleware/csrf.js';
import { AssociationEquipment, EquipmentSettings, EquipmentInventory, EquipmentLoan, EquipmentPurchase } from '../models/equipment.js';
import { equipmentAccess, equipmentSettings, equipmentGroups, equipmentShortage, equipmentSettingsValues, equipmentError, checkedEquipmentId, inventoryPeriod, japanDate, addMonths, monthIndex, monthString, loanCapacity, setEquipmentLoanBlock, saveEquipment, checkInventory, requestEquipmentLoan, decideEquipmentLoan, receiveEquipment, equipmentUrl } from '../services/equipmentService.js';

export const equipmentRouter = express.Router();
equipmentRouter.use(requireLogin);
const base = id => `/associations/${id}/equipment`;
const handler = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { if (req.get('X-Requested-With') === 'XMLHttpRequest') { const status = Number(error.status) || 500; if (status >= 500) console.error('Equipment request failed:', error.name); return res.status(status).json({ error: status < 500 ? error.message : '保存できませんでした。時間をおいて再度お試しください。' }); } next(error); } };
const activeItems = association => AssociationEquipment.find({ association, deletedAt: null }).sort({ place: 1, stockCategory: 1, name: 1 }).lean();
const choices = items => Object.fromEntries(['place', 'stockCategory', 'disasterCategory', 'unit'].map(field => [field, [...new Set(items.map(item => item[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))]));
const inventoryData = async associationId => {
  const settings = await equipmentSettings(associationId), period = inventoryPeriod(settings);
  const items = (await activeItems(associationId)).filter(item => item.tracked && !item.wishlist);
  const checks = await EquipmentInventory.find({ association: associationId, period }).populate('checkedBy', 'displayname username').lean();
  const byItem = new Map(checks.map(check => [String(check.equipment), check]));
  return { settings, period, items: items.map(item => ({ ...item, check: byItem.get(String(item._id)), shortage: equipmentShortage(item) })) };
};

equipmentRouter.get('/:associationId/equipment', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id);
  const items = await activeItems(access.association._id);
  const tab = ['all', 'stock', 'disaster', 'wishlist'].includes(req.query.tab) ? req.query.tab : 'all';
  const filtered = items.filter(item => tab === 'all' || (tab === 'stock' ? !item.wishlist : tab === 'disaster' ? !item.wishlist && Boolean(item.disasterCategory) : item.wishlist));
  res.render('equipment-list', { title: '設備・備品管理', ...access, items: filtered, groups: equipmentGroups(filtered, tab === 'disaster' ? 'disasterCategory' : 'stockCategory'), tab, base: base(req.params.associationId) });
}));

equipmentRouter.get('/:associationId/equipment/settings', requirePermission('association.manage'), handler(async (req, res) => {
  const { association } = await equipmentAccess(req.params.associationId, req.user._id);
  res.render('equipment-settings', { title: '設備・備品管理の設定', association, settings: await equipmentSettings(association._id), base: base(association._id) });
}));
equipmentRouter.post('/:associationId/equipment/settings', verifyCsrfToken, requirePermission('association.manage'), handler(async (req, res) => {
  await equipmentAccess(req.params.associationId, req.user._id);
  await EquipmentSettings.findOneAndUpdate({ association: req.params.associationId }, { $set: equipmentSettingsValues(req.body) }, { upsert: true, runValidators: true });
  req.session.notice = '設備・備品管理の設定を保存しました。'; res.redirect(`/associations/${req.params.associationId}/manage`);
}));

equipmentRouter.get('/:associationId/equipment/new', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id, true);
  const items = await activeItems(access.association._id);
  res.render(req.query.modal === '1' ? 'partials/equipment-editor' : 'equipment-edit', { modal: req.query.modal === '1', title: '設備・備品を追加', ...access, item: { place: String(req.query.place || '').slice(0, 100), unit: '個', quantity: 0, minimumQuantity: 0, tracked: true, wishlist: req.query.tab === 'wishlist' }, choices: choices(items), base: base(req.params.associationId) });
}));
equipmentRouter.post('/:associationId/equipment', verifyCsrfToken, handler(async (req, res) => {
  await saveEquipment({ associationId: req.params.associationId, userId: req.user._id, input: req.body }); req.session.notice = '設備・備品を登録しました。'; if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true }); res.redirect(base(req.params.associationId));
}));

equipmentRouter.get('/:associationId/equipment/inventory', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id, true), data = await inventoryData(req.params.associationId);
  res.render('equipment-inventory', { title: '棚卸しリスト', ...access, ...data, groups: equipmentGroups(data.items), base: base(req.params.associationId) });
}));
equipmentRouter.get('/:associationId/equipment/inventory.xlsx', handler(async (req, res) => {
  const { association } = await equipmentAccess(req.params.associationId, req.user._id, true), data = await inventoryData(req.params.associationId);
  const workbook = buildEquipmentInventoryWorkbook({ association, ...data });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="equipment-inventory.xlsx"; filename*=UTF-8''${encodeURIComponent(`${data.period}設備・備品棚卸し.xlsx`)}`);
  res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
}));
equipmentRouter.post('/:associationId/equipment/inventory/:equipmentId', verifyCsrfToken, handler(async (req, res) => {
  await checkInventory({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, period: req.body.period, input: req.body });
  req.session.notice = '棚卸しの数量とチェック情報を記録しました。'; res.redirect(`${base(req.params.associationId)}/inventory#place-${encodeURIComponent(req.body.place || '')}`);
}));

equipmentRouter.get('/:associationId/equipment/purchase-list', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id, true), settings = await equipmentSettings(req.params.associationId), today = japanDate();
  const items = (await activeItems(req.params.associationId)).map(item => ({ ...item, shortage: equipmentShortage(item) })).filter(item => item.wishlist || item.shortage > 0 || (item.quantity > 0 && item.expiryDate && item.expiryDate <= addMonths(today, settings.expiryAlertMonths)));
  const purchases = await EquipmentPurchase.find({ association: req.params.associationId }).populate('receivedBy', 'displayname username').sort({ createdAt: -1 }).limit(30).lean();
  res.render('equipment-purchases', { title: 'そろそろ購入リスト', ...access, settings, items, purchases, today, base: base(req.params.associationId) });
}));

equipmentRouter.get('/:associationId/equipment/:equipmentId/edit', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id, true);
  const item = await AssociationEquipment.findOne({ _id: checkedEquipmentId(req.params.equipmentId), association: req.params.associationId, deletedAt: null }).lean();
  if (!item) throw equipmentError('備品を確認できません。', 404);
  res.render(req.query.modal === '1' ? 'partials/equipment-editor' : 'equipment-edit', { modal: req.query.modal === '1', title: '設備・備品を編集', ...access, item, choices: choices(await activeItems(req.params.associationId)), base: base(req.params.associationId) });
}));
equipmentRouter.post('/:associationId/equipment/:equipmentId/edit', verifyCsrfToken, handler(async (req, res) => {
  await saveEquipment({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, input: req.body }); req.session.notice = '設備・備品を更新しました。'; if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true }); res.redirect(base(req.params.associationId));
}));
equipmentRouter.post('/:associationId/equipment/:equipmentId/delete', verifyCsrfToken, handler(async (req, res) => {
  await equipmentAccess(req.params.associationId, req.user._id, true); checkedEquipmentId(req.params.equipmentId);
  await mongoose.connection.transaction(async session => {
    const item = await AssociationEquipment.findOneAndUpdate({ _id: req.params.equipmentId, association: req.params.associationId, deletedAt: null }, { $inc: { reservationVersion: 1 } }, { new: true, session });
    if (!item) throw equipmentError('備品を確認できません。', 404);
    if (await EquipmentLoan.exists({ association: req.params.associationId, equipment: item._id, status: { $in: ['pending', 'approved'] } }).session(session)) throw equipmentError('未完了の貸出があるため削除できません。', 409);
    item.deletedAt = new Date(); await item.save({ session });
  }); req.session.notice = '設備・備品を削除しました。'; res.redirect(base(req.params.associationId));
}));
equipmentRouter.get('/:associationId/equipment/:equipmentId/purchase', handler(async (req, res) => {
  await equipmentAccess(req.params.associationId, req.user._id, true);
  const item = await AssociationEquipment.findOne({ _id: checkedEquipmentId(req.params.equipmentId), association: req.params.associationId, deletedAt: null }).lean();
  if (!item?.productUrl) throw equipmentError('商品URLが登録されていません。');
  res.redirect(equipmentUrl(item.productUrl));
}));
equipmentRouter.post('/:associationId/equipment/:equipmentId/receive', verifyCsrfToken, handler(async (req, res) => {
  await receiveEquipment({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, input: req.body }); req.session.notice = '購入済みの入庫を記録しました。'; res.redirect(`${base(req.params.associationId)}/purchase-list`);
}));

equipmentRouter.get('/:associationId/equipment/:equipmentId/loans', handler(async (req, res) => {
  const access = await equipmentAccess(req.params.associationId, req.user._id);
  const item = await AssociationEquipment.findOne({ _id: checkedEquipmentId(req.params.equipmentId), association: req.params.associationId, deletedAt: null }).lean();
  if (!item) throw equipmentError('貸出可能な備品を確認できません。', 404);
  const today = japanDate(); const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month)) ? String(req.query.month) : today.slice(0, 7);
  const start = `${month}-01`, index = monthIndex(month), next = monthString(index + 1), end = new Date(Date.parse(`${next}-01`) - 86400000).toISOString().slice(0, 10);
  const loans = await EquipmentLoan.find({ association: req.params.associationId, equipment: item._id }).lean();
  const cells = Array(new Date(start).getUTCDay()).fill(null);
  for (let day = 1; day <= Number(end.slice(-2)); day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`, segments = equipmentDaySchedule(item, loans, date);
    const capacity = Math.max(0, ...segments.map(segment => segment.available));
    cells.push({ date, day, segments, capacity, available: date >= today && capacity > 0 });
  }
  const requests = await EquipmentLoan.find({ association: req.params.associationId, equipment: item._id, ...(access.canAnswer ? {} : { borrower: req.user._id }) }).populate('borrower', 'displayname username').sort({ createdAt: -1 }).limit(100).lean();
  res.render('equipment-loans', { title: `${item.name}の貸出`, ...access, item, cells, requests, month, previous: monthString(index - 1), next, today, base: base(req.params.associationId) });
}));
equipmentRouter.post('/:associationId/equipment/:equipmentId/loans', verifyCsrfToken, handler(async (req, res) => {
  await requestEquipmentLoan({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, input: req.body }); req.session.notice = '貸出を申し込みました。役員の承認をお待ちください。'; if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true }); res.redirect(`${base(req.params.associationId)}/${req.params.equipmentId}/loans`);
}));
equipmentRouter.post('/:associationId/equipment/loans/:loanId', verifyCsrfToken, handler(async (req, res) => {
  const loan = await decideEquipmentLoan({ associationId: req.params.associationId, userId: req.user._id, loanId: req.params.loanId, action: req.body.action }); req.session.notice = '貸出申込みを更新しました。'; res.redirect(`${base(req.params.associationId)}/${loan.equipment}/loans`);
}));

export const buildEquipmentInventoryWorkbook = ({ association, period, items }) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('設備・備品棚卸し', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, views: [{ state: 'frozen', ySplit: 3 }] });
  sheet.columns = [{ key: 'place', width: 18 }, { key: 'name', width: 28 }, { key: 'quantity', width: 12 }, { key: 'unit', width: 8 }, { key: 'count', width: 12 }, { key: 'shortage', width: 12 }, { key: 'comment', width: 25 }, { key: 'checkedBy', width: 18 }, { key: 'checkedAt', width: 22 }];
  sheet.mergeCells('A1:I1'); sheet.getCell('A1').value = `${association.name} ${period} 設備・備品棚卸しリスト`; sheet.getCell('A1').font = { bold: true, size: 16 };
  sheet.mergeCells('A2:I2'); sheet.getCell('A2').value = '紙で確認する場合は「棚卸数量」「コメント」「確認者」に記入してください。';
  sheet.getRow(3).values = ['保管場所', '設備・備品名', '登録数量', '単位', '棚卸数量', '不足数量', 'コメント', '確認者', '確認日時'];
  sheet.getRow(3).font = { bold: true }; sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F0EA' } };
  for (const item of items) sheet.addRow({ place: item.place, name: item.name, quantity: item.quantity, unit: item.unit, count: item.check?.checked ? item.check.count : null, shortage: equipmentShortage(item), comment: item.check?.comment || null, checkedBy: item.check?.checked ? item.check.checkedBy?.displayname || item.check.checkedBy?.username || null : null, checkedAt: item.check?.checkedAt ? new Date(item.check.checkedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : null });
  sheet.eachRow((row, i) => { row.height = i === 1 ? 30 : 26; if (i >= 3) row.eachCell({ includeEmpty: true }, cell => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5D1' } } }; cell.alignment = { vertical: 'middle', wrapText: true }; }); });
  sheet.autoFilter = { from: 'A3', to: 'I3' }; sheet.pageSetup.printTitlesRow = '1:3';
  return workbook;
};

equipmentRouter.post('/:associationId/equipment/:equipmentId/loan-blocks', verifyCsrfToken, handler(async (req, res) => {
  await setEquipmentLoanBlock({ associationId: req.params.associationId, userId: req.user._id, equipmentId: req.params.equipmentId, input: req.body, blockId: req.body.removeBlockId });
  req.session.notice = req.body.removeBlockId ? '利用NGの設定を解除しました。' : '利用NGの日を設定しました。';
  if (req.get('X-Requested-With') === 'XMLHttpRequest') return res.json({ ok: true });
  res.redirect(`${base(req.params.associationId)}/${req.params.equipmentId}/loans`);
}));
