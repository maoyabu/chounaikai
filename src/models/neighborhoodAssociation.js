import mongoose from 'mongoose';

const neighborhoodAssociationSchema = new mongoose.Schema({
  // The legacy group is created only after approval. Sparse uniqueness lets
  // multiple applications wait without a group reference.
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', unique: true, sparse: true, index: true },
  publicSlug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  name: { type: String, required: true, trim: true },
  requestedGroupName: { type: String, required: true, trim: true },
  status: { type: String, enum: ['pending', 'active', 'inactive', 'rejected'], default: 'pending', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  deletedAt: { type: Date, index: true },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  statusBeforeDeletion: { type: String, enum: ['pending', 'active', 'inactive', 'rejected'] },
  address: {
    postalCode: String,
    prefecture: String,
    city: String,
    street: String
  },
  serviceArea: { type: String, default: '' },
  contact: {
    name: String,
    email: String,
    phone: String
  },
  introduction: { type: String, default: '' },
  publicPhotos: { type: [{ url: String, publicId: String }], default: [] },
  eventCategories: { type: [String], default: [] },
  socialLinks: { instagram: String, x: String, youtube: String },
  symbolImage: { url: String, publicId: String }
}, { timestamps: true, collection: 'neighborhood_associations' });

export const NeighborhoodAssociation = mongoose.model('NeighborhoodAssociation', neighborhoodAssociationSchema);
