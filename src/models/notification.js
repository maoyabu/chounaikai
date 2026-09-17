import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['district_leader_assigned', 'join_application_received', 'join_application_approved', 'join_application_rejected', 'household_link_requested', 'household_removed', 'withdrawal_head_requested', 'withdrawal_leader_requested', 'withdrawal_approved', 'withdrawal_rejected', 'question_answered', 'officer_announcement', 'officer_announcement_reminder', 'officer_network', 'officer_network_reminder', 'district_message', 'district_message_reminder'], required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  relatedType: String,
  relatedId: mongoose.Schema.Types.ObjectId,
  readAt: Date
}, { timestamps: true, collection: 'notifications' });

export const Notification = mongoose.model('Notification', notificationSchema);
