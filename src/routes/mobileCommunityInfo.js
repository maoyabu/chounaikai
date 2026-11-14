import { canViewOfficerDirectory } from '../services/officerDirectoryAccess.js';
import express from 'express';
import mongoose from 'mongoose';
import { requireLogin } from '../middleware/auth.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AnnualDepartmentPlan } from '../models/annualDepartmentPlan.js';
import { DistrictGroup, Household, HouseholdMember } from '../models/organization.js';
import { currentFiscalYear, viewerDisclosureAccess, discloseOfficers } from '../services/officerDisclosureService.js';
import { summarizeAssociationHouseholds } from '../services/associationPublicPageService.js';

export const mobileCommunityInfoRouter = express.Router();
mobileCommunityInfoRouter.use(requireLogin);
mobileCommunityInfoRouter.get('/:associationId/community-info', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(404).json({ error: 'association_not_found' });
    const [association, membership] = await Promise.all([
      NeighborhoodAssociation.findOne({ _id: req.params.associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
      AssociationMembership.exists({ association: req.params.associationId, user: req.user._id, status: 'active' })
    ]);
    if (!association || (!membership && !req.user.isAdmin)) return res.status(404).json({ error: 'association_not_found' });
    const fiscalYear = currentFiscalYear();
    const [rawOfficers, plans, districts, households] = await Promise.all([
      AnnualOfficer.find({ association: association._id, fiscalYear, cancelledAt: null }).populate('user', 'displayname email avatar')
        .populate('role', 'name').populate('department', 'name').populate('districtGroup', 'name').sort({ createdAt: 1 }).lean(),
      AnnualDepartmentPlan.find({ association: association._id, fiscalYear }).populate('department', 'name sortOrder').sort({ createdAt: 1 }).lean(),
      DistrictGroup.find({ association: association._id, active: true }).sort({ sortOrder: 1, createdAt: 1, name: 1 }).lean(),
      Household.find({ association: association._id, active: true, deletedAt: { $exists: false } }).select('_id districtGroup').lean()
    ]);
    const viewer = await viewerDisclosureAccess(association, req.user);
    const directoryAllowed = await canViewOfficerDirectory(association, req.user, viewer);
    const officers = await discloseOfficers(association, rawOfficers, viewer);
    const counts = households.length ? await HouseholdMember.aggregate([
      { $match: { association: association._id, household: { $in: households.map(row => row._id) }, endsAt: null } },
      { $group: { _id: '$household', count: { $sum: 1 } } }
    ]) : [];
    // Serialize only disclosure-filtered records, never raw populated accounts.
    const officerDTO = row => ({ id: String(row._id), name: row.name || '', displayLabel: row.displayLabel || '担当者',
      role: row.role?.name || '一般役員', department: row.department?.name || '部会未設定', district: row.districtGroup?.name || '',
      avatar: row.user?.avatar || '', address: row.address || '', phone: row.phone || '', mobilePhone: row.mobilePhone || '', email: row.email || '' });
    const planOfficerDTO = row => ({ ...officerDTO(row), name: '', department: '', district: '', address: '', phone: '', mobilePhone: '', email: '' });
    const stats = summarizeAssociationHouseholds(districts, households, counts, { includeIds: true });
    res.json({ associationName: association.name, fiscalYear, canViewOfficerDirectory: directoryAllowed,
      plans: plans.map(plan => ({ id: String(plan._id), department: plan.department?.name || '部会未設定', goal: plan.goal || '',
        officers: officers.filter(row => String(row.department?._id || row.department || '') === String(plan.department?._id || plan.department || '')).map(planOfficerDTO) })),
      officers: directoryAllowed ? officers.map(officerDTO) : [], ...stats });
  } catch (error) { next(error); }
});
