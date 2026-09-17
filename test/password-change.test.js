import test from 'node:test';
import assert from 'node:assert/strict';
import { User } from '../src/models/user.js';
import { PasswordReset } from '../src/models/passwordReset.js';
import { changePassword } from '../src/services/passwordChangeService.js';
import { webRouter } from '../src/routes/web.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

const input = { userId: 'user-id', currentPassword: 'old-password123', password: 'new-password123', confirmation: 'new-password123' };
const setup = async t => {
  const user = new User({ username: 'resident', email: 'resident@example.test' });
  await user.setPassword(input.currentPassword);
  const hash = user.hash;
  t.mock.method(User, 'findById', () => ({ select: async () => user }));
  const update = t.mock.method(User, 'updateOne', async () => ({ matchedCount: 1 }));
  const cleanup = t.mock.method(PasswordReset, 'deleteOne', async () => ({}));
  return { user, hash, update, cleanup };
};

test('profile password change checks the current password and preserves identity fields', async t => {
  const { user, hash, update, cleanup } = await setup(t);
  await changePassword(input);
  const [filter, fields] = update.mock.calls[0].arguments;
  assert.deepEqual(filter, { _id: input.userId, hash });
  assert.deepEqual(Object.keys(fields.$set).sort(), ['hash', 'salt', 'update_date']);
  assert.notEqual(fields.$set.hash, hash);
  assert.ok((await user.authenticate(input.password)).user);
  assert.equal((await user.authenticate(input.currentPassword)).user, false);
  assert.deepEqual(cleanup.mock.calls[0].arguments[0], { user: input.userId });
});

test('wrong current password cannot change credentials or revoke reset links', async t => {
  const { update, cleanup } = await setup(t);
  await assert.rejects(changePassword({ ...input, currentPassword: 'incorrect' }), /現在のパスワードが正しくありません/);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(cleanup.mock.callCount(), 0);
});

test('profile password change rejects short mismatched and unchanged passwords', async t => {
  const { update } = await setup(t);
  for (const extra of [{ password: 'short' }, { confirmation: 'different' }, { password: input.currentPassword, confirmation: input.currentPassword }, { password: 'a'.repeat(129) }]) {
    await assert.rejects(changePassword({ ...input, ...extra }), { status: 400 });
  }
  assert.equal(update.mock.callCount(), 0);
});

test('concurrent password changes cannot overwrite a newer password', async t => {
  const { update } = await setup(t);
  update.mock.mockImplementation(async () => ({ matchedCount: 0 }));
  await assert.rejects(changePassword(input), /状態が変わりました/);
});

test('profile password route requires login and CSRF verification', () => {
  const layer = webRouter.stack.find(layer => layer.route?.path === '/profile/password');
  assert.ok(layer.route.methods.post);
  assert.ok(layer.route.stack.some(item => item.handle === requireLogin));
  assert.ok(layer.route.stack.some(item => item.handle === verifyCsrfToken));
});
