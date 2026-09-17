import crypto from 'node:crypto';
import { User } from '../models/user.js';
import { PasswordReset } from '../models/passwordReset.js';
import { assertMailConfigured, sendPasswordResetEmail } from './emailVerificationService.js';

const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const validToken = token => /^[a-f0-9]{64}$/.test(String(token || ''));

export const requestPasswordReset = async email => {
  assertMailConfigured();
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized) || normalized.length > 254) return;
  const user = await User.findOne({ email: normalized }).collation({ locale: 'en', strength: 2 }).select('_id email hash').lean();
  if (!user?.hash) return;
  const now = new Date();
  const token = crypto.randomBytes(32).toString('hex');
  let reset;
  try {
    reset = await PasswordReset.findOneAndUpdate({ user: user._id, sentAt: { $lte: new Date(now.getTime() - 60000) } },
      { $set: { tokenDigest: digest(token), expiresAt: new Date(now.getTime() + 3600000), sentAt: now } },
      { upsert: true, new: true, runValidators: true });
  } catch (error) { if (error.code === 11000) return; throw error; }
  try { await sendPasswordResetEmail({ email: user.email, token }); }
  catch (error) { await PasswordReset.deleteOne({ _id: reset._id, tokenDigest: digest(token) }); throw error; }
};

export const isPasswordResetValid = async token => validToken(token) && Boolean(await PasswordReset.exists({ tokenDigest: digest(token), expiresAt: { $gt: new Date() } }));

export const resetPassword = async ({ token, password, confirmation }) => {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw Object.assign(new Error('パスワードは8〜128文字で入力してください。'), { status: 400 });
  if (password !== confirmation) throw Object.assign(new Error('確認用パスワードが一致しません。'), { status: 400 });
  if (!validToken(token)) return false;
  const carrier = new User({ username: 'password-reset', email: 'reset@example.invalid' });
  await new Promise((resolve, reject) => carrier.setPassword(password, error => error ? reject(error) : resolve()));
  // Atomic consumption prevents concurrent requests from using the same link twice.
  const reset = await PasswordReset.findOneAndDelete({ tokenDigest: digest(token), expiresAt: { $gt: new Date() } });
  if (!reset) return false;
  const result = await User.updateOne({ _id: reset.user }, { $set: { salt: carrier.salt, hash: carrier.hash, update_date: new Date() }, $unset: { resetPasswordToken: '', resetPasswordExpires: '' } });
  return result.matchedCount === 1;
};
