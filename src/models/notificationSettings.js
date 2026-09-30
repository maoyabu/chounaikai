import mongoose from 'mongoose';

export const notificationCategories = [
  ['officer_announcement', '役員から住民への連絡'], ['officer_network', '役員間の連絡'],
  ['district_message', '地区・班の連絡'], ['group_message', 'グループ内の連絡'],
  ['join', '町内会への参加申請・承認結果'], ['household', '世帯への確認依頼・所属変更'],
  ['withdrawal', '退会申請・承認結果'], ['question', '質問・再質問・回答'],
  ['assignment', '班長・役員の任命'], ['group_request', 'グループ作成・参加申請と承認結果'],
  ['event', '町内会行事の登録・変更・削除'], ['group_event', 'グループ行事の登録・変更・削除'],
  ['department_plan', '部会の目標・実施報告']
];
export const notificationCategory = type => {
  if (type.startsWith('join_application')) return 'join';
  if (type.startsWith('household_')) return 'household';
  if (type.startsWith('withdrawal_')) return 'withdrawal';
  if (type.startsWith('question_')) return 'question';
  if (['district_leader_assigned', 'officer_assigned'].includes(type)) return 'assignment';
  return type.replace(/_reminder$/, '');
};
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  channels: { type: Map, of: new mongoose.Schema({ push: Boolean, email: Boolean }, { _id: false }) }
}, { timestamps: true });
export const NotificationSettings = mongoose.model('NotificationSettings', schema);
