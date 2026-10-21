import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { dangerReportHomeWindow } from '../src/lib/dangerReportWindow.js';

test('home window includes today and yesterday in Japan and expires at midnight', () => {
  const posted = new Date('2026-10-20T15:00:00Z'); // October 21, midnight JST
  const visible = now => { const range = dangerReportHomeWindow(new Date(now)); return posted >= range.$gte && posted <= range.$lte; };
  assert.equal(visible('2026-10-20T14:59:59.999Z'), false);
  assert.equal(visible('2026-10-20T15:00:00Z'), true);
  assert.equal(visible('2026-10-22T14:59:59.999Z'), true);
  assert.equal(visible('2026-10-22T15:00:00Z'), false);
});
test('calendar window crosses month and year boundaries', () => {
  assert.equal(dangerReportHomeWindow(new Date('2027-01-01T03:00:00Z')).$gte.toISOString(), '2026-12-30T15:00:00.000Z');
  assert.equal(dangerReportHomeWindow(new Date('2026-03-01T03:00:00Z')).$gte.toISOString(), '2026-02-27T15:00:00.000Z');
});
const memberships = [{ association: { _id: 'association', name: '町内会' } }];
const render = reports => ejs.renderFile('src/views/partials/danger-home.ejs', { reports, memberships });
test('no recent reports hides the entire home section including empty message and buttons', async () => {
  assert.equal((await render([])).trim(), '');
});
test('recent report displays the alert with photos, details and padded history actions', async () => {
  const html = await render([{ _id: 'report', association: 'association', title: '危険情報', createdAt: new Date(), author: { displayname: '住人' } }]);
  assert.match(html, /danger-home-content/);
  assert.match(html, /danger-home-actions/);
  assert.match(html, /危険情報/);
  assert.match(html, /住人/);
  assert.match(html, />地図と履歴<\/a>/);
  assert.doesNotMatch(html, /投稿はありません/);
});
