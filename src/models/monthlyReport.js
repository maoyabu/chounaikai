import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  information: { type: String, default: '', maxlength: 20000 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'monthly_reports' });
schema.index({ association: 1, month: 1 }, { unique: true });

export const MonthlyReport = mongoose.model('MonthlyReport', schema);
