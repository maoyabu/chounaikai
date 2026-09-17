import mongoose from 'mongoose';

const tenantField = { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true };
const tokenDigest = { type: String, required: true, unique: true, select: false };

const joinApplicationSchema = new mongoose.Schema({
  association: tenantField,
  applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup', required: true, index: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
  status: { type: String, enum: ['awaiting_household', 'pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
  source: { type: String, enum: ['representative', 'household_invitation', 'household_link'], default: 'representative' },
  householdMember: { type: mongoose.Schema.Types.ObjectId, ref: 'HouseholdMember' },
  invitation: { type: mongoose.Schema.Types.ObjectId, ref: 'Invitation' },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  householdConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  householdConfirmedAt: Date,
  cancelledAt: Date,
  residentProfile: { name: String, nameKana: String, birthDate: Date, gender: String, email: String, lineAccount: String, relationship: String },
  applicantNote: String,
  addressEvidence: String,
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  rejectionReason: String
}, { timestamps: true, collection: 'join_applications' });
joinApplicationSchema.index({ association: 1, applicant: 1 }, { unique: true });

const invitationSchema = new mongoose.Schema({
  association: tenantField,
  email: { type: String, required: true, trim: true, lowercase: true },
  tokenDigest,
  status: { type: String, enum: ['pending', 'accepted', 'expired', 'cancelled'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true, index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  householdMember: { type: mongoose.Schema.Types.ObjectId, ref: 'HouseholdMember' },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: Date,
  cancelledAt: Date
}, { timestamps: true, collection: 'association_invitations' });

const withdrawalApplicationSchema = new mongoose.Schema({
  association: tenantField,
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'AssociationMembership', required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup', required: true, index: true },
  originalRepresentative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  scope: { type: String, enum: ['individual', 'household', 'representative'], required: true },
  successor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  membershipIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AssociationMembership' }],
  householdConfirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  householdConfirmedAt: Date,
  requestedEndDate: Date,
  reason: String,
  status: { type: String, enum: ['awaiting_household', 'pending', 'processing', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date
}, { timestamps: true, collection: 'withdrawal_applications' });
withdrawalApplicationSchema.index({ household: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['awaiting_household', 'pending', 'processing'] } } });

export const JoinApplication = mongoose.model('JoinApplication', joinApplicationSchema);
export const Invitation = mongoose.model('Invitation', invitationSchema);
export const WithdrawalApplication = mongoose.model('WithdrawalApplication', withdrawalApplicationSchema);
