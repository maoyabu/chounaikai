import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import ejs from 'ejs';
import vm from 'node:vm';
import { personalDataKeyring, encryptPersonalData, decryptPersonalData } from '../src/security/personalDataCrypto.js';

const env = { PERSONAL_DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const ring = personalDataKeyring(env), id = '123456789012345678901234';
test('personal data encryption is randomized, authenticated and bound to record/field/collection', () => {
  const seal = () => encryptPersonalData('東京都 電話 090-0000-0000', 'annual_officers', id, 'address', ring);
  const a = seal(), b = seal();
  assert.notEqual(a, b);
  assert.equal(decryptPersonalData(a, 'annual_officers', id, 'address', ring), '東京都 電話 090-0000-0000');
  for (const [collection, record, field] of [['annual_leader_assignments', id, 'address'], ['annual_officers', '223456789012345678901234', 'address'], ['annual_officers', id, 'phone']]) {
    assert.throws(() => decryptPersonalData(a, collection, record, field, ring), /personal_data_encryption_failed/);
  }
  const altered = a.split(':'); altered[4] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptPersonalData(altered.join(':'), 'annual_officers', id, 'address', ring));
  assert.throws(() => encryptPersonalData(a, 'annual_officers', id, 'address', ring));
  assert.throws(() => decryptPersonalData('東京都', 'annual_officers', id, 'address', ring));
});
test('keys fail closed and previous keys allow decrypting during rotation', () => {
  assert.throws(() => personalDataKeyring({}));
  assert.throws(() => personalDataKeyring({ PERSONAL_DATA_ENCRYPTION_KEY: 'not-a-key' }));
  assert.throws(() => personalDataKeyring({ ...env, MFA_ENCRYPTION_KEY: env.PERSONAL_DATA_ENCRYPTION_KEY }));
  assert.throws(() => personalDataKeyring({ ...env, PERSONAL_DATA_PREVIOUS_KEYS: 'null' }));
  assert.throws(() => personalDataKeyring({ ...env, PERSONAL_DATA_PREVIOUS_KEYS: JSON.stringify({ 1: env.PERSONAL_DATA_ENCRYPTION_KEY }) }));
  const ciphertext = encryptPersonalData('090-0000-0000', 'households', id, 'phone', ring);
  const newEnv = { PERSONAL_DATA_KEY_VERSION: '2', PERSONAL_DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
  assert.throws(() => decryptPersonalData(ciphertext, 'households', id, 'phone', personalDataKeyring(newEnv)));
  const rotated = personalDataKeyring({ ...newEnv, PERSONAL_DATA_PREVIOUS_KEYS: JSON.stringify({ 1: env.PERSONAL_DATA_ENCRYPTION_KEY }) });
  assert.equal(decryptPersonalData(ciphertext, 'households', id, 'phone', rotated), '090-0000-0000');
  assert.equal(decryptPersonalData(encryptPersonalData('', 'households', id, 'phone', ring), 'households', id, 'phone', ring), '');
});

test('directory rendering keeps contact displays but excludes addresses/phones from search and retains partial name/email matching', async () => {
  const user = { _id: id, username: 'test-user', displayname: '山田太郎', email: 'taro@example.invalid' };
  const contact = { _id: id, name: '山田太郎', address: '検索対象外の住所', phone: '090-0000-0000', mobilePhone: '090-1111-1111', user, representative: user, districtGroup: { _id: id, name: '1班' } };
  const locals = { title: 'テスト', assetVersion: 'test', currentUser: null, currentPath: '/', notice: null, csrfToken: 'test', association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2026, departments: [], roles: [], districtGroups: [], districtChildren: [], memberships: [], officers: [contact], leaders: [contact], leaderAssignments: [], householdRepresentatives: [{ user, household: { address: { postalCode: '1234567', street: contact.address, building: '建物' } }, districtGroup: contact.districtGroup, residentProfile: { name: contact.name }, attributeTags: [] }] };
  for (const view of ['association-officers', 'association-leaders', 'association-annual-settings']) {
    Object.assign(locals, { officerRecords: [], leaderRecords: [], officerCandidates: [], leaderCandidates: [], departmentPlans: [], leaderDistricts: [] });
    const html = await ejs.renderFile(new URL(`../src/views/${view}.ejs`, import.meta.url).pathname, locals);
    const rows = [...html.matchAll(/data-search="([^"]*)"/g)].map(match => match[1]);
    assert.ok(rows.length > 0);
    for (const text of rows) {
      assert.ok(!text.includes(contact.address)); assert.ok(!text.includes(contact.phone));
    }
    assert.ok(rows.some(text => text.includes('山田太郎') && text.includes(user.email)));
    assert.ok(html.includes(contact.address));
    if (view !== 'association-annual-settings') {
      const row = { dataset: { search: rows[0] }, hidden: false };
      let callback;
      const input = { value: '山田', addEventListener: (_event, listener) => { callback = listener; } };
      const document = { getElementById: () => input, querySelectorAll: selector => selector.includes('directory-row') ? [row] : [] };
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('directory-search'));
      vm.runInNewContext(script, { document }); callback(); assert.equal(row.hidden, false);
      input.value = 'EXAMPLE'; callback(); assert.equal(row.hidden, false);
      input.value = contact.address; callback(); assert.equal(row.hidden, true);
    }
  }
});
