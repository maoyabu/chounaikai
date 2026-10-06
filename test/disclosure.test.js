import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { disclosureFields, disclosureLevels, defaultPolicy, effectiveDisclosure, parseDisclosure, redactOfficer } from '../src/services/disclosurePolicy.js';
const policy = { photo: 'open', name: 'residents', address: 'residents', phone: 'residents', email: 'residents' };
const officer = { _id: '123456789012345678901234', fiscalYear: 2026, name: '秘密氏名', nameKana: '秘密よみ', address: '秘密住所', phone: '秘密電話', mobilePhone: '秘密携帯', districtGroup: { name: '秘密班' }, role: { name: '会長' }, user: { _id: '223456789012345678901234', displayname: '秘密アカウント氏名', username: '秘密ユーザー名', email: 'secret@example.invalid', avatar: 'https://example.invalid/secret-photo' } };
const consent = scopes => ({ scopes, confirmedAt: new Date('2026-04-01'), policyRevision: 0, fiscalYear: 2026 });
const view = (audience, scopes, options = {}) => redactOfficer(officer, policy, scopes && consent(scopes), { audience, currentYear: 2026, ...options });
test('without explicit consent no personal data is returned, including username and initials', () => {
  for (const audience of ['open', 'residents', 'officers']) {
    const result = view(audience);
    assert.equal(result.displayLabel, '会長担当');
    assert.equal(result.districtGroup, null);
    for (const secret of ['秘密', 'secret@example.invalid', 'secret-photo']) assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test('audience hierarchy and field restrictions apply to server display records', () => {
  const scopes = { photo: 'open', name: 'residents', address: 'officers', phone: 'private', email: 'officers' };
  const open = view('open', scopes), residents = view('residents', scopes), officers = view('officers', scopes);
  assert.equal(open.user.avatar, officer.user.avatar); assert.equal(open.name, ''); assert.equal(open.email, '');
  assert.equal(residents.name, officer.name); assert.equal(residents.address, '');
  assert.equal(officers.address, officer.address); assert.equal(officers.phone, ''); assert.equal(officers.mobilePhone, ''); assert.equal(officers.email, officer.user.email);
  assert.ok(!JSON.stringify(officers).includes('秘密ユーザー名'));
});
test('widening policy does not widen consent; narrowing then widening does not revive old consent', () => {
  assert.equal(effectiveDisclosure(policy, consent(defaultPolicy)).photo, 'officers');
  const history = [{ after: { ...policy, photo: 'private' } }, { after: policy }];
  assert.equal(effectiveDisclosure(policy, consent(policy), history).photo, 'private');
  assert.equal(effectiveDisclosure(policy, { ...consent(policy), policyRevision: 2 }, history).photo, 'open');
});
test('retired, cancelled, unlinked, and prior-year consent stays private', () => {
  for (const changes of [{ fiscalYear: 2025 }, { cancelledAt: new Date() }, { user: null }]) {
    assert.equal(redactOfficer({ ...officer, ...changes }, policy, consent(policy), { audience: 'officers', currentYear: 2026 }).name, '');
  }
  assert.equal(redactOfficer(officer, policy, { ...consent(policy), fiscalYear: 2025 }, { audience: 'officers', currentYear: 2026 }).name, '');
});
test('owner and manager can still view their permitted management data', () => {
  assert.equal(view('officers', null, { manager: true }).address, officer.address);
  assert.equal(view('residents', null, { viewerId: officer.user._id }).phone, officer.phone);
});
test('invalid values, public names and exceeding association cap are rejected', () => {
  assert.throws(() => parseDisclosure({ ...defaultPolicy, name: 'open' }));
  assert.throws(() => parseDisclosure({ ...defaultPolicy, phone: 'officers' }, defaultPolicy));
  assert.throws(() => parseDisclosure({ ...defaultPolicy, photo: ['open'] }));
  assert.deepEqual(parseDisclosure(defaultPolicy, policy), defaultPolicy);
});
test('disclosure views render forms, explicit agreement, cap, and no identity leaks', async () => {
  const locals = { title: 'テスト', assetVersion: 'test', currentUser: null, currentPath: '/', notice: null, csrfToken: 'csrf', association: { _id: officer._id, name: 'テスト町内会' }, fiscalYear: 2026, disclosureFields, disclosureLevels, policy, officers: [view('residents')] };
  const html = await ejs.renderFile(new URL('../src/views/association-public-officers.ejs', import.meta.url).pathname, locals);
  assert.ok(html.includes('会長担当')); assert.ok(!html.includes('秘密')); assert.ok(!html.includes('secret-photo'));
  const profile = await ejs.renderFile(new URL('../src/views/profile-disclosure.ejs', import.meta.url).pathname, { ...locals, rows: [{ association: locals.association, policy: defaultPolicy, effective: effectiveDisclosure(defaultPolicy) }] });
  assert.ok(profile.includes('confirmDisclosure')); assert.ok(profile.includes('未同意')); assert.ok(profile.includes('name="policyRevision"'));
  await ejs.renderFile(new URL('../src/views/association-disclosure.ejs', import.meta.url).pathname, locals);
});

test('public page and department plans never expose names, even to a signed-in visitor', async () => {
  const display = view('open', policy);
  const locals = { title: '公開ページ', showNotificationPrompt: false, assetVersion: 'test', currentPath: '/', notice: null, csrfToken: 'test', association: { _id: officer._id, name: '町内会' }, fiscalYear: 2026, officers: [display], departmentPlans: [{ department: { name: '総務部' }, goal: '地域活動', officers: [display] }], groups: [], events: [], months: [], calendarWindow: { currentMonth: '2026-10', previousMonth: '2026-09', nextMonth: '2026-11' }, householdCount: 1, residentCount: 2, districtStats: [] };
  for (const currentUser of [null, { _id: 'visitor', displayname: '訪問者', username: 'visitor', email: 'visitor@example.invalid' }]) {
    const html = await ejs.renderFile(new URL('../src/views/association-public-events.ejs', import.meta.url).pathname, { ...locals, currentUser });
    assert.ok(!html.includes('秘密')); assert.ok(!html.includes(officer.user.email));
    assert.ok(html.includes(officer.user.avatar));
  }
});
