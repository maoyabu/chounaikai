import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'AssociationGroup', index: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  category: { type: String, required: true, trim: true },
  color: { type: String, required: true },
  visible: { type: Boolean, default: true },
  open: { type: Boolean, default: false },
  completed: { type: Boolean, default: false }
  ,image: { url: String, publicId: String }, imageCaption: String, youtubeUrl: String, qrUrl: String, qrCaption: String
}, { timestamps: true });

schema.index({ association: 1, group: 1, startDate: 1 });
export const AssociationEvent = mongoose.models.AssociationEvent || mongoose.model('AssociationEvent', schema);
