import { OfficerAnnouncement } from '../models/officerAnnouncement.js';

const announcementTypes = new Set([
  'officer_announcement', 'officer_announcement_reminder',
  'officer_network', 'officer_network_reminder',
  'district_message', 'district_message_reminder',
  'group_message', 'group_message_reminder'
]);

const isAnnouncement = item => item.relatedType === 'OfficerAnnouncement' || announcementTypes.has(item.type);

// Check the source each time so muting and restoring on the web also apply
// to existing unread notifications, without changing their read/hidden state.
export const excludeMutedAnnouncementNotifications = async notifications => {
  const ids = [...new Set(notifications.filter(item => isAnnouncement(item) && item.relatedId).map(item => String(item.relatedId)))];
  if (!ids.length) return notifications;
  const muted = await OfficerAnnouncement.find({ _id: { $in: ids }, mutedAt: { $ne: null } }).select('_id').lean();
  const mutedIds = new Set(muted.map(item => String(item._id)));
  return notifications.filter(item => !isAnnouncement(item) || !mutedIds.has(String(item.relatedId)));
};
