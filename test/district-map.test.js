import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { parseDistrictMapUrl, districtMapPresentation } from '../src/lib/districtMap.js';

const earth = 'https://earth.google.com/web/@35.40793887,139.53920002,0a,1705.38824906d,30y,-0h,0t,0r/data=CgRCAggCMikKJwolCiExQ09tdHJ0RjlCT3lrOXJSLVNhaVJLbVZoSm5OQXpoSl8gAToDCgEwQgIIAEoICLzj04AEEAE?utm_source=mymaps';
const earthShare = 'https://earth.google.com/earth/d/1COmtrtF9BOyk9rR-SaiRKmVhJnNAzhJ_?usp=sharing';

test('district map validates links and supports removal', () => {
  assert.equal(parseDistrictMapUrl(' '), '');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:pass@example.com', 'https://example.com/' + 'a'.repeat(2048)]) {
    assert.throws(() => parseDistrictMapUrl(value), { status: 400 });
    assert.equal(districtMapPresentation(value), null);
  }
});
test('Earth projects use image previews while My Maps uses Google embed', () => {
  const embed = 'https://www.google.com/maps/d/embed?mid=1COmtrtF9BOyk9rR-SaiRKmVhJnNAzhJ_';
  assert.equal(districtMapPresentation(earth).embedUrl, '');
  assert.equal(districtMapPresentation(earth).previewUrl, 'https://drive.google.com/thumbnail?id=1COmtrtF9BOyk9rR-SaiRKmVhJnNAzhJ_&sz=w1600');
  assert.equal(districtMapPresentation('https://www.google.com/maps/d/viewer?mid=1COmtrtF9BOyk9rR-SaiRKmVhJnNAzhJ_').embedUrl, embed);
  assert.equal(districtMapPresentation('https://example.com/map').embedUrl, '');
  assert.equal(districtMapPresentation('https://www.google.com.evil.test/maps/d/embed?mid=abc').embedUrl, '');
});
test('map and registration link render configured links and hide absent or unsafe maps', async () => {
  for (const partial of ['district-map', 'district-map-link']) {
    const render = districtMapUrl => ejs.renderFile(`src/views/partials/${partial}.ejs`, { association: { name: '町内会', districtMapUrl }, districtMapPresentation });
    assert.equal((await render('')).trim(), '');
    assert.equal((await render('javascript:alert(1)')).trim(), '');
    const html = await render(earth);
    assert.match(html, /自分の地区を確認する/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    if (partial === 'district-map') {
      assert.match(html, /<img class="district-map-preview".*https:\/\/drive.google.com\/thumbnail/);
      assert.doesNotMatch(html, /<iframe/);
      const myMapsHtml = await render('https://www.google.com/maps/d/viewer?mid=abc123');
      assert.match(myMapsHtml, /<iframe.*https:\/\/www.google.com\/maps\/d\/embed/);
    }
  }
});


test('Earth direct project shares display the same map preview and preserve the separate-tab URL', async () => {
  const presentation = districtMapPresentation(earthShare);
  assert.equal(presentation.previewUrl, districtMapPresentation(earth).previewUrl);
  assert.equal(presentation.href, earthShare);
  assert.equal(presentation.embedUrl, '');
  for (const partial of ['district-map', 'district-map-link']) {
    const html = await ejs.renderFile(`src/views/partials/${partial}.ejs`, {
      association: { name: '町内会', districtMapUrl: earthShare }, districtMapPresentation
    });
    assert.ok(html.includes(`href="${earthShare}"`));
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    if (partial === 'district-map') assert.match(html, /<img class="district-map-preview".*thumbnail/);
  }
  for (const url of ['https://earth.google.com.evil.test/earth/d/abc', 'https://earth.google.com/earth/d/abc/extra', 'https://earth.google.com/earth/d/']) {
    assert.equal(districtMapPresentation(url).previewUrl, '');
  }
});
