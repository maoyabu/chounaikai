import mongoose from 'mongoose';

const annualDepartmentPlanSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  fiscalYear: { type: Number, required: true, min: 2000, max: 2200, index: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  goal: { type: String, required: true, trim: true },
  report: { type: String, trim: true, default: '' },
  reportUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, collection: 'annual_department_plans' });

annualDepartmentPlanSchema.index({ association: 1, fiscalYear: 1, department: 1 }, { unique: true });

export const AnnualDepartmentPlan = mongoose.model('AnnualDepartmentPlan', annualDepartmentPlanSchema);
