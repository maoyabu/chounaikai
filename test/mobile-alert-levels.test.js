import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileAlertLevelsRouter, mobileAlertHistoryEvent } from '../src/routes/mobileAlertLevels.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
const q = value => ({ select() { return this; }, lean: async () => value });
const route = path => mobileAlertLevelsRouter.stack.find(layer => layer.route?.path === path && layer.route.methods.get).route.stack.at(-1).handle;
test('mobile warning registration requires login and CSRF for writes', () => {
  assert.equal(mobileAlertLevelsRouter.stack[0].handle, requireLogin);
  const post = mobileAlertLevelsRouter.stack.find(layer => layer.route?.methods.post);
  assert.equal(post.route.stack[0].handle, verifyCsrfToken);
});
test('mobile history excludes safety snapshots and private user fields and orders changes', () => {
  const event = mobileAlertHistoryEvent({ eventKey: 'event', peakLevel: 4, safetySnapshot: [{ name: 'private' }], changes: [
    { level: 4, kind: 'changed', at: '2026-11-13T03:00:00Z', by: { displayname: '担当', email: 'private@example.com' } },
    { level: 3, kind: 'registered', at: '2026-11-13T01:00:00Z', byName: '登録者' }
  ] });
  assert.deepEqual(event.changes.map(change => change.level), [3, 4]);
  assert.equal(event.changes[1].byName, '担当');
  assert.equal(event.endedAt, null);
  assert.doesNotMatch(JSON.stringify(event), /private|safetySnapshot|email/);
});
test('mobile registration reads current level and shared guidance only for officers', async t => {
  t.mock.method(NeighborhoodAssociation, 'findOne', () => q({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: '町内会', alertLevel: 3 }));
  t.mock.method(AssociationMembership, 'findOne', () => q({ status: 'active' }));
  t.mock.method(RoleDefinition, 'find', () => q([]));
  t.mock.method(AnnualOfficer, 'exists', async () => true);
  const req = { params: { associationId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, user: { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' } };
  const res = { locals: { csrfToken: 'token' }, json(value) { this.value = value; } };
  const next = error => { if (error) throw error; };
  await route('/')(req, res, next);
  assert.equal(res.value.information.alertLevel, 3);
  assert.equal(res.value.information.alertLevels.length, 5);
  assert.equal(res.value.csrfToken, 'token');
  AnnualOfficer.exists.mock.mockImplementation(async () => false);
  await assert.rejects(route('/')(req, res, next), { status: 403 });
});
