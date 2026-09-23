import mongoose from 'mongoose';

const announcementSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  channel: { type: String, enum: ['resident', 'officer', 'district', 'association_group'], required: true, default: 'resident' },
  audience: { type: String, enum: ['leaders', 'all', 'officers_all', 'department', 'officer_individual', 'officer_group', 'district_all', 'district_individual'], required: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  associationGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'AssociationGroup', index: true },
  targetDepartment: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  targetOfficer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  targetOfficers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  targetGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'OfficerContactGroup' },
  urgency: { type: Number, min: 1, max: 5, required: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body: { type: String, required: true, maxlength: 5000 },
  attachments: [{
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    originalName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, maxlength: 120 },
    bytes: { type: Number, required: true, min: 1 },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'raw' },
    expiresAt: { type: Date, required: true, index: true }
  }],
  responseMode: { type: String, enum: ['none', 'single', 'multiple'], required: true, default: 'none' },
  options: { type: [String], default: [] },
  mutedAt: Date,
  mutedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  editedAt: Date
}, { timestamps: true, collection: 'officer_announcements' });
announcementSchema.index({ association: 1, createdAt: -1 });

const receiptSchema = new mongoose.Schema({
  announcement: { type: mongoose.Schema.Types.ObjectId, ref: 'OfficerAnnouncement', required: true, index: true },
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  readAt: Date,
  selectedOptions: [{ type: Number, min: 0, max: 4 }],
  respondedAt: Date,
  lastRemindedAt: Date
}, { timestamps: true, collection: 'officer_announcement_receipts' });
receiptSchema.index({ announcement: 1, recipient: 1 }, { unique: true });
receiptSchema.index({ association: 1, recipient: 1, readAt: 1 });

export const OfficerAnnouncement = mongoose.model('OfficerAnnouncement', announcementSchema);
export const OfficerAnnouncementReceipt = mongoose.model('OfficerAnnouncementReceipt', receiptSchema);
