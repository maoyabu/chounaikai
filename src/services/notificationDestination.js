// Shared by the home inbox and authenticated links from email/push.
export const notificationAction = (notification, context = {}) => {
  const association = String(notification.association?._id || notification.association || '');
  const id = notification.relatedId;
  const base = `/associations/${association}`;
  const manager = (context.currentManagerAssociations || []).some(item => String(item._id) === association);
  const leader = (context.currentLeaderAssociations || []).some(item => String(item._id) === association);
  const action = (path, label = '内容を確認') => ({ actionUrl: path, actionLabel: label });
  if (!association) return action('/dashboard?notifications=open');
  switch (notification.type) {
    case 'alert_level': return action(`${base}/safety`, '世帯の安否情報を登録');
    case 'danger_report': return action(id ? `${base}/dangers/${id}` : `${base}/dangers`);
    case 'good_place': return action(id ? `${base}/good-places/${id}` : `${base}/good-places`);
    case 'question_created': case 'question_reopened': return action(`${base}/questions/officer`, '質問を確認');
    case 'question_answered': return action(id ? `${base}/questions?open=own-${id}` : `${base}/questions`, '回答を確認');
    case 'join_application_received': return action(manager ? `${base}/manage/applications` : leader ? `${base}/leader?tab=applications#application-${id}` : `${base}/participation`, '参加申請を確認');
    case 'join_application_approved': case 'join_application_rejected': return action(`${base}/participation`);
    case 'household_link_requested': case 'household_removed': return action('/profile?tab=household');
    case 'withdrawal_leader_requested': return action(`${base}/leader?tab=withdrawals#withdrawal-${id}`, '退会申請を確認');
    case 'withdrawal_head_requested': case 'withdrawal_approved': case 'withdrawal_rejected': return action('/profile/withdrawals', '退会申請を確認');
    case 'officer_announcement': case 'officer_announcement_reminder': return action(id ? `${base}/announcements/${id}` : `${base}/announcements`);
    case 'officer_network': case 'officer_network_reminder': return action(id ? `${base}/officer-network/inbox/${id}` : `${base}/officer-network/inbox`);
    case 'district_message': case 'district_message_reminder': return action(id ? `${base}/district-messages/inbox/${id}` : `${base}/district-messages/inbox`);
    case 'group_message': case 'group_message_reminder': return action(context.messageGroup ? `${base}/groups/${context.messageGroup}/messages/inbox/${id}` : '/dashboard?notifications=open');
    case 'group_request': {
      // Legacy records share one type for requests and results; only requests go to approval screens.
      const requested = /申請が届きました/.test(notification.title || '');
      return action(id ? `${base}/groups/${id}${requested ? '/manage' : ''}` : requested ? `${base}/manage/groups` : base, requested ? '申請を確認' : 'グループを確認');
    }
    case 'system_contact': return action(id ? context.isAdmin ? `/admin/system-contacts/${id}` : `${base}/manage/system-contacts/${id}` : base);
    case 'equipment_inventory': return action(`${base}/equipment/inventory`);
    case 'equipment_expiry': return action(`${base}/equipment/purchase-list`);
    case 'equipment_loan': return action(id ? `${base}/equipment/${id}/loans#equipment-loan-requests` : `${base}/equipment`);
    case 'department_plan': return action(`${base}/department-plans`);
    case 'district_leader_assigned': return action(`${base}/leader`);
    case 'officer_assigned': return action(`${base}/officer`);
    case 'event': case 'group_event': return action(context.eventGroup ? `${base}/groups/${context.eventGroup}` : base);
    default: return action(base, '町内会のページを確認');
  }
};
