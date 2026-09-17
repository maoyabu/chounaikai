import express from 'express';
import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { requireLogin, requireSystemAdmin } from '../middleware/auth.js';
import { approveAssociation, hideAssociation, permanentlyDeleteAssociation, restoreAssociation } from '../services/associationService.js';

export const associationsRouter = express.Router();

associationsRouter.use(requireLogin);

associationsRouter.get('/', async (req, res, next) => {
  try {
    const memberships = await AssociationMembership.find({ user: req.user._id, status: 'active' }).select('association');
    const associations = await NeighborhoodAssociation.find({ _id: { $in: memberships.map((item) => item.association) }, deletedAt: { $exists: false } }).lean();
    res.json({ associations });
  } catch (error) {
    next(error);
  }
});

associationsRouter.post('/:associationId/approve', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    const result = await approveAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.json({ association: result.association });
  } catch (error) { return next(error); }
});

associationsRouter.delete('/:associationId', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    if (req.query.mode === 'permanent') await permanentlyDeleteAssociation({ association });
    else await hideAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

associationsRouter.post('/:associationId/restore', requireSystemAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId);
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    await restoreAssociation({ association, actor: req.user, requestMeta: { requestId: req.get('x-request-id'), ip: req.ip } });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

associationsRouter.get('/:associationId', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.associationId)) return res.status(400).json({ error: 'invalid_association_id' });
    const association = await NeighborhoodAssociation.findById(req.params.associationId).lean();
    if (!association) return res.status(404).json({ error: 'association_not_found' });
    const membership = await AssociationMembership.findOne({ association: req.params.associationId, user: req.user._id, status: 'active' });
    const isApplicant = String(association.requestedBy) === String(req.user._id);
    if ((!membership && !req.user.isAdmin && !isApplicant) || (association.deletedAt && !req.user.isAdmin)) return res.status(404).json({ error: 'association_not_found' });
    return res.json({ association, membership });
  } catch (error) {
    return next(error);
  }
});
