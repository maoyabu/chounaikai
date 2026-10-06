import test from 'node:test';
import assert from 'node:assert/strict';
import { discloseOfficers, viewerDisclosureAccess, currentFiscalYear } from '../src/services/officerDisclosureService.js';
import { DisclosureConsent } from '../src/models/disclosureConsent.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
const chain = value => ({ select: () => chain(value), populate: () => chain(value), lean: async () => value });
const association = { _id: 'association-a', officerDisclosurePolicy: { name: 'residents' } };
const officer = { fiscalYear: currentFiscalYear(), user: { _id: 'user-a', displayname: '非公開氏名' } };
test('consent and active membership queries are scoped to the target association', async t => {
  t.mock.method(DisclosureConsent, 'find', filter => {
    assert.equal(filter.association, association._id);
    return chain([{ user: 'user-a', confirmedAt: new Date(), fiscalYear: currentFiscalYear(), scopes: { name: 'residents' } }]);
  });
  t.mock.method(AssociationMembership, 'find', filter => { assert.equal(filter.association, association._id); assert.equal(filter.status, 'active'); return chain([]); });
  assert.equal((await discloseOfficers(association, [officer], { audience: 'residents' }))[0].name, '');
});
test('an unrelated visitor remains public even when registered as an officer', async t => {
  t.mock.method(AssociationMembership, 'exists', async () => false);
  t.mock.method(AnnualOfficer, 'exists', async () => true);
  t.mock.method(RoleAssignment, 'find', () => chain([]));
  const result = await viewerDisclosureAccess(association, { _id: 'visitor' });
  assert.equal(result.audience, 'open'); assert.equal(result.viewerId, undefined);
});
test('active association manager retains full management access', async t => {
  t.mock.method(AssociationMembership, 'exists', async () => false);
  t.mock.method(AnnualOfficer, 'exists', async () => false);
  t.mock.method(RoleAssignment, 'find', filter => {
    assert.equal(filter.association, association._id); assert.ok(filter.startsAt.$lte);
    return chain([{ role: { permissions: ['association.manage'] } }]);
  });
  assert.equal((await viewerDisclosureAccess(association, { _id: 'manager' })).manager, true);
});
