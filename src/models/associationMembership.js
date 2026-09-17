import mongoose from 'mongoose';

export const MEMBERSHIP_STATUSES = ['pending', 'active', 'withdrawal_pending', 'inactive', 'rejected'];

const associationMembershipSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: MEMBERSHIP_STATUSES, default: 'pending', required: true, index: true },
  startedAt: Date,
  endedAt: Date,
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  residentVerifiedAt: Date,
  joinedBy: { type: String, enum: ['application', 'invitation', 'admin'], required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, collection: 'association_memberships' });

associationMembershipSchema.index({ association: 1, user: 1 }, { unique: true });

export const AssociationMembership = mongoose.model('AssociationMembership', associationMembershipSchema);
