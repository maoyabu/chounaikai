import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { dangerAccess } from '../services/dangerReportService.js';
import { platformJoinBenefits } from '../services/joinBenefitsPresentation.js';

export const mobileJoinBenefitsRouter = express.Router({ mergeParams: true });

mobileJoinBenefitsRouter.use(requireLogin);
mobileJoinBenefitsRouter.get('/', async (req, res, next) => {
  try {
    const association = await dangerAccess(req.params.associationId, req.user._id);
    res.set('Cache-Control', 'private, no-store');
    return res.json({
      associationName: association.name,
      associationBenefits: (association.joinBenefits || []).map((benefit, index) => ({
        id: `association-${index}`,
        title: benefit.title,
        content: benefit.content,
        color: benefit.color || 'green',
        icon: benefit.icon || 'town'
      })),
      serviceBenefits: platformJoinBenefits.filter(benefit => benefit.section === 'service').map((benefit, index) => ({ id: `service-${index}`, ...benefit })),
      outcomes: platformJoinBenefits.filter(benefit => benefit.section === 'outcome').map((benefit, index) => ({ id: `outcome-${index}`, ...benefit }))
    });
  } catch (error) { return next(error); }
});

