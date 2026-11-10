const id = value => String(value?._id ?? value ?? '');

export const communicationCategory = announcement => Number(announcement.urgency) === 5 ? 'emergency' : 'announcement';

const senderName = sender => sender?.displayname || sender?.username || '町内会役員';

const audienceLabel = announcement => {
  if (announcement.audience === 'all') return '全住人対象';
  if (['district_all', 'district_individual'].includes(announcement.audience)) return '地区・班対象';
  return '対象者限定';
};

export const mobileCommunication = ({ announcement, receipt }) => ({
  id: id(announcement),
  associationId: id(announcement.association),
  category: communicationCategory(announcement),
  title: announcement.title,
  body: announcement.body,
  urgency: announcement.urgency,
  audience: audienceLabel(announcement),
  sender: senderName(announcement.sender),
  responseMode: announcement.responseMode,
  options: announcement.options || [],
  attachments: (announcement.attachments || []).map(file => ({
    name: file.originalName,
    url: file.url,
    mimeType: file.mimeType
  })),
  createdAt: announcement.createdAt,
  editedAt: announcement.editedAt || null,
  readAt: receipt.readAt || null,
  selectedOptions: receipt.selectedOptions || [],
  respondedAt: receipt.respondedAt || null
});
