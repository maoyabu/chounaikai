import mongoose from 'mongoose';

const associationFeePaymentSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true, index: true },
  fiscalYear: { type: Number, required: true, min: 2000, max: 2200, index: true },
  paid: { type: Boolean, default: false },
  paidAt: Date,
  checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, collection: 'association_fee_payments' });
associationFeePaymentSchema.index({ association: 1, household: 1, fiscalYear: 1 }, { unique: true });

export const AssociationFeePayment = mongoose.model('AssociationFeePayment', associationFeePaymentSchema);
