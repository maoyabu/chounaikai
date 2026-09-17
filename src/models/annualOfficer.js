import mongoose from 'mongoose';

const annualOfficerSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  fiscalYear: { type: Number, required: true, min: 2000, max: 2200, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'RoleDefinition' },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cancelledAt: Date
}, { timestamps: true, collection: 'annual_officers' });

annualOfficerSchema.index({ association: 1, fiscalYear: 1, user: 1 }, { unique: true });

export const AnnualOfficer = mongoose.model('AnnualOfficer', annualOfficerSchema);
