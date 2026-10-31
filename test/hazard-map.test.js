import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { parseHazardMapUrl } from '../src/lib/hazardMap.js';

test('hazard map URL permits web links and removal but rejects unsafe schemes and credentials', () => {
  assert.equal(parseHazardMapUrl('  '), '');
  assert.equal(parseHazardMapUrl(' https://disaportal.gsi.go.jp/hazardmap/index.html?citycode=08217 '), 'https://disaportal.gsi.go.jp/hazardmap/index.html?citycode=08217');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'invalid', 'https://user:pass@example.com', 'https://example.com/' + 'a'.repeat(2048)]) {
    assert.throws(() => parseHazardMapUrl(value), error => error.status === 400);
  }
});

test('home has one disaster entry per membership and no separate map button', async () => {
  const render = memberships => ejs.renderFile('src/views/partials/hazard-map-home.ejs', { memberships });
  assert.equal((await render([])).trim(), '');
  const html = await render([
    { association: { _id: 'one', name: '第一町内会', hazardMapUrl: 'https://example.com/?a=1&b=2' } },
    { association: { _id: 'two', name: '第二町内会', hazardMapUrl: 'javascript:alert(1)' } }
  ]);
  assert.match(html, /第一町内会の防災情報/);
  assert.match(html, /第二町内会の防災情報/);
  assert.equal((html.match(/class="button disaster-home-button/g) || []).length, 2);
  assert.match(html,/href="\/associations\/one\/disaster"/);
  assert.doesNotMatch(html,/hazard-map-button|javascript:|target="_blank"/);
});
