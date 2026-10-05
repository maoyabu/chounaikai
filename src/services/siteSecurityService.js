import crypto from 'node:crypto';
import { SiteSecuritySettings } from '../models/siteSecuritySettings.js';

export const createSiteSecurityService = (Settings = SiteSecuritySettings) => {
  const get = async () => {
    const settings = await Settings.findById('site').lean();
    if (!settings) return { _id: 'site', mfaEnabled: true, revision: 'initial', history: [] };
    if (typeof settings.mfaEnabled !== 'boolean' || typeof settings.revision !== 'string' || !settings.revision) throw new Error('site_security_settings_invalid');
    return settings;
  };
  const change = async ({ enabled, revision, actor }) => {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('入力内容を確認してください。'), { status: 400 });
    const current = await get();
    if (current.revision !== revision || current.mfaEnabled === enabled) throw Object.assign(new Error('設定が変更されています。画面を再読み込みしてください。'), { status: 409 });
    const update = { $set: { mfaEnabled: enabled, revision: crypto.randomUUID() }, $push: { history: { actor: actor._id, actorName: actor.displayname || actor.username, at: new Date(), before: current.mfaEnabled, after: enabled } } };
    try {
      const saved = await Settings.findOneAndUpdate({ _id: 'site', revision }, update, { new: true, upsert: revision === 'initial', runValidators: true }).lean();
      if (!saved) throw Object.assign(new Error('設定が変更されています。画面を再読み込みしてください。'), { status: 409 });
      return saved;
    } catch (error) {
      if (error.code === 11000) throw Object.assign(new Error('設定が変更されています。画面を再読み込みしてください。'), { status: 409 });
      throw error;
    }
  };
  return { get, change };
};

export const applySiteMfaPolicy = (mfa, policy) => ({
  ...mfa,
  getEnrollmentState: user => mfa.getState(user),
  async getState(user) {
    const settings = await policy.get();
    if (!settings.mfaEnabled) return { siteEnabled: false, policyRevision: settings.revision, required: false, credential: null };
    return { ...await mfa.getState(user), siteEnabled: true, policyRevision: settings.revision };
  }
});
