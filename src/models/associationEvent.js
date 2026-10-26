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
  allDay: { type: Boolean, default: false },
  hasEndDate: { type: Boolean, default: true },
  recurrence: {
    frequency: { type: String, enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], default: 'none' },
    weekdays: { type: [Number], default: [] },
    monthDays: { type: [Number], default: [] },
    monthlyMode: { type: String, enum: ['dates', 'weekday'], default: 'dates' },
    monthWeek: { type: Number, min: 1, max: 5 },
    monthWeekday: { type: Number, min: 0, max: 6 },
    yearMonth: Number,
    yearDay: Number,
    until: String
  },
  category: { type: String, required: true, trim: true },
  color: { type: String, required: true },
  visible: { type: Boolean, default: true },
  open: { type: Boolean, default: false },
  completed: { type: Boolean, default: false },
  implementationReport: { type: String, trim: true, default: '' }
  ,image: { url: String, publicId: String, fileId: String, mimeType: String, originalName: String, storage: String }, imageCaption: String, youtubeUrl: String, qrUrl: String, qrCaption: String
}, { timestamps: true });

schema.index({ association: 1, group: 1, startDate: 1 });
export const AssociationEvent = mongoose.models.AssociationEvent || mongoose.model('AssociationEvent', schema);
