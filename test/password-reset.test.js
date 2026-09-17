import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { PasswordReset } from '../src/models/passwordReset.js';
import { User } from '../src/models/user.js';
import { resetPassword, isPasswordResetValid } from '../src/services/passwordResetService.js';
import { webRouter } from '../src/routes/web.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

test('reset rejects invalid or expired tokens without changing a user', async t => {
  const update = t.mock.method(User, 'updateOne', async () => { throw new Error('must not write'); });
  const claim = t.mock.method(PasswordReset, 'findOneAndDelete', async filter => {
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return null;
  });
  assert.equal(await resetPassword({ token: 'invalid', password: 'password123', confirmation: 'password123' }), false);
  assert.equal(claim.mock.callCount(), 0);
  assert.equal(await resetPassword({ token: 'a'.repeat(64), password: 'password123', confirmation: 'password123' }), false);
  assert.equal(update.mock.callCount(), 0);
});

test('reset validates password length and confirmation before consuming a link', async t => {
  const claim = t.mock.method(PasswordReset, 'findOneAndDelete', async () => { throw new Error('must not consume'); });
  for (const [password, confirmation] of [['short', 'short'], ['a'.repeat(129), 'a'.repeat(129)], ['password123', 'different']]) {
    await assert.rejects(resetPassword({ token: 'a'.repeat(64), password, confirmation }), { status: 400 });
  }
  assert.equal(claim.mock.callCount(), 0);
});

test('reset atomically consumes a hashed token and updates only shared password fields', async t => {
  const token = 'b'.repeat(64);
  let consumed = false, fields;
  t.mock.method(PasswordReset, 'findOneAndDelete', async filter => {
    assert.equal(filter.tokenDigest, crypto.createHash('sha256').update(token).digest('hex'));
    if (consumed) return null;
    consumed = true;
    return { user: 'user-id' };
  });
  t.mock.method(User, 'updateOne', async (filter, update) => {
    assert.deepEqual(filter, { _id: 'user-id' });
    fields = update.$set;
    assert.deepEqual(Object.keys(fields).sort(), ['hash', 'salt', 'update_date']);
    return { matchedCount: 1 };
  });
  assert.equal(await resetPassword({ token, password: 'new-password123', confirmation: 'new-password123' }), true);
  assert.notEqual(fields.hash, 'new-password123');
  const carrier = new User({ username: 'test', ...fields });
  const authentication = await carrier.authenticate('new-password123');
  assert.ok(authentication.user);
  assert.equal(await resetPassword({ token, password: 'another-password123', confirmation: 'another-password123' }), false);
});

test('reset token validation enforces expiry and rejects malformed links', async t => {
  const exists = t.mock.method(PasswordReset, 'exists', async filter => {
    assert.ok(filter.expiresAt.$gt instanceof Date);
    return {};
  });
  assert.equal(await isPasswordResetValid('bad'), false);
  assert.equal(exists.mock.callCount(), 0);
  assert.equal(await isPasswordResetValid('c'.repeat(64)), true);
});

test('password reset forms have CSRF and never expose the emailed token', async () => {
  for (const mode of ['request', 'reset', 'invalid', 'complete']) {
    const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/password-reset.ejs', import.meta.url)), { title: '再設定', csrfToken: 'csrf', mode, message: null, formError: null });
    if (['request', 'reset'].includes(mode)) assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /name="token"/);
    assert.match(html, /\/login/);
  }
  for (const path of ['/forgot-password', '/reset-password']) {
    const layer = webRouter.stack.find(layer => layer.route?.path === path && layer.route.methods.post);
    assert.ok(layer.route.stack.some(item => item.handle === verifyCsrfToken));
  }
});
