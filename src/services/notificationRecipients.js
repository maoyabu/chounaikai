import { RoleDefinition, RoleAssignment } from '../models/role.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { Notification } from '../models/notification.js';
import { AssociationGroupMembership } from '../models/associationGroup.js';

export const notifyResponsible = async ({ association, districtGroup, officers = false, exclude = [], type, title, relatedId }) => {
  try {
    const now = new Date(), fiscalYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    const roles = await RoleDefinition.find({ association, active: true, permissions: 'association.manage' }).distinct('_id');
    const managers = await RoleAssignment.find({ association, role: { $in: roles }, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }).distinct('user');
    const others = officers ? await AnnualOfficer.find({ association, fiscalYear, cancelledAt: null }).distinct('user') : districtGroup ? await AnnualLeaderAssignment.find({ association, districtGroup, fiscalYear, cancelledAt: null }).distinct('representative') : [];
    const recipients = await AssociationMembership.find({ association, status: 'active', user: { $in: [...managers, ...others].filter(Boolean) } }).distinct('user');
    const excluded = new Set(exclude.filter(Boolean).map(String));
    await queueNotice({ association, recipients: recipients.filter(id => !excluded.has(String(id))), type, title, relatedId });
  } catch (error) { console.error('Responsible notification failed:', error.name); }
};

export const queueNotice = async ({ association, recipients, type, title, relatedId }) => {
  try {
    const ids = [...new Set(recipients.filter(Boolean).map(String))];
    if (ids.length) await Notification.insertMany(ids.map(recipient => ({ association, recipient, type, title, body: '町内会のページで内容を確認してください。', relatedId })));
  } catch (error) { console.error('Notification queue failed:', error.name); }
};

export const notifyEvent = async (event, action) => {
  if (!event?.visible) return;
  try {
    const groupUsers = event.group ? await AssociationGroupMembership.find({ association: event.association, group: event.group, status: 'active' }).distinct('user') : null;
    const recipients = await AssociationMembership.find({ association: event.association, status: 'active', ...(groupUsers ? { user: { $in: groupUsers } } : {}) }).distinct('user');
    await queueNotice({ association: event.association, recipients, type: event.group ? 'group_event' : 'event', title: `行事が${action}されました`, relatedId: event._id });
  } catch (error) { console.error('Event notification failed:', error.name); }
};

export const notifyDepartmentPlan = async plan => {
  try {
    const users = await AnnualOfficer.find({ association: plan.association, department: plan.department, fiscalYear: plan.fiscalYear, cancelledAt: null }).distinct('user');
    const recipients = await AssociationMembership.find({ association: plan.association, status: 'active', user: { $in: users.filter(Boolean) } }).distinct('user');
    await queueNotice({ association: plan.association, recipients, type: 'department_plan', title: `${plan.fiscalYear}年度の部会の事業計画が更新されました`, relatedId: plan._id });
  } catch (error) { console.error('Department notification failed:', error.name); }
};
