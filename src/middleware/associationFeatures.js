import mongoose from 'mongoose';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { associationFeatureEnabled, featureForAssociationPath } from '../services/associationFeatureService.js';

// Check before uploads and route handlers, including direct links to old records.
export const requireEnabledAssociationFeature = async (req, res, next) => {
  const target = featureForAssociationPath(req.path);
  if (!target) return next();
  try {
    if (!mongoose.isValidObjectId(target.associationId)) return res.sendStatus(404);
    const association = await NeighborhoodAssociation.findOne({ _id: target.associationId, status: 'active', deletedAt: { $exists: false } }).select('optionalFeatures').lean();
    if (!associationFeatureEnabled(association, target.feature)) {
      return res.status(404).render('error', { title: '利用できない機能', message: 'この町内会では現在この機能を利用していません。' });
    }
    return next();
  } catch (error) { return next(error); }
};
