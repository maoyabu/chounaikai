import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileJoinBenefitsRouter } from '../src/routes/mobileJoinBenefits.js';
import { platformJoinBenefits } from '../src/services/joinBenefitsPresentation.js';
import { requireLogin } from '../src/middleware/auth.js';
import { readFile } from 'node:fs/promises';

test('mobile join benefits require login and expose the same eight Web benefits', () => {
  assert.equal(mobileJoinBenefitsRouter.stack[0].handle, requireLogin);
  assert.equal(platformJoinBenefits.length, 8);
  assert.deepEqual(platformJoinBenefits.map(item => item.title), [
    '災害時に住民を守る',
    'まちの情報がここにある',
    '必要な情報がすぐ届く',
    '防犯・見守りをみんなで',
    'みんなの力でより良いまちに',
    '手間の削減',
    'スピーディーに',
    '参加しやすく'
  ]);
  assert.equal(platformJoinBenefits.filter(item => item.section === 'service').length, 5);
  assert.equal(platformJoinBenefits.filter(item => item.section === 'outcome').length, 3);
});

test('mobile benefit source stays aligned with the Web public page', async () => {
  const template = await readFile('src/views/partials/join-benefits.ejs', 'utf8');
  for (const benefit of platformJoinBenefits) {
    assert.ok(template.includes(benefit.title));
    for (const item of benefit.items) assert.ok(template.includes(item));
  }
});
