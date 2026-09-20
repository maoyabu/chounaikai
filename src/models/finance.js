import mongoose from 'mongoose';

const financeSchema = new mongoose.Schema({
  date: { type: Date, required: true }, month: Number, day: Number,
  cf: { type: String, required: true }, income_item: String, expense_item: String,
  content: String, sub_tag: String, amount: { type: Number, required: true },
  payment_type: { type: String, required: true }, receiptNo: String, memo: String,
  corrected: { storeName: String, amount: String, date: String },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  entry_date: { type: Date, default: Date.now }, update_date: Date,
  tags: [{ name: String, category: String, price: Number }]
}, { strict: false, collection: 'finances' });

financeSchema.pre('findOneAndUpdate', function updateDate(next) {
  this.set({ update_date: new Date() });
  next();
});

export const Finance = mongoose.models.Finance || mongoose.model('Finance', financeSchema);
