import mongoose from 'mongoose';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { Department } from '../models/organization.js';
import { OfficerContactGroup } from '../models/officerContactGroup.js';
import { Notification } from '../models/notification.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../models/officerAnnouncement.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fiscalYear = (date = new Date()) => date.getMonth() < 3 ? date.getFullYear() - 1 : date.getFullYear();
const requiredText = (value, max, label) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw fail(`${label}は1〜${max}文字で入力してください。`);
  return result;
};
export const requireAnnouncementOfficer = async (associationId, userId) => {
  const access = await loadQuestionBoxAccess({ associationId, userId });
  if (!access.canAnswer) throw fail('役員のみ連絡を管理できます。', 403);
  return access.association;
};
export const requireDistrictMember = async (associationId, userId) => {
  const membership = await AssociationMembership.findOne({ association: associationId, user: userId, status: 'active' }).select('districtGroup').lean();
  if (!membership?.districtGroup) throw fail('班への参加を確認できません。', 403);
  return membership;
};
export const isCurrentDistrictLeader = async (associationId, districtGroup, userId) => Boolean(await AnnualLeaderAssignment.exists({ association: associationId, districtGroup, representative: userId, fiscalYear: fiscalYear(), cancelledAt: null }));

export const publishAnnouncement = async ({ associationId, userId, channel = 'resident', audience, targetId, targetOfficerIds = [], urgency, title, body, responseMode, options = [], associationGroupId }) => {
  const districtMembership = channel === 'district' ? await requireDistrictMember(associationId, userId) : null;
  const groupMembership = channel === 'association_group' ? await AssociationGroupMembership.findOne({ association: associationId, group: associationGroupId, user: userId, status: 'active' }) : null;
  if (!districtMembership && !groupMembership) await requireAnnouncementOfficer(associationId, userId);
  if (channel === 'resident' ? !['leaders', 'all'].includes(audience) : channel === 'officer' ? !['officers_all', 'department', 'officer_individual', 'officer_group'].includes(audience) : channel === 'district' ? !['district_all', 'district_individual'].includes(audience) : channel === 'association_group' ? audience !== 'group_all' : true) throw fail('送信先を選択してください。');
  const level = Number(urgency);
  if (!Number.isInteger(level) || level < 1 || level > 5) throw fail('緊急度は★1〜★5から選択してください。');
  if (!['none', 'single', 'multiple'].includes(responseMode)) throw fail('回答方法を選択してください。');
  const choices = (Array.isArray(options) ? options : [options]).map(value => String(value ?? '').trim()).filter(Boolean);
  if (responseMode === 'none' && choices.length) throw fail('回答なしの場合、選択肢は設定できません。');
  if (responseMode !== 'none' && (choices.length < 2 || choices.length > 5 || choices.some(value => value.length > 100) || new Set(choices).size !== choices.length)) throw fail('選択肢は重複しない2〜5件、各100文字以内で入力してください。');
  const now = new Date();
  let recipientIds, targetDepartment, targetOfficer, targetOfficers, targetGroup;
  if (channel === 'association_group') {
    if (!groupMembership) throw fail('グループメンバーだけが送信できます。', 403);
    recipientIds = (await AssociationGroupMembership.find({ association: associationId, group: associationGroupId, status: 'active' }).select('user').lean()).map(item => item.user);
  } else if (channel === 'district') {
    const members = await AssociationMembership.find({ association: associationId, districtGroup: districtMembership.districtGroup, status: 'active' }).select('user').lean();
    if (audience === 'district_all') {
      if (!await isCurrentDistrictLeader(associationId, districtMembership.districtGroup, userId)) throw fail('班全員への連絡は班長のみ送信できます。', 403);
      recipientIds = members.map(item => item.user);
    } else {
      const selected = Array.isArray(targetOfficerIds) ? targetOfficerIds : [targetOfficerIds];
      const unique = [...new Set(selected.map(String))];
      if (!unique.length || unique.some(value => !mongoose.isValidObjectId(value))) throw fail('送信先の班員を選択してください。');
      const memberIds = new Set(members.map(item => String(item.user)));
      if (unique.some(value => !memberIds.has(value))) throw fail('同じ班の住人から送信先を選択してください。');
      targetOfficers = unique;
      recipientIds = unique;
    }
  } else if (channel === 'officer') {
    const officers = await AnnualOfficer.find({ association: associationId, fiscalYear: fiscalYear(now), cancelledAt: null }).select('user department').lean();
    if (audience === 'officers_all') recipientIds = officers.map(item => item.user);
    else {
      if (audience === 'officer_individual') {
        const selected = Array.isArray(targetOfficerIds) ? targetOfficerIds : [targetOfficerIds];
        const unique = [...new Set(selected.map(String))];
        if (!unique.length || unique.some(value => !mongoose.isValidObjectId(value))) throw fail('送信先の役員を選択してください。');
        const officerIds = new Set(officers.map(item => String(item.user)));
        if (unique.some(value => !officerIds.has(value))) throw fail('現年度の役員から送信先を選択してください。');
        targetOfficers = unique;
        recipientIds = unique;
      } else if (audience === 'department') {
        if (!mongoose.isValidObjectId(targetId)) throw fail('送信先を選択してください。');
        const department = await Department.findOne({ _id: targetId, association: associationId }).select('_id').lean();
        if (!department) throw fail('部を確認できません。', 404);
        targetDepartment = department._id;
        recipientIds = officers.filter(item => String(item.department) === String(targetId)).map(item => item.user);
      } else {
        if (!mongoose.isValidObjectId(targetId)) throw fail('送信先を選択してください。');
        const group = await OfficerContactGroup.findOne({ _id: targetId, association: associationId }).select('members').lean();
        if (!group) throw fail('役員グループを確認できません。', 404);
        targetGroup = group._id;
        const memberIds = new Set(group.members.map(String));
        recipientIds = officers.filter(item => memberIds.has(String(item.user))).map(item => item.user);
      }
    }
  } else if (audience === 'leaders') {
    const assignments = await AnnualLeaderAssignment.find({ association: associationId, fiscalYear: fiscalYear(now), cancelledAt: null }).select('representative').lean();
    recipientIds = assignments.map(item => item.representative);
  } else {
    const memberships = await AssociationMembership.find({ association: associationId, status: 'active' }).select('user').lean();
    recipientIds = memberships.map(item => item.user);
  }
  const active = await AssociationMembership.find({ association: associationId, status: 'active', user: { $in: recipientIds } }).select('user').lean();
  const recipients = [...new Map(active.map(item => [String(item.user), item.user])).values()];
  if (audience === 'officer_individual' && recipients.length !== targetOfficers.length) throw fail('現在参加中の役員から送信先を選択してください。');
  if (audience === 'district_individual' && recipients.length !== targetOfficers.length) throw fail('現在参加中の班員から送信先を選択してください。');
  if (!recipients.length) throw fail('送信できる対象者がいません。');
  const announcement = await OfficerAnnouncement.create({ association: associationId, sender: userId, channel, audience, districtGroup: districtMembership?.districtGroup, associationGroup: associationGroupId, targetDepartment, targetOfficer, targetOfficers, targetGroup, urgency: level,
    title: requiredText(title, 120, 'タイトル'), body: requiredText(body, 5000, '内容'), responseMode, options: choices });
  try {
    await OfficerAnnouncementReceipt.insertMany(recipients.map(recipient => ({ announcement: announcement._id, association: associationId, recipient })));
  } catch (error) {
    await OfficerAnnouncementReceipt.deleteMany({ announcement: announcement._id });
    await OfficerAnnouncement.deleteOne({ _id: announcement._id });
    throw error;
  }
  try {
    await Notification.insertMany(recipients.map(recipient => ({ association: associationId, recipient, type: channel === 'district' ? 'district_message' : channel === 'officer' ? 'officer_network' : 'officer_announcement',
      title: `${channel === 'district' ? '班内の連絡' : channel === 'officer' ? '役員間の連絡' : '町内会役員から住人への連絡'}：${announcement.title}`, body: `緊急度 ${'★'.repeat(level)}${level === 5 ? ' 緊急' : ''} の連絡が届きました。`, relatedType: 'OfficerAnnouncement', relatedId: announcement._id })));
  } catch (error) { console.error('Officer announcement notification failed', error); }
  return { announcement, recipientCount: recipients.length };
};

