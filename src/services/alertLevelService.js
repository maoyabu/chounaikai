import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { AlertEvent } from '../models/alertEvent.js';
import { runWithOptionalTransaction } from './associationService.js';
import { readSafetySnapshot } from './safetyHistoryService.js';
import { safetyEventKey } from '../lib/safetyStatus.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';

export const parseAlertLevel = value => {
  if (typeof value !== 'string' || !/^[0-5]$/.test(value)) {
    throw Object.assign(new Error('警戒レベルは1〜5、解除する場合は「登録なし」を選択してください。'), { status: 400 });
  }
  return Number(value);
};

export const loadAlertLevelOfficer = async (associationId, userId) => {
  const { association, canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  if (!canAnswer) throw Object.assign(new Error('警戒レベルを登録できるのは役員・町内会管理者です。'), { status: 403 });
  return association;
};

export const saveAlertLevel = async ({ associationId, userId, value, actorName = '' }) => {
  const association = await loadAlertLevelOfficer(associationId, userId);
  const alertLevel = parseAlertLevel(value);
  const previousLevel = association.alertLevel || 0;
  const eventKey = alertLevel && !previousLevel ? randomUUID() : safetyEventKey(association);
  const at = new Date();
  let associationWritten = false;
  return runWithOptionalTransaction(async session => {
    associationWritten = false;
    const options = session ? { session } : {};
    const filter = { _id: association._id, status: 'active', deletedAt: { $exists: false }, alertRevision: association.alertRevision ?? null, safetyEventKey: association.safetyEventKey ?? null };
    if (previousLevel) filter.alertLevel = previousLevel;
    else filter.$or = [{ alertLevel: 0 }, { alertLevel: null }];
    const set = { alertLevel, alertLevelUpdatedAt: at, alertLevelUpdatedBy: userId };
    if (alertLevel && !previousLevel) set.safetyEventKey = eventKey;
    const result = await NeighborhoodAssociation.updateOne(filter, { $set: set, $inc: { alertRevision: 1 } }, { ...options, runValidators: true });
    if (!result.matchedCount) throw Object.assign(new Error('警戒情報が変更されています。画面を開き直してください。'), { status: 409 });
    associationWritten = true;
    // Saving "not registered" without an active alert does not create a disaster.
    if (!alertLevel && !previousLevel) return alertLevel;
    const existing = await AlertEvent.findOne({ association: association._id, eventKey }, null, options).select('-safetySnapshot').lean();
    const changes = [];
    if (!existing && previousLevel) changes.push({ level: previousLevel, at: association.alertLevelUpdatedAt || at, by: association.alertLevelUpdatedBy, kind: 'carried' });
    changes.push({ level: alertLevel, at, by: userId, byName: actorName, kind: !previousLevel ? 'registered' : !alertLevel ? 'cleared' : previousLevel === alertLevel ? 'confirmed' : 'changed',
      ...(alertLevel > previousLevel ? { noticePending: true, noticeKey: `alert-level:${eventKey}:${(association.alertRevision || 0) + 1}`, noticePreviousLevel: previousLevel, noticeAssociationName: association.name } : {})
    });
    const update = {
      $setOnInsert: { association: association._id, eventKey, startedAt: existing?.startedAt || changes[0].at, historyIncomplete: !existing && Boolean(previousLevel) },
      $push: { changes: { $each: changes } },
      $max: { peakLevel: Math.max(previousLevel, alertLevel) }
    };
    if (!alertLevel) {
      const snapshot = await readSafetySnapshot(association._id, eventKey, session);
      update.$set = { endedAt: at, safetySnapshot: JSON.stringify(snapshot) };
    }
    await AlertEvent.updateOne({ _id: existing?._id || new mongoose.Types.ObjectId(), association: association._id, eventKey }, update, { ...options, upsert: true, runValidators: true });
    return alertLevel;
  }, async () => {
    if (!associationWritten) return;
    const set = {}, unset = {};
    for (const field of ['alertLevel', 'alertLevelUpdatedAt', 'alertLevelUpdatedBy', 'safetyEventKey', 'alertRevision']) {
      if (association[field] === undefined) unset[field] = 1;
      else set[field] = association[field];
    }
    await NeighborhoodAssociation.updateOne({ _id: association._id, alertRevision: (association.alertRevision || 0) + 1, alertLevelUpdatedAt: at }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  });
};
