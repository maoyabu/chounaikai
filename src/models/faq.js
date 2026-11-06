import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', default: null },
  category: { type: String, required: true, trim: true, maxlength: 100 },
  question: { type: String, required: true, trim: true, maxlength: 1000 },
  answer: { type: String, required: true, trim: true, maxlength: 10000 },
  relatedUrl: { type: String, default: '', maxlength: 2000 },
  openToPublic: { type: Boolean, default: false },
  published: { type: Boolean, default: false },
  position: { type: Number, default: 0 }
}, { timestamps: true });
schema.index({ association: 1, position: 1, _id: 1 });
export const Faq = mongoose.model('Faq', schema);
