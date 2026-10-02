import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ejs from 'ejs';

const element = (value = '') => ({ value, checked: false, children: [], listeners: {},
  addEventListener(name, callback) { this.listeners[name] = callback; },
  replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
  focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
});

test('district picker selects every group, opens modal and submits only remaining groups', async () => {
  const html = await ejs.renderFile('src/views/officer-announcement-new.ejs', {
    title: '連絡', assetVersion: 'test', currentUser: null, currentPath: '', notice: null,
    csrfToken: 'token', association: { _id: 'a' }, districtGroups: [
      { _id: 'district', name: '東地区' }, { _id: 'one', name: '1班', parentDistrict: 'district' },
      { _id: 'two', name: '2班', parentDistrict: 'district' }
    ]
  });
  assert.match(html, /data-group-check checked> 1班/);
  assert.match(html, /data-open-district-dialog>東地区/);
  const scope = element('selected'); scope.form = element();
  const check = element('district'), groups = [element('one'), element('two')];
  const dialog = element(), summary = element(), opener = element(), closer = element();
  const row = { querySelector: selector => ({ '[data-district-check]': check, dialog,
    '[data-district-summary]': summary, '[data-open-district-dialog]': opener })[selector],
    querySelectorAll: selector => selector === '[data-group-check]' ? groups : [closer] };
  const fieldset = element(); fieldset.querySelectorAll = () => [row];
  const targets = element();
  const document = { getElementById: key => ({ 'announcement-recipient-scope': scope,
    'announcement-district-groups': fieldset, 'announcement-target-inputs': targets })[key], createElement: () => element() };
  const alerts = [];
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(source => source.includes('announcement-target-inputs'));
  vm.runInNewContext(script, { document, alert: message => alerts.push(message) });
  check.checked = true; check.listeners.change();
  assert.ok(groups.every(group => group.checked));
  assert.deepEqual(targets.children.map(input => input.value), ['district']);
  opener.listeners.click(); assert.equal(dialog.open, true);
  groups[1].checked = false; groups[1].listeners.change();
  assert.deepEqual(targets.children.map(input => input.value), ['one']);
  assert.equal(summary.textContent, '1 / 2班を対象');
  closer.listeners.click(); assert.equal(dialog.open, false);
  groups[0].checked = false; groups[0].listeners.change();
  let prevented = false;
  scope.form.listeners.submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(alerts.length, 1);
  check.checked = false; check.listeners.change();
  assert.equal(targets.children.length, 0);
  check.checked = true; check.listeners.change();
  assert.ok(groups.every(group => group.checked));
  scope.value = 'all'; scope.listeners.change();
  assert.equal(targets.children.length, 0); assert.equal(check.disabled, true);
});
