import { AssociationMembership } from '../models/associationMembership.js';
import { Notification } from '../models/notification.js';

// Persist to the existing delivery queue; SMTP/Push outages do not roll back a report.
export async function queueDangerReportNotifications(report, { membershipModel = AssociationMembership, notificationModel = Notification, type = 'danger_report', label = '緊急・危険情報', relatedType = 'DangerReport' } = {}) {
  const users = await membershipModel.find({ association: report.association, status: 'active' }).distinct('user');
  const recipients = [...new Set(users.filter(Boolean).map(String))];
  if (!recipients.length) return;
  await notificationModel.insertMany(recipients.map(recipient => ({
    association: report.association, recipient, type,
    title: `【${label}】${report.title}`,
    body: `${label}「${report.title}」が投稿されました。詳細を確認してください。`,
    relatedType, relatedId: report._id,
    deliveryKey: `${type === 'danger_report' ? 'danger-report' : type}:${report._id}:${recipient}`, queuedAt: new Date()
  })));
}
