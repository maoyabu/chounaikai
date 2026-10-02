import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ejs from 'ejs';

const element = () => ({ listeners: {}, hidden: false, textContent: '', addEventListener(name, callback) { this.listeners[name] = callback; } });
const runtime = async ({ failure = false, edit = false } = {}) => {
  const dialog = element(), content = element(), title = element(), error = element(), preview = element(), imageUrl = element(), save = element(), name = { focus() {} };
  const wishlist = { ...element(), type: 'checkbox', checked: false }, tracked = { checked: true }, lendable = { checked: true };
  const form = element(); form.action = 'http://localhost/associations/a/equipment';
  form.elements = { namedItem: field => ({ wishlist, tracked, lendable, productImageUrl: imageUrl })[field] || name };
  form.querySelector = selector => ({ '[data-equipment-editor-error]': error, '[data-equipment-image-preview]': preview, 'button[type="submit"]': save })[selector];
  content.replaceChildren = () => {}; content.querySelector = () => form;
  dialog.querySelector = selector => ({ '[data-equipment-editor-content]': content, '#equipment-editor-title': title })[selector];
  dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; dialog.listeners.close(); };
  const trigger = element(); trigger.href = `http://localhost/associations/a/equipment/${edit ? 'item/edit' : 'new?place=%E5%80%89%E5%BA%AB'}`; trigger.dataset = { equipmentEditor: edit ? 'edit' : 'new' };
  let reloaded = false; const requests = [];
  vm.runInNewContext(await fs.readFile('src/public/equipment-editor.js', 'utf8'), {
    document: { getElementById: () => dialog, querySelectorAll: () => [trigger], createElement: element }, URL, URLSearchParams, AbortController,
    FormData: class { *[Symbol.iterator]() { yield ['_csrf', 'token']; yield ['name', '入力した備品']; } },
    fetch: async (url, options) => { requests.push({ url: String(url), options }); return options.method === 'POST' ? { ok: !failure, json: async () => failure ? { error: '数量を確認してください。' } : { ok: true } } : { ok: true, text: async () => '<form class="equipment-editor-form"></form>' }; },
    window: { location: { reload() { reloaded = true; } } }
  });
  return { wishlist, tracked, lendable, dialog, content, title, error, save, form, trigger, requests, reloaded: () => reloaded };
};

test('new equipment opens a modal with the selected place and posts CSRF without losing tab', async () => {
  const r = await runtime();
  await r.trigger.listeners.click({ preventDefault() {} });
  assert.equal(r.dialog.open, true);
  assert.match(r.requests[0].url, /place=%E5%80%89%E5%BA%AB&modal=1/);
  await r.form.listeners.submit({ preventDefault() {} });
  assert.equal(r.requests[1].options.method, 'POST');
  assert.equal(r.requests[1].options.body.get('_csrf'), 'token');
  assert.equal(r.reloaded(), true);
});
test('edit errors stay in the modal with retry available and input content retained', async () => {
  const r = await runtime({ failure: true, edit: true });
  await r.trigger.listeners.click({ preventDefault() {} });
  assert.equal(r.title.textContent, '備品の編集');
  await r.form.listeners.submit({ preventDefault() {} });
  assert.equal(r.error.textContent, '数量を確認してください。'); assert.equal(r.error.hidden, false);
  assert.equal(r.dialog.open, true); assert.equal(r.save.disabled, false); assert.equal(r.reloaded(), false);
  assert.match(r.content.innerHTML, /equipment-editor-form/);
  r.dialog.listeners.click({ target: { closest: () => true } }); assert.equal(r.dialog.open, false);
});
test('modal partial renders existing values, category choices, preview and cancel control', async () => {
  const html = await ejs.renderFile('src/views/partials/equipment-editor.ejs', {
    modal: true, item: { _id: 'item', name: 'デジカメ', place: '倉庫', quantity: 1, unit: '個', tracked: true, productImageUrl: 'https://example.test/image.png' },
    base: '/associations/a/equipment', csrfToken: 'token', choices: { place: ['倉庫'], unit: ['個'], stockCategory: ['広報'], disasterCategory: ['記録'] }
  });
  assert.match(html, /action="\/associations\/a\/equipment\/item\/edit"/);
  assert.match(html, /value="デジカメ"/); assert.match(html, /data-equipment-image-preview/);
  assert.match(html, /data-close-equipment-dialog>キャンセル/); assert.doesNotMatch(html, /<html|<main/);
});

test('wishlist selection clears and disables inventory and lending, deselection re-enables them', async () => {
  const r = await runtime();
  await r.trigger.listeners.click({ preventDefault() {} });
  r.wishlist.checked = true; r.wishlist.listeners.change();
  for (const field of [r.tracked,r.lendable]) { assert.equal(field.checked,false); assert.equal(field.disabled,true); }
  r.wishlist.checked = false; r.wishlist.listeners.change();
  for (const field of [r.tracked,r.lendable]) { assert.equal(field.checked,false); assert.equal(field.disabled,false); }
});
