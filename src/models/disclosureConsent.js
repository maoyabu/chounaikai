import mongoose from 'mongoose';
const scopes = Object.fromEntries(['photo', 'name', 'address', 'phone', 'email'].map(field => [field, { type: String, enum: field === 'photo' ? ['private', 'officers', 'residents', 'open'] : ['private', 'officers', 'residents'], default: 'private' }]));
const changeSchema = new mongoose.Schema({ actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, required: true }, scopes: { type: new mongoose.Schema(scopes, { _id: false }), required: true } }, { _id: false });
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  scopes: { type: new mongoose.Schema(scopes, { _id: false }), default: () => ({}) },
  confirmedAt: Date,
  policyRevision: { type: Number, min: 0 },
  fiscalYear: { type: Number, required: true },
  history: { type: [changeSchema], default: [] }
}, { timestamps: true, collection: 'officer_disclosure_consents' });
schema.index({ association: 1, user: 1 }, { unique: true });
export const DisclosureConsent = mongoose.model('DisclosureConsent', schema);
