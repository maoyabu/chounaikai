import { productionErrorResponses, applicationErrorHandler } from '../src/middleware/errorResponses.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createMobileAccountSettingsRouter } from '../src/routes/mobileAccountSettings.js';
import { User } from '../src/models/user.js';
import { PasswordReset } from '../src/models/passwordReset.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { HouseholdMember } from '../src/models/organization.js';
import { WithdrawalApplication } from '../src/models/workflow.js';
const uid = 'aaaaaaaaaaaaaaaaaaaaaaaa', aid = 'bbbbbbbbbbbbbbbbbbbbbbbb', hid = 'cccccccccccccccccccccccc';
const q = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
async function start(t, production = false) {
  const session = { csrfToken: 'valid', passwordResetToken: 'reset' };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { _id: uid }; req.isAuthenticated = () => req.get('x-auth') !== 'no'; req.session = session; res.render = (_view, locals) => res.json(locals); next(); });
  if (production) app.use(productionErrorResponses('production'));
  app.use('/api/profile', createMobileAccountSettingsRouter({ lineService: {}, passkeys: {} }));
  if (production) app.use(applicationErrorHandler('production'));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/profile${path}`, {
    headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {})
  });
  return { request, session };
}
test('account actions require authentication and CSRF', async t => {
  const { request } = await start(t);
  for (const path of ['/password', '/withdrawals']) assert.equal((await request(path, null, { 'x-auth': 'no' })).status, 401);
  const token = await request('/password'); assert.match(token.headers.get('cache-control'), /no-store/);
  assert.equal((await token.json()).csrfToken, 'valid');
  for (const path of ['/password', `/withdrawals/${aid}/request`, `/withdrawals/${aid}/cancel`, `/withdrawals/${aid}/${hid}/approve`, `/withdrawals/${aid}/${hid}/reject`]) {
    assert.equal((await request(path, { _csrf: 'wrong' })).status, 403);
  }
});
test('password change binds user, clears reset token, and throttles repeated attempts', async t => {
  const { request, session } = await start(t);
  const user = new User({ username: 'resident' }); await user.setPassword('old-password');
  t.mock.method(User, 'findById', id => { assert.equal(id, uid); return { select: async () => user }; });
  t.mock.method(User, 'updateOne', async filter => { assert.equal(filter._id, uid); return { matchedCount: 1 }; });
  t.mock.method(PasswordReset, 'deleteOne', async () => ({}));
  const body = { _csrf: 'valid', currentPassword: 'old-password', password: 'new-password', passwordConfirmation: 'new-password', userId: aid };
  assert.equal((await request('/password', body)).status, 200);
  assert.equal(session.passwordResetToken, undefined);
  assert.ok((await user.authenticate('new-password')).user);
  assert.equal((await request('/password', body)).status, 429);
});
test('invalid passwords return validation errors without writes', async t => {
  const { request, session } = await start(t);
  for (const password of ['short', 'a'.repeat(129)]) {
    session.passwordChangeAttemptAt = 0;
    assert.equal((await request('/password', { _csrf: 'valid', currentPassword: 'old-password', password, passwordConfirmation: password })).status, 400);
  }
});
test('withdrawal data filters inactive memberships and returns own history and eligible successors', async t => {
  const { request } = await start(t);
  t.mock.method(AssociationMembership, 'find', filter => {
    if (filter.user === uid) return q([
      { association: { _id: aid, name: '町内会' }, household: { _id: hid, active: true, representative: uid } },
      { association: null, household: { active: true } }, { association: { _id: hid }, household: { active: false } }
    ]);
    assert.deepEqual(filter.household.$in, [hid]);
    return q([{ household: hid, user: { _id: aid, displayname: '家族' } }, { household: hid, user: { _id: hid, displayname: '対象外' } }]);
  });
  t.mock.method(HouseholdMember, 'find', () => q([{ user: aid }]));
  t.mock.method(WithdrawalApplication, 'find', filter => {
    if (filter.requestedBy) { assert.equal(filter.requestedBy, uid); return q([{ _id: hid, association: { _id: aid, name: '町内会' }, status: 'pending', scope: 'household' }]); }
    if (filter.status === 'awaiting_household') { assert.deepEqual(filter.household.$in, [hid]); return q([]); }
    return q([{ household: hid }]);
  });
  const response = await request('/withdrawals'); assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.memberships.length, 1); assert.equal(value.memberships[0].isHead, true); assert.equal(value.memberships[0].busy, true);
  assert.deepEqual(value.memberships[0].successors, [{ id: aid, name: '家族' }]);
  assert.equal(value.applications[0].status, 'pending');
});
test('cancellation binds current applicant and pending states; stale requests fail', async t => {
  const { request } = await start(t);
  const update = t.mock.method(WithdrawalApplication, 'updateOne', async filter => {
    assert.equal(filter.requestedBy, uid); assert.deepEqual(filter.status.$in, ['pending', 'awaiting_household']);
    return { modifiedCount: 1 };
  });
  assert.equal((await request(`/withdrawals/${hid}/cancel`, { _csrf: 'valid', actorId: aid })).status, 200);
  update.mock.mockImplementation(async () => ({ modifiedCount: 0 }));
  assert.equal((await request(`/withdrawals/${hid}/cancel`, { _csrf: 'valid' })).status, 404);
});
test('withdrawal request requires explicit confirmation before persistence', async t => {
  const { request } = await start(t);
  assert.equal((await request(`/withdrawals/${aid}/request`, { _csrf: 'valid', scope: 'household' })).status, 400);
});

test('production password API preserves only fixed validation messages and accepts valid changes', async t => {
  const { request, session } = await start(t, true);
  const user = new User({ username: 'resident' }); await user.setPassword('old-password');
  t.mock.method(User, 'findById', () => ({ select: async () => user }));
  const update = t.mock.method(User, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(PasswordReset, 'deleteOne', async () => ({}));
  const base = { _csrf: 'valid', currentPassword: 'old-password', password: 'new-password', passwordConfirmation: 'new-password' };
  for (const [patch, code, message] of [
    [{ password: 'short' }, 'password_length_invalid', '新しいパスワードは8〜128文字で入力してください。'],
    [{ passwordConfirmation: 'different' }, 'password_confirmation_mismatch', '確認用パスワードが一致しません。'],
    [{ currentPassword: 'incorrect' }, 'password_current_incorrect', '現在のパスワードが正しくありません。']
  ]) {
    session.passwordChangeAttemptAt = 0;
    const response = await request('/password', { ...base, ...patch });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: code, message });
  }
  assert.equal(update.mock.callCount(), 0);
  session.passwordChangeAttemptAt = 0;
  assert.equal((await request('/password', base)).status, 200);
  assert.equal(update.mock.callCount(), 1);
});
