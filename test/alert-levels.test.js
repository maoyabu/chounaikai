import mongoose from 'mongoose';
import { AlertEvent } from '../src/models/alertEvent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { loadAlertLevelOfficer, parseAlertLevel, saveAlertLevel } from '../src/services/alertLevelService.js';
import { alertLevels } from '../src/public/alert-level-data.js';
import { alertLevelsRouter } from '../src/routes/alertLevels.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';

mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const associationId = 'aaaaaaaaaaaaaaaaaaaaaaaa', userId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const query = value => ({ select() { return this; }, lean: async () => value });
const stubAccess = (t, { officer = true, manager = false, member = true, active = true } = {}) => {
  t.mock.method(AlertEvent, 'findOne', () => query(null));
  t.mock.method(AlertEvent, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(NeighborhoodAssociation, 'findOne', filter => { assert.equal(filter._id, associationId); assert.equal(filter.status, 'active'); assert.deepEqual(filter.deletedAt, {$exists:false}); return query(active ? {_id:associationId, name:'第一町内会'} : null); });
  t.mock.method(AssociationMembership, 'findOne', filter => { assert.equal(filter.user, userId); assert.equal(filter.association, associationId); assert.equal(filter.status, 'active'); return query(member ? {_id:'membership'} : null); });
  t.mock.method(RoleDefinition, 'find', () => query(manager ? [{_id:'manager-role'}] : []));
  t.mock.method(AnnualOfficer, 'exists', async () => officer);
  t.mock.method(RoleAssignment, 'exists', async () => manager);
};

test('alert levels accept 1–5 or explicit removal; malformed and missing input is rejected', () => {
  for (let level = 0; level <= 5; level++) assert.equal(parseAlertLevel(String(level)), level);
  for (const value of ['', undefined, null, 3, '6', '-1', '1.5', '03', ' 3', ['3'], {}, 'NaN']) assert.throws(() => parseAlertLevel(value), {status:400});
  assert.equal(new NeighborhoodAssociation().alertLevel, 0);
  assert.ok(new NeighborhoodAssociation({alertLevel:6}).validateSync().errors.alertLevel);
});

test('current officers save a tenant-scoped level and attribution, then can clear it', async t => {
  stubAccess(t);
  const updates = [];
  t.mock.method(NeighborhoodAssociation, 'updateOne', async (filter, update, options) => { updates.push({filter,update,options}); return {matchedCount:1}; });
  assert.equal(await saveAlertLevel({associationId,userId,value:'4'}), 4);
  assert.equal(await saveAlertLevel({associationId,userId,value:'0'}), 0);
  for (const {filter,update,options} of updates) {
    assert.equal(filter._id, associationId);
    assert.equal(filter.status, 'active');
    assert.deepEqual(filter.deletedAt, {$exists:false});
    assert.equal(update.$set.alertLevelUpdatedBy, userId);
    assert.ok(update.$set.alertLevelUpdatedAt instanceof Date);
    assert.equal(options.runValidators, true);
  }
  assert.equal(updates[1].update.$set.alertLevel, 0);
});

test('association managers can register even without an annual officer role', async t => {
  stubAccess(t, {officer:false, manager:true});
  assert.equal((await loadAlertLevelOfficer(associationId,userId))._id, associationId);
});

for (const [name, options] of [['ordinary residents', {officer:false}], ['non-members', {member:false}], ['inactive associations', {active:false}]]) {
  test(`${name} cannot register warning levels`, async t => {
    stubAccess(t, options);
    const update = t.mock.method(NeighborhoodAssociation, 'updateOne', async () => { throw new Error('must not write'); });
    await assert.rejects(saveAlertLevel({associationId,userId,value:'5'}), {status:403});
    assert.equal(update.mock.callCount(),0);
  });
}

test('removed association during save does not report success', async t => {
  stubAccess(t);
  t.mock.method(NeighborhoodAssociation,'updateOne',async()=>({matchedCount:0}));
  await assert.rejects(saveAlertLevel({associationId,userId,value:'3'}), {status:409});
});

test('both warning endpoints require login and saves require CSRF', () => {
  assert.equal(alertLevelsRouter.stack[0].handle, requireLogin);
  const post = alertLevelsRouter.stack.find(layer => layer.route?.methods.post).route;
  assert.equal(post.stack[0].handle, verifyCsrfToken);
});

const home = memberships => ejs.renderFile('src/views/partials/hazard-map-home.ejs', {memberships});
test('warning appears to the left of hazard map, works without a map and disappears on removal', async () => {
  const html = await home([{association:{_id:associationId,name:'第一町内会',alertLevel:4,hazardMapUrl:'https://disaportal.gsi.go.jp/'}}]);
  assert.ok(html.indexOf('data-alert-open=') < html.indexOf('class="button hazard-map-button"'));
  assert.match(html,/alert-level-color-4/);
  assert.match(html,/警戒レベル4<\/button>/);
  const onlyWarning = await home([{association:{_id:associationId,name:'第一町内会',alertLevel:3}}]);
  assert.match(onlyWarning,/警戒レベル3/);
  assert.doesNotMatch(onlyWarning,/hazard-map-button/);
  const cleared = await home([{association:{_id:associationId,name:'第一町内会',alertLevel:0,alertLevelUpdatedAt:new Date(),hazardMapUrl:'https://disaportal.gsi.go.jp/'}}]);
  assert.match(cleared, /alert-level-none/);
  assert.match(cleared, /警戒情報なし<\/span>/);
  assert.ok(cleared.indexOf('alert-level-none') < cleared.indexOf('hazard-map-button'));
  assert.doesNotMatch(cleared, /data-alert-open|safety-register-button/);
  const withoutMap = await home([{association:{alertLevel:0,alertLevelUpdatedAt:new Date()}}]);
  assert.match(withoutMap, /警戒情報なし/);
  for (const alertLevel of [0,undefined,6,'4']) assert.equal((await home([{association:{alertLevel}}])).trim(),'');
});

test('all five levels open matching detailed dialogs with unique association-specific IDs', async () => {
  const html = await ejs.renderFile('src/views/partials/alert-level-dialogs.ejs', {alertLevels,memberships:[{association:{_id:associationId,name:'第一町内会',alertLevel:5}},{association:{_id:userId,name:'第二町内会',alertLevel:2}},{association:{_id:'cleared',alertLevel:0}}]});
  assert.doesNotMatch(html,/alert-guide-cleared/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length,new Set(ids).size);
  for (const item of alertLevels) {
    assert.match(html,new RegExp(`id="alert-guide-${associationId}-level-${item.level}"`));
    assert.match(html,new RegExp(`data-alert-detail="alert-guide-${associationId}-level-${item.level}"`));
    assert.ok(html.includes(item.guidance));
  }
  assert.match(html,/images\/alert-levels.jpg/);
  const image = await readFile('src/public/images/alert-levels.jpg');
  assert.deepEqual([...image.subarray(0,3)], [0xff, 0xd8, 0xff]);
});

test('officer registration page renders saved level and explicit removal', async () => {
  const html = await ejs.renderFile('src/views/association-alert-level.ejs', {alertLevels,association:{_id:associationId,name:'町内会',alertLevel:3},title:'警戒レベル',assetVersion:'test',notice:null,currentPath:'/',currentUser:null,csrfToken:'csrf',showNotificationPrompt:false});
  assert.match(html,/value="3" selected/);
  assert.match(html,/value="0"/);
  assert.match(html,/name="_csrf" value="csrf"/);
});

test('overview and detail buttons open their own dialogs and closing a detail keeps the overview open', async () => {
  const node = (dataset = {}) => ({ dataset, events: {}, addEventListener(type, handler) { this.events[type] = handler; } });
  const overview = Object.assign(node(), { open:false, showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect() { return {left:10,right:200,top:10,bottom:200}; } });
  const detail = Object.assign(node(), { open:false, showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect:overview.getBoundingClientRect });
  const open = node({alertOpen:'overview'}), more = node({alertDetail:'detail'}), close = node();
  close.closest = () => detail;
  const document = {
    querySelectorAll(selector) { return selector.includes('[data-alert-open]') ? [open,more] : selector === '[data-alert-close]' ? [close] : [overview,detail]; },
    getElementById(id) { return id === 'overview' ? overview : detail; }
  };
  vm.runInNewContext(await readFile('src/public/alert-levels.js','utf8'), {document});
  open.events.click();
  more.events.click();
  assert.equal(overview.open,true);
  assert.equal(detail.open,true);
  overview.events.click({target:detail,clientX:0,clientY:0});
  assert.equal(overview.open,true);
  close.events.click();
  assert.equal(detail.open,false);
  assert.equal(overview.open,true);
  overview.events.click({target:overview,clientX:50,clientY:50});
  assert.equal(overview.open,true);
  overview.events.click({target:overview,clientX:0,clientY:0});
  assert.equal(overview.open,false);
});
