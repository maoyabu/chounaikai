import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { PrivacyAccessLog } from '../models/privacyAccessLog.js';

export const privacyCategories = Object.freeze({
  registration: '登録・参加申請', residents: '住人・世帯情報', officers: '役員・班長・管理者',
  messages: '連絡・相談・回答状況', finance: '会計の個人情報', equipment: '備品の利用者情報',
  documents: 'ドキュメント・添付ファイル', audit: '監査ログ'
});
export const auditedViews = Object.freeze(Object.fromEntries(Object.entries({
  registration: ['admin-dashboard', 'register', 'check-email', 'email-verified', 'household-application', 'participation-status', 'household-invitation', 'resident-onboarding', 'association-applications'],
  residents: ['profile', 'withdrawals', 'leader-dashboard', 'leader-fees', 'leader-household-delete', 'association-members', 'association-group-manage', 'association-groups-manage', 'association-group-request'],
  officers: ['association-managers', 'association-annual-settings', 'association-officers', 'association-leaders', 'association-public-officers', 'association-group-public', 'officer-network-new', 'officer-network-groups', 'association-basic-settings'],
  messages: ['dashboard', 'association-detail', 'association-public-events', 'association-group-messages', 'association-group-messages-inbox', 'district-messages', 'district-messages-new', 'district-officer-announcements', 'officer-announcements', 'officer-announcement-new', 'officer-announcement-detail', 'resident-announcements', 'resident-announcement-detail', 'officer-network', 'question-box', 'question-box-officer', 'question-detail', 'officer-department-plans', 'system-contacts', 'system-contact'],
  finance: ['association-finance-dashboard', 'association-finance-public', 'association-finance-annual', 'association-finance-entries', 'association-finance-public-entries', 'association-finance-entry', 'association-finance-settings'],
  equipment: ['equipment-loans', 'equipment-purchases', 'equipment-inventory'],
  documents: ['documents-list', 'documents-view', 'documents-delete'],
  audit: ['privacy-audit', 'site-security']
}).flatMap(([category, views]) => views.map(view => [view, category]))));

const objectId = value => /^[a-f\d]{24}$/i.test(String(value?._id ?? value ?? '')) ? String(value?._id ?? value) : null;
const id = value => {
  const result = value?._id ?? value;
  return (typeof result === 'string' || result instanceof mongoose.Types.ObjectId) && /^[\w-]{1,160}$/.test(String(result)) ? String(result) : null;
};
// Only explicitly named ID relationships are collected. Text, addresses,
// emails, message bodies, secrets and arbitrary object properties aren't logged.
const relations = {
  user: 'user', applicant: 'user', requestedBy: 'user', representative: 'user', feeRepresentative: 'user',
  sender: 'user', recipient: 'user', author: 'user', invitedBy: 'user', actor: 'user', createdBy: 'user',
  household: 'household', householdId: 'household', member: 'householdMember',
  announcement: 'announcement', thread: 'thread', registration: 'registration', application: 'application',
  membership: 'membership', group: 'group', item: 'item', entry: 'finance',
  pendingRegistrations: 'registration', inactiveRegistrants: 'user', ownHouseholdMembers: 'householdMember',
  households: 'household', affiliatedHouseholds: 'household', applications: 'application', pendingJoins: 'application',
  officers: 'officer', leaders: 'leader', receipts: 'receipt', announcements: 'announcement', threads: 'thread',
  ownThreads: 'thread', officerThreads: 'thread', entries: 'finance', requests: 'loan', purchases: 'purchase',
  logs: 'audit', invitation: 'invitation', association: 'association', associations: 'association',
  members: 'member', memberships: 'membership', householdRepresentatives: 'household',
  officerCandidates: 'member', leaderCandidates: 'household', leaderRecords: 'leader', officerRecords: 'officer',
  withdrawalApplications: 'application', headApplications: 'application', successor: 'user', checkedBy: 'user', receivedBy: 'user', borrower: 'user', approvedBy: 'user'
};
export const collectPrivacyTargets = (data = {}) => {
  const targets = new Set(), visited = new WeakSet();
  const add = (kind, value) => { const key = id(value); if (key) targets.add(`${kind}:${key}`); };
  const walk = (value, relation, depth = 0) => {
    if (!value || depth > 20) return;
    if (Array.isArray(value)) { for (const child of value) walk(child, relation, depth + 1); return; }
    if (relation) add(relation, value);
    if (typeof value !== 'object' || value instanceof Date || value instanceof mongoose.Types.ObjectId || visited.has(value)) return;
    visited.add(value);
    const plain = typeof value.toObject === 'function' ? value.toObject() : value;
    for (const [key, child] of Object.entries(plain)) {
      // Don't traverse populated audit actor/target data or workbook contents.
      if (['hash', 'salt', 'body', 'content', 'secret', 'sheets', 'logs', 'filters'].includes(key)) {
        if (key === 'logs' && Array.isArray(child)) for (const log of child) add('audit', log);
        continue;
      }
      if (key === 'membersByHousehold' && child && typeof child === 'object') {
        for (const [household, members] of Object.entries(child)) { add('household', household); walk(members, 'householdMember', depth + 1); }
        continue;
      }
      walk(child, relations[key], depth + 1);
    }
  };
  walk(data);
  const all = [...targets];
  return { targets: all.slice(0, 5000), targetCount: all.length, targetsTruncated: all.length > 5000 };
};

export const writePrivacyAccess = event => PrivacyAccessLog.create(event);
export const buildPrivacyEvent = (req, { category, resource, action = 'view', data = {}, targets = [] }) => {
  // Association filter choices are UI controls, not the audit records viewed.
  if (resource === 'privacy-audit') data = { logs: data.logs || [], associations: (data.logs || []).flatMap(log => log.associations || []) };
  const collected = collectPrivacyTargets(data);
  const explicit = targets.filter(value => typeof value === 'string' && /^[\w:-]{1,180}$/.test(value));
  if (resource === 'profile' && id(req.user)) explicit.push(`user:${id(req.user)}`);
  const parameterTypes = { fileId: 'file', householdId: 'household', memberId: 'householdMember', userId: 'user', applicationId: 'application', groupId: 'group', threadId: 'thread', contactId: 'thread', announcementId: 'announcement', entryId: 'finance', equipmentId: 'equipment' };
  for (const [parameter, kind] of Object.entries(parameterTypes)) if (id(req.params?.[parameter])) explicit.push(`${kind}:${id(req.params[parameter])}`);
  const combined = [...new Set([...explicit, ...collected.targets])];
  const association = objectId(data.association ?? data.group?.association ?? data.thread?.association ?? req.params?.associationId);
  const associations = [...new Set([association, ...combined.filter(value => value.startsWith('association:')).map(value => objectId(value.slice(12)))].filter(Boolean))];
  // Route patterns never contain query strings, invitation tokens or file names.
  const route = `${req.baseUrl || ''}${typeof req.route?.path === 'string' ? req.route.path : '/unknown'}`;
  return {
    requestId: req.privacyRequestId || crypto.randomUUID(), actor: objectId(req.user),
    actorName: [...new Set([req.user?.displayname, req.user?.username].filter(Boolean))].join(' / ').slice(0, 160),
    actorKind: req.user?.isAdmin ? 'system_admin' : req.user ? 'user' : 'anonymous', association, associations,
    category, resource, action, route: route.slice(0, 500), method: req.method,
    ip: String(req.ip || '').slice(0, 64), targets: combined.slice(0, 5000),
    targetCount: collected.targetCount + combined.length - collected.targets.length,
    targetsTruncated: collected.targetsTruncated || combined.length > 5000
  };
};
