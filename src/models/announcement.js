import mongoose from 'mongoose';

const announcementSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  status: { type: String, enum: ['draft', 'published', 'ended'], default: 'draft', index: true },
  visibility: { type: String, enum: ['public', 'resident', 'member', 'district', 'officer'], required: true },
  districtGroups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' }],
  publishFrom: Date,
  publishUntil: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'announcements' });

announcementSchema.index({ association: 1, status: 1, publishFrom: 1, publishUntil: 1 });

export const Announcement = mongoose.model('Announcement', announcementSchema);