export const loadRecipientAnnouncement = async ({ associationId, announcementId, userId, channel }) => {
  if (!mongoose.isValidObjectId(announcementId)) throw fail('連絡を確認できません。', 404);
  await loadQuestionBoxAccess({ associationId, userId });
  const receipt = await OfficerAnnouncementReceipt.findOne({ announcement: announcementId, association: associationId, recipient: userId }).lean();
  if (!receipt) throw fail('この連絡の送信対象ではありません。', 403);
  const announcement = await OfficerAnnouncement.findOne({ _id: announcementId, association: associationId }).lean();
  if (!announcement) throw fail('連絡を確認できません。', 404);
  if (channel && (announcement.channel || 'resident') !== channel) throw fail('連絡を確認できません。', 404);
  return { announcement, receipt };
};

export const confirmAnnouncement = async ({ associationId, announcementId, userId, selectedOptions, channel }) => {
  const { announcement, receipt } = await loadRecipientAnnouncement({ associationId, announcementId, userId, channel });
  const values = selectedOptions === undefined ? [] : Array.isArray(selectedOptions) ? selectedOptions : [selectedOptions];
  const indices = values.map(Number);
  if (announcement.responseMode === 'none' && indices.length) throw fail('この連絡には回答欄がありません。');
  if (announcement.responseMode !== 'none' && (!indices.length || (announcement.responseMode === 'single' && indices.length !== 1) || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= announcement.options.length))) throw fail('選択肢から回答を選んでください。');
  const now = new Date();
  await OfficerAnnouncementReceipt.updateOne({ _id: receipt._id, recipient: userId }, { $set: {
    readAt: receipt.readAt || now,
    ...(announcement.responseMode === 'none' ? {} : { selectedOptions: indices, respondedAt: now })
  } });
  await Notification.updateMany({ recipient: userId, relatedType: 'OfficerAnnouncement', relatedId: announcementId, readAt: null }, { $set: { readAt: now } });
  return announcement;
};

