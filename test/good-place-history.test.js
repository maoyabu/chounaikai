import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import vm from 'node:vm';

test('history renders reaction counts and escapes comment text', async () => {
  const html = await ejs.renderFile('src/views/partials/good-place-history-content.ejs', {
    association: { _id: 'association' },
    reports: [{ _id: 'report', title: '写真', latitude: 35, longitude: 139, createdAt: new Date(), historyReactions: { likeCount: 3, comments: [{ body: '<script>bad</script>', user: { displayname: '住人' } }, { body: '最新の感想' }] } }]
  });
  assert.match(html, /ライク♡ 3/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /最新の感想/);
  assert.match(html, /data-good-place-enlarge/);
  assert.match(html, /<dialog/);
});

test('photo selection updates map and opens the selected full photo; close works', () => {
  const photo = {}, frame = {}, status = {}, close = {};
  const dialog = { querySelector: selector => selector === 'img' ? photo : close, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener() {} };
  close.addEventListener = (_type, handler) => { close.click = handler; };
  const button = { dataset: { dangerQuery: '35,139' }, hasAttribute: () => true, querySelector: () => ({ src: '/photo', alt: '写真' }), setAttribute() {}, addEventListener(_type, handler) { this.click = handler; } };
  vm.runInNewContext(fs.readFileSync('src/public/danger-history.js', 'utf8'), { document: { querySelectorAll: selector => selector === '[data-danger-focus]' ? [button] : [], getElementById: id => ({ 'danger-history-frame': frame, 'danger-map-status': status, 'good-place-photo-dialog': dialog })[id] } });
  button.click();
  assert.match(frame.src, /35%2C139/);
  assert.equal(dialog.open, true);
  assert.equal(photo.src, '/photo');
  assert.equal(photo.alt, '写真');
  close.click();
  assert.equal(dialog.open, false);
});

test('changing sort submits the selected order automatically', () => {
  let submitted = false;
  const select = { form: { requestSubmit() { submitted = true; } }, addEventListener(event, handler) { assert.equal(event, 'change'); this.change = handler; } };
  vm.runInNewContext(fs.readFileSync('src/public/danger-history.js', 'utf8'), { document: { querySelectorAll: selector => selector === '[data-good-place-sort]' ? [select] : [], getElementById: () => null } });
  assert.equal(submitted, false);
  select.change();
  assert.equal(submitted, true);
});
