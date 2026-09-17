import mongoose from 'mongoose';

const annualLeaderAssignmentSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  fiscalYear: { type: Number, required: true, min: 2000, max: 2200, index: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup', required: true },
  representative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household' },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notifiedAt: Date,
  cancelledAt: Date
}, { timestamps: true, collection: 'annual_leader_assignments' });

annualLeaderAssignmentSchema.index({ association: 1, fiscalYear: 1, districtGroup: 1 }, { unique: true });

export const AnnualLeaderAssignment = mongoose.model('AnnualLeaderAssignment', annualLeaderAssignmentSchema);
