import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { AlertEvent } from '../models/alertEvent.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Notification } from '../models/notification.js';

export const alertLevelNotificationRecord = (event, change, recipient) => {
  const id = createHash('sha256').update(`${change.noticeKey}:${recipient}`).digest().subarray(0, 12);
  const name = change.noticeAssociationName || '町内会';
  const action = change.noticePreviousLevel ? `警戒レベルが${change.noticePreviousLevel}から${change.level}に上がりました。` : `警戒レベル${change.level}が登録されました。`;
  return {
    _id: new mongoose.Types.ObjectId(id), association: event.association, recipient,
    type: 'alert_level',
    title: `【警戒レベル${change.level}${change.noticePreviousLevel ? 'に上昇' : '発生'}】${name}`,
    body: `${name}の${action} 身の安全を確保したうえで、できるだけ早くリンク先から世帯の安否情報を登録してください。既に登録済みの場合も、状況に変化があれば更新してください。登録日時：${new Date(change.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    relatedType: 'AlertEvent', relatedId: event._id,
    deliveryKey: `${change.noticeKey}:${recipient}`, queuedAt: new Date()
  };
};

// The pending marker is committed with the warning history. Materializing the
// delivery queue is retryable: deterministic IDs keep existing/sent notices intact.
export async function dispatchAlertLevelNotifications() {
  const events = await AlertEvent.find({ 'changes.noticePending': true }).select('_id association changes').limit(20).lean();
  for (const event of events) {
    for (const change of event.changes.filter(item => item.noticePending && item.noticeKey)) {
      try {
        const users = await AssociationMembership.find({ association: event.association, status: 'active' }).distinct('user');
        const recipients = [...new Set(users.filter(Boolean).map(String))];
        if (recipients.length) {
          const operations = recipients.map(recipient => {
            const record = alertLevelNotificationRecord(event, change, recipient);
            return { updateOne: { filter: { _id: record._id }, update: { $setOnInsert: record }, upsert: true } };
          });
          await Notification.bulkWrite(operations, { ordered: false });
        }
        await AlertEvent.updateOne({ _id: event._id, association: event.association }, { $set: { 'changes.$[change].noticePending': false } }, { arrayFilters: [{ 'change.noticeKey': change.noticeKey }] });
      } catch (error) {
        // Preserve the pending marker for the next worker iteration.
        console.error('Alert level notification queue failed:', error.name);
      }
    }
  }
}
