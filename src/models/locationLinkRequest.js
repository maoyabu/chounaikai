import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup', required: true },
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date
}, { timestamps: true, collection: 'location_link_requests' });
schema.index({ association: 1, requestedBy: 1, user: 1, household: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
export const LocationLinkRequest = mongoose.model('LocationLinkRequest', schema);
