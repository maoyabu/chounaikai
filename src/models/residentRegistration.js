import mongoose from 'mongoose';

// Onboarding belongs to this application, not the shared legacy User document.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  residentMode: { type: String, enum: ['representative', 'general'], default: 'representative' },
  householdHeadEmail: { type: String, trim: true, lowercase: true },
  householdInvitation: { type: mongoose.Schema.Types.ObjectId, ref: 'Invitation' },
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation' },
  registrationPurpose: { type: String, enum: ['join', 'create'] }
}, { timestamps: true, collection: 'resident_registrations' });

export const ResidentRegistration = mongoose.model('ResidentRegistration', schema);
