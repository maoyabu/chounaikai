import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, required: true, trim: true, maxlength: 3000 },
  photo: { type: Buffer, select: false }, // Legacy photos migrate to Drive on access.
  photoAttachment: { type: new mongoose.Schema({
    fileId: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: String,
    bytes: Number
  }, { _id: false }) },
  photoType: { type: String, required: true },
  latitude: { type: Number, min: -90, max: 90 },
  longitude: { type: Number, min: -180, max: 180 },
  locationSource: { type: String, enum: ['device', 'photo', 'address'], default: 'device' },
  address: { type: String, trim: true, maxlength: 300 },
  accuracy: { type: Number, min: 0 },
  locatedAt: { type: Date }
}, { timestamps: true, collection: 'danger_reports' });
schema.index({ association: 1, createdAt: -1, _id: -1 });
export const DangerReport = mongoose.model('DangerReport', schema);
