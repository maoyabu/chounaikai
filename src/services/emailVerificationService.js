import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { User } from '../models/user.js';
import { PendingUserRegistration } from '../models/pendingUserRegistration.js';
import { ResidentRegistration } from '../models/residentRegistration.js';
import { acceptHouseholdInvitation } from './householdParticipationService.js';

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const digestToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

export const createEmailVerification = () => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, digest: digestToken(token), expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS) };
};

const mailConfig = () => {
  const required = (name) => {
    const value = String(process.env[name] || '').trim();
    if (!value) throw Object.assign(new Error(`${name}_is_required`), { code: 'mail_not_configured' });
    return value;
  };
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/$/, ''),
    from: required('MAIL_FROM'),
    transport: {
      host: required('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: required('SMTP_USER'), pass: required('SMTP_PASS') }
    }
  };
};

export const assertMailConfigured = () => mailConfig();

export const sendPasswordResetEmail = async ({ email, token }) => {
  const config = mailConfig();
  const url = `${config.publicBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const transporter = nodemailer.createTransport({ ...config.transport, disableFileAccess: true, disableUrlAccess: true });
  await transporter.sendMail({ from: config.from, to: email, subject: '【まちの伝言板】パスワードの再設定',
    text: `以下のリンクからパスワードを再設定してください。\n${url}\n\n有効期限は1時間です。心当たりがない場合は操作不要です。共通アカウントを使用する他のサービスのパスワードも変更されます。`,
    html: `<p><a href="${escapeHtml(url)}">パスワードを再設定する</a></p><p>有効期限は1時間です。心当たりがない場合は操作不要です。</p><p>共通アカウントを使用する他のサービスのパスワードも変更されます。</p>` });
};

export const sendVerificationEmail = async ({ user, token }) => {
  const config = mailConfig();
  const verificationUrl = `${config.publicBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const transporter = nodemailer.createTransport({ ...config.transport, disableFileAccess: true, disableUrlAccess: true });
  await transporter.sendMail({
    from: config.from,
    to: user.email,
    subject: '【町内会管理】メールアドレスの確認',
    text: `${user.displayname || user.username}さん\n\n以下のURLを開いて登録を完了してください。\n${verificationUrl}\n\nこのURLの有効期限は24時間です。`,
    html: `<p>${escapeHtml(user.displayname || user.username)}さん</p><p>以下のボタンからメールアドレスを確認し、登録を完了してください。</p><p><a href="${verificationUrl}" style="display:inline-block;padding:12px 20px;background:#176b4d;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">メールアドレスを確認</a></p><p>このURLの有効期限は24時間です。</p>`
  });
};

export const sendHouseholdInvitationEmail = async ({ email, token, associationName, inviterName, memberName }) => {
  const config = mailConfig();
  const url = `${config.publicBaseUrl}/household-invitations?token=${encodeURIComponent(token)}`;
  const transporter = nodemailer.createTransport({ ...config.transport, disableFileAccess: true, disableUrlAccess: true });
  await transporter.sendMail({
    from: config.from, to: email, subject: `【まちの伝言板】${associationName}・世帯への招待`,
    text: `${memberName}さん\n\n${inviterName}さんから同一世帯のメンバーとして招待されました。\n${url}\n\nリンクから招待を確認し、会員登録またはログインして受諾してください。班長または町内会管理者の承認後に利用できます。招待の有効期限は7日間です。心当たりがない場合は操作不要です。`,
    html: `<p>${escapeHtml(memberName)}さん</p><p>${escapeHtml(inviterName)}さんから「${escapeHtml(associationName)}」の同一世帯へ招待されました。</p><p><a href="${url}">招待を確認する</a></p><p>会員登録またはログインして受諾してください。班長または町内会管理者の承認後に利用できます。有効期限は7日間です。心当たりがない場合は操作不要です。</p>`
  });
};

export const verifyEmailToken = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const digest = digestToken(String(token || ''));
  const now = new Date();
  const pending = await PendingUserRegistration.findOne({ tokenDigest: digest, expiresAt: { $gt: now } })
    .select('+tokenDigest +salt +hash');
  if (!pending) return null;

  const existing = await User.findOne({ $or: [{ username: pending.username }, { email: pending.email }] });
  if (existing) {
    await PendingUserRegistration.deleteOne({ _id: pending._id });
    return null;
  }
  const user = await User.create({
    username: pending.username,
    email: pending.email,
    displayname: pending.displayname,
    salt: pending.salt,
    hash: pending.hash,
    entry_date: now,
    update_date: now,
    emailVerificationRequired: true,
    emailVerifiedAt: now,
    groups: [],
    isAdmin: false
  });
  await ResidentRegistration.findOneAndUpdate({ user: user._id }, { $set: {
    residentMode: pending.residentMode || 'representative',
    householdHeadEmail: pending.householdHeadEmail,
    householdInvitation: pending.householdInvitation,
    association: pending.association,
    registrationPurpose: pending.registrationPurpose
  } }, { upsert: true, setDefaultsOnInsert: true });
  await PendingUserRegistration.deleteOne({ _id: pending._id });
  if (pending.householdInvitation) {
    user.$locals ||= {};
    try {
      await acceptHouseholdInvitation({ invitationId: pending.householdInvitation, user });
      user.$locals.householdParticipationSubmitted = true;
    } catch (error) {
      // The account remains valid even if the household invitation expired during signup.
      console.error('Verified household invitation could not be accepted', error.message);
      user.$locals.householdParticipationError = error.status && error.status < 500 ? error.message : '世帯への紐付けを完了できませんでした。ログイン後に招待を再確認してください。';
    }
  }
  return user;
};

export const resendVerification = async (email) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = await PendingUserRegistration.findOne({
    email: normalizedEmail,
    expiresAt: { $gt: new Date() }
  }).select('+tokenDigest');
  if (!user) return null;
  if (user.verificationSentAt && Date.now() - user.verificationSentAt.getTime() < RESEND_WAIT_MS) {
    return { throttled: true };
  }
  const verification = createEmailVerification();
  await PendingUserRegistration.updateOne(
    { _id: user._id, expiresAt: { $gt: new Date() } },
    { $set: {
      tokenDigest: verification.digest,
      expiresAt: verification.expiresAt,
      verificationSentAt: new Date()
    } }
  );
  await sendVerificationEmail({ user, token: verification.token });
  return { sent: true };
};
