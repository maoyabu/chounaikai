import mongoose from 'mongoose';

// Compatibility model for the existing `groups` collection.
const groupSchema = new mongoose.Schema({
  group_name: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  invitedUsers: [String]
}, {
  collection: 'groups',
  strict: true,
  timestamps: true
});

export const Group = mongoose.models.Group || mongoose.model('Group', groupSchema);
