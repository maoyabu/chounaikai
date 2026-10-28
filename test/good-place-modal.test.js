import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const script = fs.readFileSync('src/public/good-place-history.js', 'utf8');
test('photo and title open detail, select their row and update the map; closing keeps selection', () => {
  const element = () => ({ handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
  const frame = element(), close = element(), map = {}, status = {};
  const dialog = { ...element(), open: false, showModal() { this.open = true; }, close() { this.open = false; }, querySelector: selector => selector.includes('frame') ? frame : close };
  const photo = { ...element(), dataset: { goodPlaceDetail: '/associations/town/good-places/post', dangerQuery: '町の公園' }, setAttribute(key, value) { this[key] = value; }, querySelector: () => ({ alt: '公園' }) };
  const title = { ...element(), dataset: { goodPlaceDetail: photo.dataset.goodPlaceDetail } };
  const row = { classList: { toggle(name, value) { row.selected = value; } }, contains: node => node === photo, querySelector: () => photo };
  photo.closest = title.closest = () => row;
  const document = { getElementById: id => ({ 'good-place-detail-modal': dialog, 'danger-history-frame': map, 'danger-map-status': status })[id], querySelectorAll: selector => ({ '[data-danger-report]': [row], '[data-danger-focus]': [photo], '[data-good-place-detail]': [photo, title] })[selector] };
  vm.runInNewContext(script, { document, location: { search: '', pathname: '/associations/town/good-places' }, URLSearchParams });
  for (const trigger of [photo, title]) {
    let prevented = false;
    trigger.handlers.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(dialog.open, true);
    assert.equal(frame.src, photo.dataset.goodPlaceDetail);
    assert.equal(row.selected, true); assert.equal(photo['aria-pressed'], 'true');
    assert.ok(map.src.includes(encodeURIComponent('町の公園')));
    close.handlers.click(); assert.equal(dialog.open, false); assert.equal(row.selected, true);
  }
  title.handlers.click({ ctrlKey: true }); assert.equal(dialog.open, false);
});
