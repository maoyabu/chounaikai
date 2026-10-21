import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { AssociationGroup } from '../src/models/associationGroup.js';
import { associationGroupsRouter } from '../src/routes/associationGroups.js';
import { calendarWindow } from '../src/services/associationEventService.js';

const associationId = '507f1f77bcf86cd799439011';
const groupId = '507f1f77bcf86cd799439012';
const route = path => associationGroupsRouter.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;

for (const [action, status] of [['suspend', 'suspended'], ['resume', 'active'], ['delete', 'deleted']]) {
  test(`admin ${action} is scoped to the association and excludes deleted groups`, async t => {
    t.mock.method(AssociationGroup, 'findOneAndUpdate', async (filter, update) => {
      assert.deepEqual(filter, { _id: groupId, association: associationId, status: { $in: ['active', 'suspended'] } });
      assert.deepEqual(update, { $set: { status } });
      return { _id: groupId };
    });
    const handler = route(`/:associationId/manage/groups/:groupId/${action}`);
    const req = { params: { associationId, groupId }, session: {} };
    let redirected;
    await handler(req, { redirect: path => { redirected = path; } }, error => { throw error; });
    assert.equal(redirected, `/associations/${associationId}/manage/groups`);
    assert.ok(req.session.notice);
    AssociationGroup.findOneAndUpdate.mock.mockImplementation(async () => null);
    let failure;
    await handler(req, {}, error => { failure = error; });
    assert.equal(failure.status, 404);
  });
}

test('suspended PR renders the status over the banner and hides the join button', async () => {
  const values = {
    assetVersion: 'test', currentPath: '/', showNotificationPrompt: false, title: 'グループ', currentUser: { _id: 'resident' }, csrfToken: 'token',
    association: { _id: associationId, name: '町内会' },
    group: { _id: groupId, association: associationId, name: 'グループ', publicPhotos: [{ url: '/banner.jpg' }], status: 'suspended' },
    members: [], events: [], isResident: true, isManager: false,
    ...calendarWindow(), calendarWindow: calendarWindow()
  };
  const html = await ejs.renderFile('src/views/association-group-public.ejs', values);
  assert.match(html, /class="group-suspended-banner" role="status">活動停止中/);
  assert.match(html, /src="\/banner.jpg"/);
  assert.doesNotMatch(html, /グループに参加する/);
  values.group.status = 'active';
  const active = await ejs.renderFile('src/views/association-group-public.ejs', values);
  assert.doesNotMatch(active, /活動停止中/);
  assert.match(active, /グループに参加する/);
});

test('deleted PR is unavailable while suspended PR remains eligible for lookup', async t => {
  t.mock.method(AssociationGroup, 'findOne', filter => {
    assert.deepEqual(filter.status, { $in: ['active', 'suspended'] });
    return { lean: async () => null };
  });
  // The group is checked before rendering; also stub the association query.
  const { NeighborhoodAssociation } = await import('../src/models/neighborhoodAssociation.js');
  t.mock.method(NeighborhoodAssociation, 'findById', () => ({ select: () => ({ lean: async () => ({ name: '町内会' }) }) }));
  let failure;
  await route('/:associationId/groups/:groupId')({ params: { associationId, groupId } }, {}, error => { failure = error; });
  assert.equal(failure.status, 404);
});

test('association PR includes suspended groups and filters deleted groups in its query', async t => {
  const { loadAssociationPageData } = await import('../src/services/associationPublicPageService.js');
  const { GoodPlace } = await import('../src/models/goodPlace.js');
  const { AssociationEvent } = await import('../src/models/associationEvent.js');
  const { Household, DistrictGroup } = await import('../src/models/organization.js');
  const { AnnualOfficer } = await import('../src/models/annualOfficer.js');
  const { DisclosureConsent } = await import('../src/models/disclosureConsent.js');
  const { AssociationMembership } = await import('../src/models/associationMembership.js');
  const { AnnualDepartmentPlan } = await import('../src/models/annualDepartmentPlan.js');
  const query = value => ({ limit() { return this; }, sort() { return this; }, select() { return this; }, populate() { return this; }, lean: async () => value });
  for (const Model of [GoodPlace, AssociationEvent, Household, DistrictGroup, AnnualOfficer, AnnualDepartmentPlan, DisclosureConsent, AssociationMembership]) t.mock.method(Model, 'find', () => query([]));
  const suspended = { _id: groupId, status: 'suspended', publicVisibility: 'open', name: '休止中グループ' };
  t.mock.method(AssociationGroup, 'find', filter => {
    assert.deepEqual(filter, { association: associationId, status: { $in: ['active', 'suspended'] } });
    return query([suspended]);
  });
  const { AssociationGroupMembership } = await import('../src/models/associationGroup.js');
  t.mock.method(AssociationGroupMembership, 'aggregate', async () => []);
  const data = await loadAssociationPageData({ _id: associationId });
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].status, 'suspended');
});
