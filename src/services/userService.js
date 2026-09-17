import { User } from '../models/user.js';
import { PendingUserRegistration } from '../models/pendingUserRegistration.js';
import { createEmailVerification } from './emailVerificationService.js';

export const registerUser = async ({ username, email, displayname, password, residentMode = 'representative', householdHeadEmail, householdInvitation, association, registrationPurpose }) => {
  const normalized = {
    username: String(username || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    displayname: String(displayname || '').trim(),
    password: String(password || '')
  };
  if (!normalized.username || !normalized.email || !normalized.email.includes('@')) {
    throw Object.assign(new Error('invalid_registration_fields'), { status: 400 });
  }
  if (normalized.password.length < 8) {
    throw Object.assign(new Error('password_too_short'), { status: 400 });
  }
  const headEmail = String(householdHeadEmail || '').trim().toLowerCase();
  if (!['representative', 'general'].includes(residentMode) || (residentMode === 'general' && !householdInvitation && (!/^\S+@\S+\.\S+$/.test(headEmail) || headEmail === normalized.email))) {
    throw Object.assign(new Error('invalid_household_head_email'), { status: 400 });
  }
  await PendingUserRegistration.deleteMany({
    expiresAt: { $lte: new Date() },
    $or: [{ username: normalized.username }, { email: normalized.email }]
  });
  const [sameUsername, sameEmail, pendingUsername, pendingEmail] = await Promise.all([
    User.exists({ username: normalized.username }),
    User.findOne({ email: normalized.email }).collation({ locale: 'en', strength: 2 }).select('_id').lean(),
    PendingUserRegistration.exists({ username: normalized.username }),
    PendingUserRegistration.findOne({ email: normalized.email }).collation({ locale: 'en', strength: 2 }).select('_id').lean()
  ]);
  if (sameUsername || sameEmail || pendingUsername || pendingEmail) {
    throw Object.assign(new Error('account_already_exists'), { status: 409 });
  }
  const now = new Date();
  const verification = createEmailVerification();
  const passwordCarrier = new User({
    username: normalized.username,
    email: normalized.email,
    displayname: normalized.displayname || undefined
  });
  await new Promise((resolve, reject) => passwordCarrier.setPassword(normalized.password, (error) => error ? reject(error) : resolve()));
  const pendingRegistration = await PendingUserRegistration.create({
    username: normalized.username,
    email: normalized.email,
    displayname: normalized.displayname || undefined,
    salt: passwordCarrier.salt,
    hash: passwordCarrier.hash,
    tokenDigest: verification.digest,
    expiresAt: verification.expiresAt,
    verificationSentAt: now,
    residentMode, householdHeadEmail: residentMode === 'general' ? headEmail : undefined, householdInvitation, association, registrationPurpose
  });
  return { user: pendingRegistration, verificationToken: verification.token };
};
