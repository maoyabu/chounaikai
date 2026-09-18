import mongoose from 'mongoose';

const tenant = { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true };

const groupRequestSchema = new mongoose.Schema({
  association: tenant,
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  purpose: { type: String, trim: true, maxlength: 1000 },
  publicDescription: { type: String, trim: true, maxlength: 5000 },
  publicVisibility: { type: String, enum: ['members', 'open'], default: 'members' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  rejectionReason: String
}, { timestamps: true, collection: 'association_group_requests' });
groupRequestSchema.index({ association: 1, requestedBy: 1, status: 1 });

const associationGroupSchema = new mongoose.Schema({
  association: tenant,
  name: { type: String, required: true, trim: true, maxlength: 100 },
  purpose: { type: String, trim: true, maxlength: 1000 },
  publicDescription: { type: String, trim: true, maxlength: 5000 },
  publicVisibility: { type: String, enum: ['members', 'open'], default: 'members' },
  publicPhotos: [{ url: String, publicId: String, caption: String }],
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'association_groups' });
associationGroupSchema.index({ association: 1, name: 1 }, { unique: true });

const groupMembershipSchema = new mongoose.Schema({
  association: tenant,
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'AssociationGroup', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['member', 'manager'], default: 'member' },
  status: { type: String, enum: ['active', 'pending', 'rejected', 'invited'], default: 'active', index: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  joinedAt: Date
}, { timestamps: true, collection: 'association_group_memberships' });
groupMembershipSchema.index({ group: 1, user: 1 }, { unique: true });

const groupJoinRequestSchema = new mongoose.Schema({
  association: tenant,
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'AssociationGroup', required: true, index: true },
  applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  rejectionReason: String
}, { timestamps: true, collection: 'association_group_join_requests' });
groupJoinRequestSchema.index({ group: 1, applicant: 1 }, { unique: true });

export const AssociationGroupRequest = mongoose.model('AssociationGroupRequest', groupRequestSchema);
export const AssociationGroup = mongoose.model('AssociationGroup', associationGroupSchema);
export const AssociationGroupMembership = mongoose.model('AssociationGroupMembership', groupMembershipSchema);
export const AssociationGroupJoinRequest = mongoose.model('AssociationGroupJoinRequest', groupJoinRequestSchema);
