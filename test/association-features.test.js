import test from 'node:test';
import assert from 'node:assert/strict';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { associationFeatureEnabled, optionalAssociationFeatures, parseAssociationFeatures, featureForAssociationPath } from '../src/services/associationFeatureService.js';
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
