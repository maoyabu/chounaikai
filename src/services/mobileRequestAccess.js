// The inbox query already scopes notifications to their recipient. Group-only
// managers may see requests for groups they currently manage, not other duties.
export const canViewMobileRequest = (notification, profiles) => {
  const associationId = String(notification.association?._id || notification.association || '');
  const profile = profiles.find(item => String(item.association.id) === associationId);
  if (!profile) return false;
  if (profile.roles.some(role => ['management', 'officer', 'district_leader'].includes(role.kind))) return true;
  return notification.type === 'group_request'
    && /(?:参加|退会)申請が届きました/.test(notification.title || '')
    && Boolean(notification.relatedId)
    && profile.roles.some(role => role.kind === 'group_manager' && String(role.groupId) === String(notification.relatedId));
};
