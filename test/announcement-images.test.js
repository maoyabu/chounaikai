import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import vm from 'node:vm';

const announcement = { _id: 'm', audience: 'all', urgency: 3, title: '連絡', body: '本文', createdAt: new Date(), responseMode: 'none', options: [], attachments: [
  { url: 'https://example.test/photo.png', originalName: '写真.png', mimeType: 'image/png' },
  { url: 'https://example.test/doc.pdf', originalName: '資料.pdf', mimeType: 'application/pdf' }
] };

test('received and sent messages show inline images after body and keep document links', async () => {
  const common = { title: '連絡', assetVersion: 'test', currentUser: null, currentPath: '', notice: null,
    csrfToken: 'token', association: { _id: 'a', name: '町内会' }, associationId: 'a', announcement,
    receipt: { readAt: null }, receipts: [] };
  for (const view of ['resident-announcement-detail', 'officer-announcement-detail']) {
    const html = await ejs.renderFile(`src/views/${view}.ejs`, common);
    assert.match(html, /<img src="https:\/\/example.test\/photo.png" alt="写真.png" loading="lazy">/);
    assert.match(html, /<a href="https:\/\/example.test\/doc.pdf"/);
    assert.ok(html.indexOf('class="body-copy"') < html.indexOf('data-announcement-image'));
    assert.match(html, /aria-haspopup="dialog"/);
  }
});

test('image click opens selected image in modal and close clears image source', async () => {
  const html = await ejs.renderFile('src/views/partials/announcement-attachments.ejs', { announcement });
  const listeners = {}, closeListeners = {}, buttonListeners = {};
  const expanded = { removeAttribute(name) { delete this[name]; } }, caption = {};
  const close = { addEventListener(name, callback) { closeListeners[name] = callback; } };
  const dialog = { querySelector: selector => ({ '[data-expanded-image]': expanded, '[data-image-caption]': caption, '[data-close-image]': close })[selector],
    addEventListener(name, callback) { listeners[name] = callback; },
    showModal() { this.open = true; }, close() { this.open = false; listeners.close(); },
    getBoundingClientRect() { return { left: 10, top: 10, right: 100, bottom: 100 }; } };
  const button = { querySelector: () => ({ src: announcement.attachments[0].url, alt: '写真.png' }), addEventListener(name, callback) { buttonListeners[name] = callback; } };
  const section = { dataset: {}, querySelector: () => dialog, querySelectorAll: () => [button] };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document: { querySelectorAll: () => [section] } });
  buttonListeners.click();
  assert.equal(dialog.open, true);
  assert.equal(expanded.src, announcement.attachments[0].url);
  assert.equal(caption.textContent, '写真.png');
  closeListeners.click();
  assert.equal(dialog.open, false); assert.equal(expanded.src, undefined);
  buttonListeners.click();
  listeners.click({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, false);
});

test('multiple images use one horizontal track with next and previous controls', async () => {
  const html = await ejs.renderFile('src/views/partials/announcement-attachments.ejs', { announcement: { ...announcement, attachments: [announcement.attachments[0], { ...announcement.attachments[0], url: 'https://example.test/two.png' }] } });
  assert.equal((html.match(/class="announcement-image-track"/g) || []).length, 1);
  assert.equal((html.match(/class="announcement-image"/g) || []).length, 2);
  const callbacks = {};
  const previous = { addEventListener(name, callback) { callbacks.previous = callback; } };
  const next = { addEventListener(name, callback) { callbacks.next = callback; } };
  const position = {};
  const track = { scrollLeft: 0, clientWidth: 400, querySelectorAll: () => [{}, {}],
    addEventListener(name, callback) { callbacks[name] = callback; }, scrollTo({ left }) { this.scrollLeft = left; callbacks.scroll(); } };
  const carousel = { dataset: {}, querySelector: selector => ({ '[data-image-track]': track, '[data-image-previous]': previous, '[data-image-next]': next, '[data-image-position]': position })[selector] };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts[1][1], { document: { querySelectorAll: () => [carousel] } });
  assert.equal(previous.disabled, true);
  callbacks.next(); assert.equal(track.scrollLeft, 400); assert.equal(position.textContent, '2 / 2'); assert.equal(next.disabled, true);
  callbacks.previous(); assert.equal(track.scrollLeft, 0); assert.equal(position.textContent, '1 / 2');
});
