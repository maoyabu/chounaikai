import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: { type: String, default: 'site' },
  mfaEnabled: { type: Boolean, required: true, default: true },
  revision: { type: String, required: true },
  history: [{ actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, actorName: String, at: { type: Date, required: true }, before: Boolean, after: Boolean }]
}, { collection: 'chounaikai_site_security_settings', writeConcern: { w: 'majority', wtimeout: 5000 } });
export const SiteSecuritySettings = mongoose.models.SiteSecuritySettings || mongoose.model('SiteSecuritySettings', schema);
