import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';

const officer = {
  _id: 'officer', name: '山田太郎', nameKana: 'やまだたろう',
  phone: '045-123-4567', mobilePhone: '090-1234-5678', address: '連絡先住所',
  user: { displayname: '山田太郎', username: 'login@example.com', email: 'contact@example.com' },
  role: { name: '会長' }, department: { name: '総務部' }, districtGroup: { name: '一班' }
};
const locals = {
  association: { _id: 'association', name: 'テスト町内会' }, fiscalYear: 2026,
  officers: [officer], roles: [], departments: [], districtGroups: [], csrfToken: 'test'
};
const options = { includer: () => ({ template: ' ' }) };

test('resident officer directory omits contact details and login identifiers', async () => {
  const html = await ejs.renderFile('src/views/association-public-officers.ejs', locals, options);
  for (const value of [officer.phone, officer.mobilePhone, officer.address, officer.user.email, officer.user.username]) {
    assert.ok(!html.includes(value), `Resident directory exposed ${value}`);
  }
  for (const value of [officer.name, '会長', '総務部', '一班']) assert.ok(html.includes(value));
  const unnamed = await ejs.renderFile('src/views/association-public-officers.ejs', {
    ...locals, officers: [{ ...officer, name: '', user: { ...officer.user, displayname: '' } }]
  }, options);
  assert.ok(unnamed.includes('氏名未登録'));
  assert.ok(!unnamed.includes(officer.user.username));
});

test('management officer directory displays contact details', async () => {
  const html = await ejs.renderFile('src/views/association-officers.ejs', locals, options);
  for (const value of [officer.phone, officer.mobilePhone, officer.address, officer.user.email]) {
    assert.ok(html.includes(value), `Management directory omitted ${value}`);
  }
});
