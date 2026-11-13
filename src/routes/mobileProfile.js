import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { acceptProfileImage, persistProfileImage } from '../services/profileImageService.js';
import { User } from '../models/user.js';
import { Household, HouseholdMember } from '../models/organization.js';

export const mobileProfileRouter = express.Router();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const basicProfile = user => ({
  username: user.username || '', displayname: user.displayname || '', email: user.email || '',
  avatar: user.avatar || '', birthDate: user.birth_date ? new Date(user.birth_date).toISOString().slice(0, 10) : '',
  sex: user.sex || 'unspecified'
});
export const profileValues = body => {
  const displayname = String(body.displayname || '').trim(), email = String(body.email || '').trim().toLowerCase();
  const birth = String(body.birth_date || '').trim(), sex = String(body.sex || 'unspecified');
  if (!displayname || displayname.length > 100 || !/^\S+@\S+\.\S+$/.test(email)) throw fail('氏名と有効なメールアドレスを入力してください。');
  const birth_date = birth ? new Date(`${birth}T00:00:00.000Z`) : null;
  if (birth && (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || !Number.isFinite(birth_date.getTime()) || birth_date.toISOString().slice(0, 10) !== birth)) throw fail('生年月日を正しく入力してください。');
  if (!['male', 'female', 'other', 'unspecified'].includes(sex)) throw fail('性別を正しく選択してください。');
  return { displayname, email, birth_date, sex, update_date: new Date() };
};
mobileProfileRouter.use(requireLogin, provideCsrfToken, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
mobileProfileRouter.get('/', async (req, res, next) => {
  try {
    const resident = await HouseholdMember.findOne({ user: req.user._id, endsAt: null }).lean();
    const user = req.user.toObject();
    user.birth_date ||= resident?.birthDate;
    if (!user.sex || user.sex === 'unspecified') user.sex = resident?.gender || user.sex;
    res.json({ profile: basicProfile(user), csrfToken: res.locals.csrfToken });
  } catch (error) { next(error); }
});
mobileProfileRouter.post('/', acceptProfileImage, verifyCsrfToken, async (req, res, next) => {
  try {
    const update = profileValues(req.body);
    if (await User.exists({ _id: { $ne: req.user._id }, email: update.email })) throw fail('このメールアドレスは既に使用されています。', 409);
    const saved = await persistProfileImage({ file: req.file, userId: req.user._id, associationId: req.body.avatarAssociation, update });
    const householdIds = await HouseholdMember.find({ user: req.user._id, isRepresentative: true }).distinct('household');
    await Promise.all([
      HouseholdMember.updateMany({ user: req.user._id }, { $set: { name: update.displayname, email: update.email,
        ...(update.birth_date ? { birthDate: update.birth_date } : {}), gender: update.sex } }),
      Household.updateMany({ _id: { $in: householdIds }, representative: req.user._id }, { $set: { displayName: `${update.displayname}世帯` } })
    ]);
    Object.assign(req.user, saved);
    res.json({ profile: basicProfile({ ...req.user.toObject(), ...saved }), csrfToken: res.locals.csrfToken });
  } catch (error) {
    if (error?.code === 11000) return next(fail('このメールアドレスは既に使用されています。', 409));
    next(error);
  }
});
