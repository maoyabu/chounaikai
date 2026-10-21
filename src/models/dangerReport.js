import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, required: true, trim: true, maxlength: 3000 },
  photo: { type: Buffer, required: true, select: false },
  photoType: { type: String, required: true },
  latitude: { type: Number, required: true, min: -90, max: 90 },
  longitude: { type: Number, required: true, min: -180, max: 180 },
  locationSource: { type: String, enum: ['device', 'photo'], default: 'device' },
  accuracy: { type: Number, min: 0 },
  locatedAt: { type: Date, required: true }
}, { timestamps: true, collection: 'danger_reports' });
schema.index({ association: 1, createdAt: -1, _id: -1 });
export const DangerReport = mongoose.model('DangerReport', schema);
