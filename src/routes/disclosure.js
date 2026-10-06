import express from 'express';
import mongoose from 'mongoose';
import { requireLogin, requirePermission } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import { AnnualOfficer } from '../models/annualOfficer.js';
import { AssociationMembership } from '../models/associationMembership.js';
import { DisclosureConsent } from '../models/disclosureConsent.js';
import { disclosureFields, disclosureLevels, policyValues, parseDisclosure, effectiveDisclosure } from '../services/disclosurePolicy.js';
import { currentFiscalYear } from '../services/officerDisclosureService.js';
export const disclosureRouter = express.Router();
disclosureRouter.use(['/profile/disclosure', '/associations/:associationId/manage/disclosure'], requireLogin, provideCsrfToken);
const activeAssociation = async id => {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error('町内会を確認できません。'), { status: 404 });
  const association = await NeighborhoodAssociation.findOne({ _id: id, status: 'active', deletedAt: { $exists: false } }).lean();
  if (!association) throw Object.assign(new Error('町内会を確認できません。'), { status: 404 });
  return association;
};
const ownAccess = async (association, user) => {
  const [member, officer] = await Promise.all([
    AssociationMembership.exists({ association: association._id, user: user._id, status: 'active' }),
    AnnualOfficer.exists({ association: association._id, user: user._id, fiscalYear: currentFiscalYear(), cancelledAt: null })
  ]);
  if (!member || !officer) throw Object.assign(new Error('現年度の役員だけが公開設定を変更できます。'), { status: 403 });
};
disclosureRouter.get('/profile/disclosure', async (req, res, next) => {
  try {
    const officers = await AnnualOfficer.find({ user: req.user._id, fiscalYear: currentFiscalYear(), cancelledAt: null }).select('association').lean();
    const associations = await NeighborhoodAssociation.find({ _id: { $in: officers.map(item => item.association) }, status: 'active', deletedAt: { $exists: false } }).lean();
    const memberships = await AssociationMembership.find({ user: req.user._id, status: 'active' }).select('association').lean();
    const active = new Set(memberships.map(item => String(item.association)));
    const consents = await DisclosureConsent.find({ user: req.user._id }).lean();
    const rows = associations.filter(item => active.has(String(item._id))).map(association => {
      const consent = consents.find(item => String(item.association) === String(association._id));
      return { association, policy: policyValues(association.officerDisclosurePolicy), consent, effective: effectiveDisclosure(association.officerDisclosurePolicy, consent?.fiscalYear === currentFiscalYear() ? consent : null, association.officerDisclosureHistory) };
    });
    res.set('Cache-Control', 'no-store');
    res.render('profile-disclosure', { title: '個人情報の公開設定', rows, disclosureFields, disclosureLevels });
  } catch (error) { next(error); }
});
disclosureRouter.post('/profile/disclosure/:associationId', verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await activeAssociation(req.params.associationId);
    await ownAccess(association, req.user);
    if (req.body.confirmDisclosure !== 'yes') throw Object.assign(new Error('公開先を確認して同意してください。'), { status: 400 });
    if (String(req.body.policyRevision) !== String(association.officerDisclosureHistory?.length || 0)) throw Object.assign(new Error('町内会の公開ルールが変更されました。画面を再読み込みしてください。'), { status: 409 });
    const scopes = parseDisclosure(req.body, association.officerDisclosurePolicy), at = new Date();
    await DisclosureConsent.findOneAndUpdate({ association: association._id, user: req.user._id }, {
      $set: { scopes, confirmedAt: at, policyRevision: association.officerDisclosureHistory?.length || 0, fiscalYear: currentFiscalYear() }, $push: { history: { actor: req.user._id, at, scopes } }
    }, { upsert: true, runValidators: true });
    req.session.notice = '公開設定を保存しました。';
    res.redirect('/profile/disclosure');
  } catch (error) { next(error); }
});
disclosureRouter.get('/associations/:associationId/manage/disclosure', requirePermission('association.manage'), async (req, res, next) => {
  try {
    const association = await activeAssociation(req.params.associationId);
    res.render('association-disclosure', { title: '個人情報の公開ルール', association, policy: policyValues(association.officerDisclosurePolicy), disclosureFields, disclosureLevels });
  } catch (error) { next(error); }
});
disclosureRouter.post('/associations/:associationId/manage/disclosure', requirePermission('association.manage'), verifyCsrfToken, async (req, res, next) => {
  try {
    const association = await activeAssociation(req.params.associationId);
    const scopes = parseDisclosure(req.body);
    const revision = association.officerDisclosureHistory?.length || 0;
    if (String(req.body.policyRevision) !== String(revision)) throw Object.assign(new Error('公開ルールが変更されました。画面を再読み込みしてください。'), { status: 409 });
    const result = await NeighborhoodAssociation.updateOne({ _id: association._id, $expr: { $eq: [{ $size: { $ifNull: ['$officerDisclosureHistory', []] } }, revision] } }, {
      $set: { officerDisclosurePolicy: scopes }, $push: { officerDisclosureHistory: { actor: req.user._id, at: new Date(), before: policyValues(association.officerDisclosurePolicy), after: scopes } }
    }, { runValidators: true });
    if (!result.matchedCount) throw Object.assign(new Error('公開ルールが変更されました。画面を再読み込みしてください。'), { status: 409 });
    req.session.notice = '町内会の公開ルールを保存しました。本人の同意範囲を超えて公開されることはありません。';
    res.redirect(`/associations/${association._id}/manage/basic`);
  } catch (error) { next(error); }
});
