import test from 'node:test';
import assert from 'node:assert/strict';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { associationFeatureEnabled, optionalAssociationFeatures, parseAssociationFeatures, featureForAssociationPath, parseResidentDisplay, residentDisplayEnabled } from '../src/services/associationFeatureService.js';
import { requireEnabledAssociationFeature } from '../src/middleware/associationFeatures.js';

test('optional features default to disabled for both existing records and new associations', () => {
  const association = new NeighborhoodAssociation();
  for (const [key] of optionalAssociationFeatures) {
    assert.equal(associationFeatureEnabled(association, key), false);
    assert.equal(associationFeatureEnabled({}, key), false);
  }
});

test('feature selection accepts only known checkboxes and supports disabling everything', () => {
  const selected = parseAssociationFeatures({ events: 'on', groups: 'on', finance: 'true', unknown: 'on' });
  assert.deepEqual(selected, { goodPlaces: false, events: true, groups: true, equipment: false, finance: false });
  assert.ok(Object.values(parseAssociationFeatures()).every(value => value === false));
});

test('feature routes include nested pages, uploads and group administration but leave basic settings accessible', () => {
  for (const [path, feature] of [['good-places/123/photo', 'goodPlaces'], ['events/123/delete', 'events'], ['groups/123/messages', 'groups'], ['equipment/settings', 'equipment'], ['finance/entries/export', 'finance'], ['manage/groups/123', 'groups']]) {
    assert.deepEqual(featureForAssociationPath(`/associations/abc/${path}`), { associationId: 'abc', feature });
  }
  assert.equal(featureForAssociationPath('/associations/abc/manage/features'), null);
  assert.equal(featureForAssociationPath('/associations/abc/officer-network/groups'), null);
});

test('disabled direct access stops before route handlers and re-enabling preserves access', async () => {
  const original = NeighborhoodAssociation.findOne;
  let enabled = false;
  NeighborhoodAssociation.findOne = () => ({ select: () => ({ lean: async () => ({ optionalFeatures: { equipment: enabled } }) }) });
  try {
    for (const value of [false, true, false]) {
      enabled = value;
      let proceeded = false, status;
      const response = { status(code) { status = code; return this; }, render() {} };
      await requireEnabledAssociationFeature({ path: '/associations/507f1f77bcf86cd799439011/equipment' }, response, error => { assert.ifError(error); proceeded = true; });
      assert.equal(proceeded, value);
      assert.equal(status, value ? undefined : 404);
    }
  } finally { NeighborhoodAssociation.findOne = original; }
});

test('officer menu hides optional functions and pending loans, then restores them when enabled', async () => {
  const { default: ejs } = await import('ejs');
  const common = { assetVersion: 'test', showNotificationPrompt: false, title: '役員メニュー', currentUser: null, csrfToken: 'token', unansweredCount: 1, pendingLoanCount: 1, pendingLoanItems: [{ equipmentId: 'item', name: '会議室', count: 1 }] };
  for (const enabled of [false, true]) {
    const association = { _id: 'test', name: '中央町内会', optionalFeatures: Object.fromEntries(optionalAssociationFeatures.map(([key]) => [key, enabled])) };
    const html = await ejs.renderFile('src/views/officer-menu.ejs', { ...common, association });
    for (const path of ['equipment', 'finance', 'events/manage']) assert.equal(html.includes(`href="/associations/test/${path}"`), enabled);
    assert.equal(html.includes('会議室：貸出依頼'), enabled);
    assert.ok(html.includes('/questions/officer'));
    assert.ok(html.includes('/announcements/officer'));
    assert.ok(html.includes('/documents'));
  }
});

test('basic settings shows saved selections and always available functions', async () => {
  const { default: ejs } = await import('ejs');
  const html = await ejs.renderFile('src/views/association-basic-settings.ejs', {
    assetVersion: 'test', showNotificationPrompt: false, title: '基本設定', currentUser: null, csrfToken: 'token', notice: null,
    association: { _id: 'test', name: '中央町内会', optionalFeatures: { events: true } }, roles: [], departments: [], districtGroups: [], optionalAssociationFeatures
  });
  assert.match(html, /name="events" checked/);
  assert.match(html, /name="finance" >/);
  assert.match(html, /基本機能（常時利用）/);
  assert.match(html, /Google Drive連携/);
  assert.match(html, /保存済みデータは削除されず/);
});


test('resident display defaults to visible and accepts only the four display checkboxes', () => {
  const association = new NeighborhoodAssociation();
  for (const key of ['departmentPlans', 'officers', 'leaders', 'districts']) {
    assert.equal(residentDisplayEnabled(association, key), true);
    assert.equal(residentDisplayEnabled({}, key), true);
    assert.equal(residentDisplayEnabled({ residentDisplay: { [key]: false } }, key), false);
  }
  assert.deepEqual(parseResidentDisplay({ display_officers: 'on', display_leaders: 'true', unknown: 'on' }), {
    departmentPlans: false, officers: true, leaders: false, districts: false
  });
});

test('feature settings save independent display preferences with audit history', async t => {
  const { managementRouter } = await import('../src/routes/management.js');
  const { AuditLog } = await import('../src/models/auditLog.js');
  let saved = false, auditEntry;
  const association = { _id: 'assoc', optionalFeatures: { events: true }, residentDisplay: { officers: true }, async save() { saved = true; } };
  t.mock.method(NeighborhoodAssociation, 'findOne', async filter => { assert.equal(filter._id, 'assoc'); return association; });
  t.mock.method(AuditLog, 'create', async entry => { auditEntry = entry; });
  const handler = managementRouter.stack.find(layer => layer.route?.path === '/:associationId/manage/features').route.stack.at(-1).handle;
  const req = { params: { associationId: 'assoc' }, user: { _id: 'manager' }, body: { events: 'on', display_departmentPlans: 'on' }, session: {}, get: () => 'test', ip: '127.0.0.1' };
  let redirect;
  await handler(req, { redirect(path) { redirect = path; } }, error => { throw error; });
  assert.equal(saved, true);
  assert.equal(association.optionalFeatures.events, true);
  assert.deepEqual(association.residentDisplay, { departmentPlans: true, officers: false, leaders: false, districts: false });
  assert.deepEqual(auditEntry.before.residentDisplay, { officers: true });
  assert.equal(auditEntry.after.residentDisplay.officers, false);
  assert.equal(redirect, '/associations/assoc/manage/basic');
});

 test('leaders require the district list in both saved and effective display settings', () => {
  assert.equal(residentDisplayEnabled({ residentDisplay: { districts: false, leaders: true } }, 'leaders'), false);
  assert.equal(parseResidentDisplay({ display_leaders: 'on' }).leaders, false);
  assert.equal(parseResidentDisplay({ display_districts: 'on', display_leaders: 'on' }).leaders, true);
 });
