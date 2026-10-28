import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
test('comments cycle automatically, wrap around, and pause while hovered', () => {
  const element = () => ({ handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {} });
  const comments = [{ hidden: false }, { hidden: true }], pause = element(), next = element(), position = {};
  const panel = { ...element(), querySelectorAll: () => comments, querySelector: selector => selector.includes('pause') ? pause : selector.includes('position') ? position : next, contains: () => false };
  let tick;
  vm.runInNewContext(fs.readFileSync('src/public/good-place-photo-comments.js', 'utf8'), {
    document: { querySelectorAll: () => [panel], addEventListener() {}, hidden: false },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    setInterval(fn, delay) { assert.equal(delay, 6000); tick = fn; return 1; }, clearInterval() { tick = null; }, setTimeout(fn) { fn(); }
  });
  tick(); assert.deepEqual(comments.map(comment => comment.hidden), [true, false]);
  tick(); assert.deepEqual(comments.map(comment => comment.hidden), [false, true]);
  panel.handlers.mouseenter(); assert.equal(tick, null);
  panel.handlers.mouseleave(); assert.equal(typeof tick, 'function');
});
test('photo overlay excludes moderated comments, escapes text, and starts with one comment', async () => {
  const html = await ejs.renderFile('src/views/good-place-detail.ejs', {
    title: '詳細', assetVersion: 'test', currentUser: null, currentPath: '/', csrfToken: 'csrf', showNotificationPrompt: false, notice: null,
    association: { _id: 'town', name: '町内会' }, report: { _id: 'post', title: '桜', body: '風景', createdAt: new Date(), locationSource: 'address', address: '公園' },
    reactions: { comments: [{ body: '<script>bad</script>', user: { displayname: '住人' }, createdAt: new Date() }, { body: '次のコメント', createdAt: new Date() }, { body: '非表示コメント', hiddenAt: new Date(), createdAt: new Date() }], owner: true, likeCount: 0, page: 1 }
  });
  const overlay = html.match(/<aside class="good-place-photo-comments"[\s\S]*?<\/aside>/)[0];
  assert.match(overlay, /&lt;script&gt;/); assert.doesNotMatch(overlay, /非表示コメント/);
  assert.equal((overlay.match(/data-photo-comment hidden/g) || []).length, 1);
  assert.match(overlay, /（1\/2）/);
  assert.doesNotMatch(overlay, /<strong>/);
  assert.doesNotMatch(overlay, /data-photo-comment-(pause|next)/);
});
