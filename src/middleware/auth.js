import { AssociationMembership } from '../models/associationMembership.js';
import { RoleAssignment } from '../models/role.js';
import mongoose from 'mongoose';

export const requireLogin = (req, res, next) => {
  if (req.isAuthenticated?.()) return next();
  if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login');
  return res.status(401).json({ error: 'authentication_required' });
};

export const requireSystemAdmin = (req, res, next) => {
  if (req.isAuthenticated?.() && req.user?.isAdmin) return next();
  if (!req.isAuthenticated?.()) {
    if (!req.originalUrl.startsWith('/api/')) return res.redirect('/login');
    return res.status(401).json({ error: 'authentication_required' });
  }
  if (!req.originalUrl.startsWith('/api/')) {
    return res.status(403).render('error', { title: '権限がありません', message: 'この操作にはシステム管理者の権限が必要です。' });
  }
  return res.status(403).json({ error: 'system_admin_required' });
};

export const loadActiveMembership = async (req, res, next) => {
  try {
    const membership = await AssociationMembership.findOne({
      association: req.params.associationId,
      user: req.user._id,
      status: 'active'
    });
    if (!membership) return res.status(403).json({ error: 'active_membership_required' });
    req.associationMembership = membership;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requirePermission = (permission) => async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) {
      return res.status(400).json({ error: 'invalid_association_id' });
    }
    if (req.user?.isAdmin) return next();
    const now = new Date();
    const assignment = await RoleAssignment.findOne({
      association: req.params.associationId,
      user: req.user._id,
      startsAt: { $lte: now },
      $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }]
    }).populate({ path: 'role', match: { active: true, permissions: permission } });
    if (!assignment?.role) {
      if (!req.originalUrl.startsWith('/api/')) return res.status(403).render('error', { title: '権限がありません', message: 'この町内会を管理する権限がありません。' });
      return res.status(403).json({ error: 'permission_denied', permission });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};
