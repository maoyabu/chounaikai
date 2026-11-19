import { AnnualLeaderAssignment } from '../models/annualLeaderAssignment.js';
import { discloseOfficers } from './officerDisclosureService.js';
import { residentDisplayEnabled } from './associationFeatureService.js';

export const loadResidentLeaders = async (association, fiscalYear, viewer) => {
  if (!residentDisplayEnabled(association, 'leaders')) return [];
  const records = await AnnualLeaderAssignment.find({ association: association._id, fiscalYear, cancelledAt: null })
    .populate('representative', 'displayname email avatar').populate('districtGroup', 'name').sort({ createdAt: 1 }).lean();
  const disclosed = await discloseOfficers(association, records.map(record => ({
    ...record, user: record.representative, role: { name: '班長' }
  })), viewer);
  // Use only disclosure-filtered names/photos; never expose contact fields.
  return disclosed.map((record, index) => ({ id: String(record._id), districtGroupId: String(records[index].districtGroup?._id || ''), district: records[index].districtGroup?.name || '地区・班未設定',
    displayLabel: record.displayLabel, avatar: record.user?.avatar || '' }));
};
