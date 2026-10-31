import mongoose from 'mongoose';

const safetyReportSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  eventKey: { type: String, required: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
  memberStatuses: { type: Map, of: { type: Number, enum: [1, 2, 3, 4] }, default: () => ({}) },
  buildingStatus: { type: Number, enum: [1, 2, 3, 4], default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'safety_reports' });
safetyReportSchema.index({ association: 1, eventKey: 1, household: 1 }, { unique: true });

export const SafetyReport = mongoose.model('SafetyReport', safetyReportSchema);
