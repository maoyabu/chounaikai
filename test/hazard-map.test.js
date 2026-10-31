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

test('home hazard links appear without danger reports, support multiple associations and escape URLs', async () => {
  const render = memberships => ejs.renderFile('src/views/partials/hazard-map-home.ejs', { memberships });
  assert.equal((await render([{ association: { name: '未設定' } }])).trim(), '');
  assert.equal((await render([{ association: { hazardMapUrl: 'javascript:alert(1)' } }])).trim(), '');
  const html = await render([
    { association: { name: '第一町内会', hazardMapUrl: 'https://example.com/?a=1&b=2' } },
    { association: { name: '第二町内会', hazardMapUrl: 'https://disaportal.gsi.go.jp/' } }
  ]);
  assert.match(html, /第一町内会のハザードマップ/);
  assert.match(html, /第二町内会のハザードマップ/);
  assert.match(html, /a=1&amp;b=2/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
});
