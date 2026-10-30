import test from 'node:test';
import assert from 'node:assert/strict';
import { joinBenefitValues } from '../src/services/joinBenefitsService.js';
import ejs from 'ejs';

test('benefits accept single and multiple entries, trim and remove empty rows', () => {
  assert.deepEqual(joinBenefitValues({ benefitTitle: ' 防災 ', benefitContent: ' 情報共有 ' }), [{ title: '防災', content: '情報共有' }]);
  assert.deepEqual(joinBenefitValues({ benefitTitle: ['', '交流'], benefitContent: ['', '行事'] }), [{ title: '交流', content: '行事' }]);
  assert.deepEqual(joinBenefitValues({}), []);
});
test('benefits reject incomplete, oversized and malformed input', () => {
  for (const body of [{ benefitTitle: 'タイトル' }, { benefitContent: '内容' }, { benefitTitle: 'a'.repeat(101), benefitContent: '内容' }, { benefitTitle: ['a'], benefitContent: ['b'.repeat(2001)] }, { benefitTitle: Array(31).fill('a') }, { benefitTitle: { bad: true } }]) assert.throws(() => joinBenefitValues(body), { status: 400 });
});
test('public and management templates render with escaped stored benefits and print QR', async () => {
  const data = { title: '案内', assetVersion: '1', currentUser: null, notice: '', csrfToken: 'token', association: { _id: '123', name: 'テスト町内会', joinBenefits: [{ title: '<script>alert(1)</script>', content: '内容' }] }, joinUrl: 'https://example.com/associations/123/join', qrCode: 'data:image/png;base64,AAA' };
  const html = await ejs.renderFile('src/views/association-join.ejs', data);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('data:image/png;base64,AAA'));
  assert.ok(html.includes('/associations/123/register/start'));
  assert.ok(html.includes('join-print-only'));
  await ejs.renderFile('src/views/association-join-manage.ejs', data);
});
