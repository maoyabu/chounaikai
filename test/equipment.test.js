import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { saveEquipment, equipmentValues, equipmentSettingsValues, japanDate, addMonths, inventoryPeriod, reminderPeriod, loanCapacity, equipmentGroups, equipmentShortage, requestEquipmentLoan, checkInventory, receiveEquipment, equipmentOfficerNotice, decideEquipmentLoan } from '../src/services/equipmentService.js';
import { AssociationEquipment, EquipmentLoan, EquipmentSettings, EquipmentInventory, EquipmentPurchase, EquipmentReminder } from '../src/models/equipment.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { Notification } from '../src/models/notification.js';
import { equipmentRouter, buildEquipmentInventoryWorkbook } from '../src/routes/equipment.js';
const id = () => new mongoose.Types.ObjectId();
const association = id(), user = id(), equipmentId = id();
const q = value => ({ select() { return this; }, session() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const access = (t, officer = true) => {
  t.mock.method(EquipmentSettings, 'findOne', () => q(null));
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: association, name: '中央町内会' }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => officer ? { _id: id() } : null);
};
const baseInput = { name: '飲料水', place: '倉庫', quantity: '12', unit: '本', minimumQuantity: '20', tracked: 'on', stockCategory: '飲料', disasterCategory: '非常食', expiryDate: '2027-01-31' };
test('equipment values validate quantities, dates, URLs, categories and lending bounds', () => {
  const values = equipmentValues(baseInput);
  assert.equal(values.quantity, 12); assert.equal(values.minimumQuantity, 20); assert.equal(values.tracked, true);
  assert.equal(equipmentShortage(values), 8);
  for (const patch of [{ quantity: '-1' }, { quantity: 'NaN' }, { quantity: '' }, { name: '' }, { productUrl: 'javascript:alert(1)' }, { expiryDate: '2026-02-30' }, { lendable: 'on', quantity: '1.5' }, { availableFrom: '2026-12-01', availableUntil: '2026-11-01' }]) assert.throws(() => equipmentValues({ ...baseInput, ...patch }), { status: 400 });
});
test('month-based settings validate and dates use Japan time with leap/month-end clamp', () => {
  assert.equal(japanDate(new Date('2026-09-30T15:00:00Z')), '2026-10-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-31', 2), '2027-02-28');
  assert.deepEqual(equipmentSettingsValues({ inventoryStartMonth: '2026-10', inventoryIntervalMonths: '3', expiryAlertMonths: '1' }), { inventoryStartMonth: '2026-10', inventoryIntervalMonths: 3, expiryAlertMonths: 1, loanPublic: false });
  for (const patch of [{ inventoryStartMonth: '2026-13' }, { inventoryIntervalMonths: '0' }, { inventoryIntervalMonths: '1.5' }, { expiryAlertMonths: '121' }]) assert.throws(() => equipmentSettingsValues({ inventoryStartMonth: '2026-10', inventoryIntervalMonths: '3', expiryAlertMonths: '1', ...patch }));
});
test('inventory notifications are due on previous month end and catch up after downtime', () => {
  const settings = { inventoryStartMonth: '2026-10', inventoryIntervalMonths: 3 };
  assert.equal(reminderPeriod(settings, '2026-09-29'), null);
  assert.equal(reminderPeriod(settings, '2026-09-30'), '2026-10');
  assert.equal(reminderPeriod(settings, '2026-10-02'), '2026-10');
  assert.equal(reminderPeriod(settings, '2026-12-30'), '2026-10');
  assert.equal(reminderPeriod(settings, '2026-12-31'), '2027-01');
  assert.equal(inventoryPeriod(settings, '2026-12-30'), '2026-10');
  assert.equal(inventoryPeriod(settings, '2026-12-31'), '2027-01');
  assert.equal(inventoryPeriod(settings, '2027-01-01'), '2027-01');
});
test('loan capacity counts inclusive days and peak usage instead of all overlapping requests', () => {
  const item = { quantity: 5 };
  const loans = [{ status: 'pending', startDate: '2026-11-01', endDate: '2026-11-02', quantity: 3 }, { status: 'approved', startDate: '2026-11-03', endDate: '2026-11-04', quantity: 4 }, { status: 'cancelled', startDate: '2026-11-01', endDate: '2026-11-04', quantity: 100 }];
  assert.equal(loanCapacity(item, loans, '2026-11-01', '2026-11-04'), 1);
  assert.equal(loanCapacity(item, loans, '2026-11-02', '2026-11-02'), 2);
  assert.equal(loanCapacity(item, loans, '2026-11-05', '2026-11-06'), 5);
  assert.equal(loanCapacity(item, [...loans, { status: 'pending', startDate: '2026-11-02', endDate: '2026-11-03', quantity: 2 }], '2026-11-01', '2026-11-04'), 0);
});
test('equipment list groups places and selected purpose categories', () => {
  const groups = equipmentGroups([{ ...baseInput, stockCategory: '飲料' }, { ...baseInput, name: '米', stockCategory: '食品' }, { ...baseInput, place: '集会所', stockCategory: '' }]);
  assert.equal(groups.length, 2); assert.equal(groups[0].groups.length, 2); assert.equal(groups[1].groups[0].category, '未分類');
});
test('residents cannot check inventory and foreign equipment cannot be reserved', async t => {
  access(t, false);
  await assert.rejects(checkInventory({ associationId: association, userId: user, equipmentId, period: '2026-10', input: { count: 1, checked: 'on' } }), { status: 403 });
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  t.mock.method(AssociationEquipment, 'findOne', filter => { assert.equal(String(filter.association), String(association)); assert.equal(filter.lendable, true); return q(null); });
  const today = japanDate();
  await assert.rejects(requestEquipmentLoan({ associationId: association, userId: user, equipmentId, input: { startDate: today, endDate: today, quantity: 1, purpose: '会合' } }), { status: 404 });
});
test('loan admission checks capacity before claiming a reservation and rejects insufficient capacity', async t => {
  access(t, false);
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  t.mock.method(AssociationEquipment, 'findOne', () => q({ quantity: 2 }));
  const today = japanDate();
  t.mock.method(EquipmentLoan, 'find', filter => { assert.equal(String(filter.association), String(association)); return q([{ status: 'pending', startDate: today, endDate: today, quantity: 2 }]); });
  await assert.rejects(requestEquipmentLoan({ associationId: association, userId: user, equipmentId, input: { startDate: today, endDate: today, quantity: 1, purpose: '会合' } }), { status: 409 });
});
test('loan cancellation cannot be performed by another resident', async t => {
  access(t, false);
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  t.mock.method(EquipmentLoan, 'findOne', () => q({ borrower: id(), status: 'pending' }));
  await assert.rejects(decideEquipmentLoan({ associationId: association, userId: user, loanId: id(), action: 'cancelled' }), { status: 403 });
});
test('inventory check keeps an audit history and synchronizes actual stock', async t => {
  access(t); const settings = { inventoryStartMonth: japanDate().slice(0, 7), inventoryIntervalMonths: 3 };
  t.mock.method(EquipmentSettings, 'findOne', () => q(settings));
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  let quantity, saved;
  const item = { quantity: 10, lendable: false, async save() { quantity = this.quantity; } };
  t.mock.method(AssociationEquipment, 'findOneAndUpdate', () => q(item));
  t.mock.method(EquipmentInventory, 'findOneAndUpdate', async (filter, update, options) => { assert.equal(filter.period, inventoryPeriod(settings)); assert.equal(options.session, 'session'); saved = update; return {}; });
  await checkInventory({ associationId: association, userId: user, equipmentId, period: inventoryPeriod(settings), input: { checked: 'on', count: '6', comment: '4本使用' } });
  assert.equal(quantity, 6); assert.equal(saved.$set.checked, true); assert.equal(String(saved.$push.history.actor), String(user)); assert.ok(saved.$set.checkedAt instanceof Date);
});
test('purchases keep different expiry batches separate', async t => {
  access(t); t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  t.mock.method(AssociationEquipment, 'findOne', () => q({ quantity: 2, expiryDate: '2027-01-31' }));
  await assert.rejects(receiveEquipment({ associationId: association, userId: user, equipmentId, input: { quantity: '3', expiryDate: '2028-01-31' } }), /異なる期限/);
});
test('notification ledger and recipients commit together and duplicate key is harmless', async t => {
  const manager = id();
  t.mock.method(RoleDefinition, 'find', () => ({ distinct: async () => [id()] }));
  t.mock.method(RoleAssignment, 'find', () => ({ distinct: async () => [manager] }));
  t.mock.method(AnnualOfficer, 'find', () => ({ distinct: async () => [user, user] }));
  t.mock.method(AssociationMembership, 'find', filter => { assert.equal(filter.status, 'active'); return { distinct: async () => [user, manager] }; });
  t.mock.method(mongoose.connection, 'transaction', async callback => callback('session'));
  let reminders = 0, notices = [];
  t.mock.method(EquipmentReminder, 'create', async () => { reminders++; if (reminders > 1) throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  t.mock.method(Notification, 'insertMany', async (records, options) => { assert.equal(options.session, 'session'); notices.push(...records); });
  const input = { associationId: association, key: 'inventory:period', type: 'equipment_inventory', title: '棚卸し', body: '確認してください' };
  await equipmentOfficerNotice(input); await equipmentOfficerNotice(input);
  assert.equal(notices.length, 2); assert.equal(notices[0].type, 'equipment_inventory');
});
test('all equipment writes require login and CSRF; settings require manager permission', () => {
  assert.ok(equipmentRouter.stack.some(layer => layer.name === 'requireLogin'));
  const routes = equipmentRouter.stack.filter(layer => layer.route).map(layer => layer.route);
  for (const route of routes.filter(route => route.methods.post)) assert.ok(route.stack.some(layer => layer.name === 'verifyCsrfToken'), route.path);
  assert.equal(routes.filter(route => route.path.endsWith('/settings')).length, 2);
});
test('Excel export retains paper check columns, frozen headings, print settings and quantities', async () => {
  const workbook = buildEquipmentInventoryWorkbook({ association: { name: '中央町内会' }, period: '2026-10', items: [{ ...equipmentValues(baseInput), check: { checked: true, count: 12, comment: '確認', checkedBy: { displayname: '田中' }, checkedAt: new Date('2026-10-02T00:00:00Z') } }] });
  const buffer = await workbook.xlsx.writeBuffer(); const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet(1);
  assert.equal(sheet.getCell('A4').value, '倉庫'); assert.equal(sheet.getCell('E4').value, 12); assert.equal(sheet.getCell('F4').value, 8); assert.equal(sheet.getCell('H4').value, '田中');
  assert.equal(sheet.views[0].ySplit, 3); assert.equal(sheet.pageSetup.orientation, 'landscape'); assert.equal(sheet.pageSetup.fitToWidth, 1);
});
const common = { title: '設備・備品管理', assetVersion: 'test', showNotificationPrompt: false, currentUser: { _id: user, username: '田中' }, currentPath: '', notice: null, csrfToken: 'token', association: { _id: association, name: '中央町内会' }, canAnswer: true, base: `/associations/${association}/equipment` };
const item = { _id: equipmentId, ...equipmentValues(baseInput), lendable: true, productImageUrl: 'https://example.test/water.png', productUrl: 'https://example.test/water', shortage: 8 };
test('equipment screens render cards, edit fields, place checks, purchase history and loan calendar', async () => {
  const groups = equipmentGroups([item]);
  const settings = { inventoryStartMonth: '2026-10', inventoryIntervalMonths: 3, expiryAlertMonths: 1 };
  const views = {
    'equipment-list': { items: [item], groups, tab: 'stock' },
    'equipment-edit': { item, choices: { place: ['倉庫'], unit: ['本'], stockCategory: ['飲料'], disasterCategory: ['非常食'] } },
    'equipment-settings': { settings },
    'equipment-inventory': { groups, items: [item], period: '2026-10', settings },
    'equipment-purchases': { items: [item], purchases: [], settings, today: '2026-10-02' },
    'equipment-loans': { item, cells: [null, { date: '2026-10-02', day: 2, capacity: 2, available: true }], requests: [], month: '2026-10', previous: '2026-09', next: '2026-11', today: '2026-10-02' }
  };
  for (const [view, data] of Object.entries(views)) { const html = await ejs.renderFile(`src/views/${view}.ejs`, { ...common, ...data }); assert.match(html, /<main/); assert.match(html, /token/); }
  const resident = await ejs.renderFile('src/views/equipment-list.ejs', { ...common, canAnswer: false, ...views['equipment-list'] });
  assert.doesNotMatch(resident, /この場所に追加|method="post" data-equipment-delete|>編集<|棚卸しリスト/); assert.match(resident, /貸出カレンダー/);
});

test('equipment editing saves atomically on MongoDB without transaction support', async t => {
  access(t);
  const updatedAt = new Date();
  t.mock.method(mongoose.connection, 'transaction', () => { throw new Error('Standalone MongoDB does not support transactions'); });
  t.mock.method(AssociationEquipment, 'findOne', filter => { assert.equal(String(filter.association), String(association)); return q({ _id: equipmentId, quantity: 12, reservationVersion: 3, updatedAt }); });
  t.mock.method(EquipmentLoan, 'find', () => q([]));
  let saved;
  t.mock.method(AssociationEquipment, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(filter.reservationVersion, 3); assert.equal(filter.updatedAt, updatedAt);
    assert.equal(update.$inc.reservationVersion, 1); assert.equal(options.runValidators, true);
    assert.equal(options.session, undefined); saved = update.$set; return { _id: equipmentId, ...saved };
  });
  await saveEquipment({ associationId: association, userId: user, equipmentId, input: { ...baseInput, name: '保存水', quantity: '15' } });
  assert.equal(saved.name, '保存水'); assert.equal(saved.quantity, 15);
});
test('equipment editing rejects concurrent stock changes and protects active loans', async t => {
  access(t);
  t.mock.method(AssociationEquipment, 'findOne', () => q({ quantity: 12, reservationVersion: 1, updatedAt: new Date() }));
  t.mock.method(EquipmentLoan, 'find', () => q([]));
  t.mock.method(AssociationEquipment, 'findOneAndUpdate', async () => null);
  await assert.rejects(saveEquipment({ associationId: association, userId: user, equipmentId, input: baseInput }), { status: 409 });
  t.mock.method(EquipmentLoan, 'find', () => q([{ status: 'approved', startDate: '2026-11-01', endDate: '2026-11-02', quantity: 10 }]));
  await assert.rejects(saveEquipment({ associationId: association, userId: user, equipmentId, input: { ...baseInput, lendable: 'on', quantity: '5' } }), /貸出申込みに必要な数量/);
});
test('resident calendar links and icons stay visible with purchase URLs and disabled lending', async () => {
  for (const lendable of [true, false]) {
    const entry = { ...item, lendable, productUrl: 'https://example.test/product' };
    const html = await ejs.renderFile('src/views/equipment-list.ejs', { ...common, canAnswer: false, items: [entry], groups: equipmentGroups([entry]), tab: 'all' });
    assert.match(html, new RegExp(`href="${common.base}/${equipmentId}/loans"`));
    assert.match(html, /class="equipment-calendar-link"[^>]*>\s*<svg[\s\S]*?<span>貸出カレンダー<\/span>/);
    assert.doesNotMatch(html, /class="equipment-purchase-link"/);
    const calendar = await ejs.renderFile('src/views/equipment-loans.ejs', { ...common, canAnswer: false, item: entry, cells: [], requests: [], month: '2026-10', previous: '2026-09', next: '2026-11', today: '2026-10-02' });
    assert.equal(calendar.includes('id="equipment-day-loan"'), lendable);
  }
});

test('wishlist input cannot persist inventory or lending flags', () => {
  const values = equipmentValues({...baseInput,wishlist:'on',tracked:'on',lendable:'on'});
  assert.equal(values.wishlist,true); assert.equal(values.tracked,false); assert.equal(values.lendable,false);
});
test('loan publication setting accepts on/off and private access blocks residents while officers retain access', async t => {
  access(t, false);
  const input={inventoryStartMonth:'2026-10',inventoryIntervalMonths:'3',expiryAlertMonths:'1'};
  assert.equal(equipmentSettingsValues({...input,loanPublic:'on'}).loanPublic,true);
  assert.equal(equipmentSettingsValues(input).loanPublic,false);
  const { equipmentAccess } = await import('../src/services/equipmentService.js');
  await equipmentAccess(association,user);
  t.mock.method(EquipmentSettings,'findOne',()=>q({loanPublic:false}));
  await assert.rejects(equipmentAccess(association,user),{status:403});
  t.mock.method(AnnualOfficer,'exists',async()=>({_id:id()}));
  assert.equal((await equipmentAccess(association,user)).canAnswer,true);
});
test('resident home hides private equipment and shows only published associations', async () => {
  const membership={association:{_id:association,name:'中央町内会'}};
  for (const published of [true,false]) {
    const html=await ejs.renderFile('src/views/dashboard.ejs',{...common,currentPath:'/dashboard',currentRoleTags:[],memberships:[membership],equipmentMemberships:published?[membership]:[],applications:[],pendingJoins:[],availableAssociations:[],notifications:[]});
    assert.equal(html.includes('設備・備品の貸出'),published);
    assert.equal(html.includes(`href="/associations/${association}/equipment"`),published);
  }
});
