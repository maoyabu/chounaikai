import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { Household, HouseholdMember, DistrictGroup } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { User } from '../src/models/user.js';
import { JoinApplication } from '../src/models/workflow.js';
import { ResidentRegistration } from '../src/models/residentRegistration.js';
import { loadJoinFormValues } from '../src/services/joinFormValuesService.js';

const user = { _id: 'user', username: 'resident', displayname: '山田 太郎', email: 'current@example.test' };
const household = { districtGroup: 'district', active: false, representative: { _id: user._id, email: user.email }, address: { postalCode: '1000001', street: '以前の住所', building: '101号室' }, phone: '09012345678' };
const member = { user: user._id, household, nameKana: 'やまだ たろう', birthDate: new Date('1990-04-01'), gender: 'male', lineAccount: 'line-id', relationship: '世帯代表者', endsAt: new Date() };
const query = value => ({ sort() { return this; }, populate() { return this; }, collation() { return this; }, select() { return this; }, lean: async () => value });
const setup = (t, storedMember = member, application = null, registration = null) => {
  t.mock.method(HouseholdMember, 'findOne', filter => {
    assert.deepEqual(filter, { association: 'association', user: user._id });
    return query(storedMember);
  });
  t.mock.method(JoinApplication, 'findOne', filter => {
    assert.deepEqual(filter, { association: 'association', applicant: user._id });
    return query(application);
  });
  t.mock.method(ResidentRegistration, 'findOne', () => query(registration));
  t.mock.method(User, 'findOne', () => query(null));
};
const load = account => loadJoinFormValues({ associationId: 'association', user: account || user });

test('rejoining prefills retained household and member information after withdrawal', async t => {
  setup(t);
  const values = await load();
  assert.equal(values.residentMode, 'representative');
  assert.equal(values.representativeKana, member.nameKana);
  assert.equal(values.birthDate, '1990-04-01');
  assert.equal(values.gender, 'male');
  assert.equal(values.postalCode, household.address.postalCode);
  assert.equal(values.street, household.address.street);
  assert.equal(values.building, household.address.building);
  assert.equal(values.phone, household.phone);
  assert.equal(values.districtGroupId, 'district');
  assert.equal(values.lineAccount, 'line-id');
});

test('current account birth date and gender override older household copies', async t => {
  setup(t);
  const values = await load({ ...user, birth_date: new Date('1991-02-03'), sex: 'unspecified' });
  assert.equal(values.birthDate, '1991-02-03');
  assert.equal(values.gender, 'unspecified');
});

test('former head now defaults to general registration with the new head email', async t => {
  setup(t, { ...member, household: { ...household, active: true, representative: { _id: 'new-head', email: 'head@example.test' } } });
  const values = await load();
  assert.equal(values.residentMode, 'general');
  assert.equal(values.householdHeadEmail, 'head@example.test');
});

test('pending onboarding selection is preserved and earlier application profile is a fallback', async t => {
  setup(t, null, { residentProfile: member, applicantNote: '以前のメッセージ', districtGroup: 'district' }, { residentMode: 'general', householdHeadEmail: 'chosen@example.test' });
  const values = await load();
  assert.equal(values.representativeKana, member.nameKana);
  assert.equal(values.residentMode, 'general');
  assert.equal(values.householdHeadEmail, 'chosen@example.test');
  assert.equal(values.applicantNote, '以前のメッセージ');
  assert.equal(values.street, '');
});

test('general member defaults to the active household head district', async t => {
  setup(t, null, null, { residentMode: 'general', householdHeadEmail: 'HEAD@example.test' });
  User.findOne.mock.mockImplementation(filter => {
    assert.equal(filter.email, 'head@example.test');
    return query({ _id: 'head' });
  });
  t.mock.method(Household, 'findOne', filter => {
    assert.deepEqual(filter, { association: 'association', representative: 'head', active: true });
    return query({ _id: 'head-household', districtGroup: 'head-district' });
  });
  t.mock.method(AssociationMembership, 'exists', async () => ({ _id: 'membership' }));
  t.mock.method(DistrictGroup, 'exists', async () => ({ _id: 'head-district' }));
  const values = await load();
  assert.equal(values.districtGroupId, 'head-district');
});

test('general member does not default to an inactive household district', async t => {
  setup(t, null, null, { residentMode: 'general', householdHeadEmail: 'head@example.test' });
  User.findOne.mock.mockImplementation(() => query({ _id: 'head' }));
  t.mock.method(Household, 'findOne', () => query({ _id: 'head-household', districtGroup: 'head-district' }));
  t.mock.method(AssociationMembership, 'exists', async () => ({ _id: 'membership' }));
  t.mock.method(DistrictGroup, 'exists', async () => null);
  const values = await load();
  assert.equal(values.districtGroupId, '');
});

test('first participation uses account information and leaves unknown fields empty', async t => {
  setup(t, null);
  const values = await load({ ...user, birth_date: '2000-01-02', sex: 'female' });
  assert.equal(values.birthDate, '2000-01-02');
  assert.equal(values.gender, 'female');
  assert.equal(values.representativeKana, '');
  assert.equal(values.street, '');
});

test('participation form renders saved values and selected district and gender safely', async t => {
  setup(t, { ...member, household: { ...household, address: { ...household.address, street: '住所"<script>' } } });
  const values = await load();
  const html = await ejs.renderFile(fileURLToPath(new URL('../src/views/household-application.ejs', import.meta.url)), { title: '参加申請', currentUser: user, currentPath: '/join', csrfToken: 'csrf', association: { _id: 'association', name: '町内会' }, districtGroups: [{ _id: 'district', name: '1班' }], values });
  assert.match(html, /value="district" selected/);
  assert.match(html, /value="male" selected/);
  assert.match(html, /value="1990-04-01"/);
  assert.match(html, /value="やまだ たろう"/);
  assert.match(html, /住所&#34;&lt;script&gt;/);
  assert.match(html, /current@example.test/);
});
