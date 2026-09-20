import mongoose from 'mongoose';

const budgetSchema = new mongoose.Schema({
  display_order: { type: Number, default: 0 }, year: { type: String, required: true },
  cf: { type: String, default: '支出' }, income_item: String, expense_item: String,
  budget: { type: Number, required: true }, group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  receiptNo: String, entry_date: { type: Date, default: Date.now }, update_date: Date
}, { strict: false, collection: 'budgets' });

export const FinanceBudget = mongoose.models.Budget || mongoose.model('Budget', budgetSchema);