export const remindAnnouncement = async ({ associationId, announcementId, userId, recipientId, channel }) => {
  if (channel === 'district') await requireDistrictMember(associationId, userId);
  else await requireAnnouncementOfficer(associationId, userId);
  if (!mongoose.isValidObjectId(announcementId) || (recipientId && !mongoose.isValidObjectId(recipientId))) throw fail('連絡先を確認できません。', 404);
  const announcement = await OfficerAnnouncement.findOne({ _id: announcementId, association: associationId }).lean();
  if (!announcement) throw fail('連絡を確認できません。', 404);
  if (channel && (announcement.channel || 'resident') !== channel) throw fail('連絡を確認できません。', 404);
  if (channel === 'district') {
    const membership = await requireDistrictMember(associationId, userId);
    if (String(announcement.sender) !== String(userId) || String(announcement.districtGroup) !== String(membership.districtGroup)) throw fail('送信者のみ再通知できます。', 403);
  }
  const query = { announcement: announcementId, association: associationId, readAt: null, ...(recipientId ? { recipient: recipientId } : {}) };
  const unread = await OfficerAnnouncementReceipt.find(query).select('_id recipient').lean();
  if (!unread.length) throw fail('未確認の送信先がありません。', 409);
  const recipients = [];
  for (const receipt of unread) {
    const claimed = await OfficerAnnouncementReceipt.findOneAndUpdate({ _id: receipt._id, readAt: null }, { $set: { lastRemindedAt: new Date() } }, { new: true });
    if (claimed) recipients.push(receipt.recipient);
  }
  if (!recipients.length) throw fail('未確認の送信先がありません。', 409);
  await Notification.insertMany(recipients.map(recipient => ({ association: associationId, recipient, type: announcement.channel === 'district' ? 'district_message_reminder' : announcement.channel === 'officer' ? 'officer_network_reminder' : 'officer_announcement_reminder',
    title: `未確認の連絡：${announcement.title}`, body: `${announcement.channel === 'district' ? '班内の連絡' : announcement.channel === 'officer' ? '役員間の連絡' : '町内会役員から住人への連絡'}を確認してください。`, relatedType: 'OfficerAnnouncement', relatedId: announcementId })));
  return recipients.length;
};

export const summarizeAnnouncementResponses = (announcement, receipts) => {
  const choices = announcement.options.map((label, index) => ({ label, index, respondents: [] }));
  const unanswered = [];
  for (const receipt of receipts) {
    const name = receipt.recipient?.displayname || receipt.recipient?.username || '退会済みの住人';
    if (!receipt.respondedAt) {
      unanswered.push(name);
      continue;
    }
    for (const index of new Set(receipt.selectedOptions || [])) {
      if (choices[index]) choices[index].respondents.push(name);
    }
  }
  const percentage = count => receipts.length ? Math.round(count * 1000 / receipts.length) / 10 : 0;
  return { choices: choices.map(choice => ({ ...choice, percentage: percentage(choice.respondents.length) })),
    unanswered, unansweredPercentage: percentage(unanswered.length), answeredCount: receipts.length - unanswered.length, recipientCount: receipts.length };
};
