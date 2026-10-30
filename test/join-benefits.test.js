import test from 'node:test';
import assert from 'node:assert/strict';
import { benefitColors, benefitIcons, joinBenefitValues } from '../src/services/joinBenefitsService.js';
import ejs from 'ejs';

test('benefits accept single and multiple entries, trim and remove empty rows', () => {
  assert.deepEqual(joinBenefitValues({ benefitTitle: ' 防災 ', benefitContent: ' 情報共有 ' }), [{ title: '防災', content: '情報共有', color: 'green', icon: 'town' }]);
  assert.deepEqual(joinBenefitValues({ benefitTitle: ['', '交流'], benefitContent: ['', '行事'] }), [{ title: '交流', content: '行事', color: 'green', icon: 'town' }]);
  assert.deepEqual(joinBenefitValues({}), []);
});
test('benefits reject incomplete, oversized and malformed input', () => {
  for (const body of [{ benefitTitle: 'タイトル' }, { benefitContent: '内容' }, { benefitTitle: 'a'.repeat(101), benefitContent: '内容' }, { benefitTitle: ['a'], benefitContent: ['b'.repeat(2001)] }, { benefitTitle: Array(11).fill('a') }, { benefitTitle: { bad: true } }]) assert.throws(() => joinBenefitValues(body), { status: 400 });
});
test('public and management templates render with escaped stored benefits and print QR', async () => {
  const data = { title: '案内', assetVersion: '1', currentUser: null, notice: '', csrfToken: 'token', benefitColors, benefitIcons, association: { _id: '123', name: 'テスト町内会', joinBenefits: [{ title: '<script>alert(1)</script>', content: '内容' }] }, joinUrl: 'https://example.com/associations/123/join', qrCode: 'data:image/png;base64,AAA' };
  const html = await ejs.renderFile('src/views/association-join.ejs', data);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('data:image/png;base64,AAA'));
  assert.ok(html.includes('/associations/123/register/start'));
  assert.ok(html.includes('join-print-only'));
  await ejs.renderFile('src/views/association-join-manage.ejs', data);
});

test('benefits preserve chosen colors, icons and display order up to ten entries', () => {
  const body = { benefitTitle: benefitColors.map(([, name]) => name), benefitContent: Array(10).fill('内容'), benefitColor: benefitColors.map(([value]) => value), benefitIcon: Array.from({ length: 10 }, (_, i) => benefitIcons[i % benefitIcons.length][0]) };
  const result = joinBenefitValues(body);
  assert.equal(result.length, 10);
  assert.deepEqual(result.map(item => item.title), body.benefitTitle);
  assert.deepEqual(result.map(item => item.color), body.benefitColor);
  assert.deepEqual(result.map(item => item.icon), body.benefitIcon);
  for (const extra of [{ benefitColor: 'invalid' }, { benefitIcon: 'invalid' }, { benefitColor: { invalid: true } }]) assert.throws(() => joinBenefitValues({ benefitTitle: 'タイトル', benefitContent: '内容', ...extra }), { status: 400 });
});
test('public cards display selected style and management renders modal choices', async () => {
  const association = { _id: '123', joinBenefits: [{ title: '交流', content: '集まる', color: 'rose', icon: 'people' }] };
  const html = await ejs.renderFile('src/views/partials/join-benefits.ejs', { association });
  assert.ok(html.includes('bulletin-benefit-card benefit-color-rose'));
  assert.ok(html.includes('join-benefit-icon'));
  const management = await ejs.renderFile('src/views/association-join-manage.ejs', { title: '管理', assetVersion: '1', currentUser: null, notice: '', csrfToken: 'token', association, benefitColors, benefitIcons });
  assert.equal((management.match(/name="color"/g) || []).length, 10);
  assert.equal((management.match(/name="icon"/g) || []).length, 8);
  assert.ok(management.includes('<dialog'));
  assert.ok(management.includes('data-action="up"'));
  assert.ok(management.includes('name="benefitColor" value="rose"'));
});
