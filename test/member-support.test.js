import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { parseMemberSupport, saveMemberSupport } from '../src/services/memberSupportService.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';

const associationId = 'aaaaaaaaaaaaaaaaaaaaaaaa', householdId = 'bbbbbbbbbbbbbbbbbbbbbbbb', memberId = 'cccccccccccccccccccccccc';
test('support stores only the flag and priority, clears priority for no and removes opt-in data', () => {
  assert.deepEqual(parseMemberSupport({supportRequired:'yes',supportPriority:'2',diagnosis:'ignored'}), {$set:{supportRequired:true,supportPriority:2}});
  assert.deepEqual(parseMemberSupport({supportRequired:'no',supportPriority:'1'}), {$set:{supportRequired:false},$unset:{supportPriority:1}});
  assert.deepEqual(parseMemberSupport({supportRequired:'unregistered'}), {$unset:{supportRequired:1,supportPriority:1}});
  for (const supportPriority of [undefined,'0','4','1.5','01', ['1']]) assert.throws(()=>parseMemberSupport({supportRequired:'yes',supportPriority}), {status:400});
  assert.throws(()=>parseMemberSupport({}), {status:400});
});
test('only the member or representative of an unlinked member may save; membership is required', async t => {
  let member = {user:'self'}, representative = 'head', active = true, updates = [];
  t.mock.method(Household,'findOne',async ()=>({representative}));
  t.mock.method(HouseholdMember,'findOne',async ()=>member);
  t.mock.method(NeighborhoodAssociation,'exists',async ()=>true);
  t.mock.method(AssociationMembership,'exists',async ()=>active);
  t.mock.method(HouseholdMember,'updateOne',async (filter,change)=>updates.push({filter,change}));
  const save = actorId => saveMemberSupport({associationId,householdId,memberId,actorId,values:{supportRequired:'yes',supportPriority:'1'}});
  await save('self');
  await assert.rejects(save('head'),{status:403});
  member = {};
  await save('head');
  await assert.rejects(save('outsider'),{status:403});
  active = false;
  await assert.rejects(save('head'),{status:403});
  assert.equal(updates.length,2);
  assert.deepEqual(updates[0].filter,{_id:memberId,household:householdId,association:associationId,endsAt:null});
});
test('support modal renders opt-in state, toggle and all criteria without collecting medical details', async ()=>{
  const render = member => ejs.renderFile('src/views/partials/member-support.ejs',{member:{_id:memberId,name:'家族',...member},associationId,householdId,canEdit:true,csrfToken:'csrf'});
  const html = await render({});
  assert.match(html,/未登録/);
  assert.match(html,/role="switch"/);
  assert.match(html,/hidden disabled/);
  assert.match(html,/要介護3〜5/);
  assert.match(html,/妊産婦や乳幼児/);
  assert.match(html,/避難所到着以降/);
  assert.match(html,/value="unregistered"/);
  assert.doesNotMatch(html,/<textarea/);
  assert.match(await render({supportRequired:true,supportPriority:3}),/value="3" required checked/);
});

test('support registration requires CSRF verification', async () => {
  const { householdsRouter } = await import('../src/routes/households.js');
  const { verifyCsrfToken } = await import('../src/middleware/csrf.js');
  const route = householdsRouter.stack.find(layer => layer.route?.path === '/:associationId/household/:householdId/members/:memberId/support').route;
  assert.equal(route.stack[0].handle, verifyCsrfToken);
});
