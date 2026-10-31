import mongoose from 'mongoose';
import { AlertEvent } from '../src/models/alertEvent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { SafetyReport } from '../src/models/safetyReport.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { parseSafetyReport, loadResidentSafety, saveResidentSafety, attachDashboardSafety, loadOfficerSafety } from '../src/services/safetyService.js';
import { saveAlertLevel } from '../src/services/alertLevelService.js';
import { householdSafetyState, memberSafetyStatus, summarizeSafety, safetyStatuses, buildingStatuses, safetyEventKey } from '../src/lib/safetyStatus.js';
import { safetyRouter } from '../src/routes/safety.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
const ids = { association:'aaaaaaaaaaaaaaaaaaaaaaaa', user:'bbbbbbbbbbbbbbbbbbbbbbbb', household:'cccccccccccccccccccccccc', one:'111111111111111111111111', two:'222222222222222222222222', other:'dddddddddddddddddddddddd' };
const association = {_id:ids.association,name:'第一町内会',alertLevel:3,safetyEventKey:'event-one'};
const household = {_id:ids.household,association:ids.association,displayName:'第一世帯',districtGroup:{name:'一班'},address:{street:'一丁目'}};
const members = [{_id:ids.one,association:ids.association,household:ids.household,name:'家族一',supportRequired:true,supportPriority:2},{_id:ids.two,association:ids.association,household:ids.household,name:'家族二'}];
const query = value => ({select(){return this;},populate(){return this;},sort(){return this;},lean:async()=>value});
const resident = (t, options={}) => {
  t.mock.method(NeighborhoodAssociation,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(NeighborhoodAssociation,'findOne',filter=>{assert.equal(filter._id,ids.association);assert.equal(filter.status,'active');return query(options.association === null ? null : options.association || association);});
  t.mock.method(AssociationMembership,'findOne',filter=>{assert.equal(filter.user,ids.user);assert.equal(filter.status,'active');return query(options.membership === null ? null : {household:ids.household});});
  t.mock.method(Household,'findOne',filter=>{assert.equal(filter._id,ids.household);assert.equal(filter.association,ids.association);assert.equal(filter.active,true);assert.deepEqual(filter.deletedAt,{$exists:false});return query(options.household === null ? null : household);});
  t.mock.method(HouseholdMember,'find',filter=>{assert.equal(filter.household,ids.household);assert.equal(filter.association,ids.association);assert.equal(filter.endsAt,null);return query(members);});
  t.mock.method(SafetyReport,'findOne',filter=>{assert.equal(filter.eventKey,(options.association || association).safetyEventKey);return query(options.report || null);});
};
const body = overrides => ({eventKey:'event-one',memberIds:[ids.one],[`status_${ids.one}`]:'1',...overrides});
const save = values => saveResidentSafety({associationId:ids.association,userId:ids.user,body:values});

test('selected family only is stored; missing building state defaults to safe',()=>{
  assert.deepEqual(parseSafetyReport(body(),members),{memberStatuses:{[ids.one]:1},buildingStatus:1});
  assert.deepEqual(parseSafetyReport({memberIds:ids.two,[`status_${ids.two}`]:'3',buildingStatus:'2'},members),{memberStatuses:{[ids.two]:3},buildingStatus:2});
  assert.deepEqual(parseSafetyReport({[`status_${ids.one}`]:'1'},members),{memberStatuses:{},buildingStatus:1});
  assert.throws(()=>parseSafetyReport({memberIds:[ids.other],[`status_${ids.other}`]:'1'},members),{status:403});
  for (const value of ['0','5',undefined,['1']]) assert.throws(()=>parseSafetyReport(body({[`status_${ids.one}`]:value}),members),{status:400});
  for (const buildingStatus of ['0','5',1,{}]) assert.throws(()=>parseSafetyReport({buildingStatus},members),{status:400});
  assert.throws(()=>parseSafetyReport({memberIds:[ids.one,ids.one]},members),{status:400});
});

test('completion is based on every current family member, never on building state or an empty family',()=>{
  const partial={memberStatuses:{[ids.one]:1},buildingStatus:1};
  assert.deepEqual(householdSafetyState(members,partial),{total:2,confirmed:1,complete:false});
  assert.equal(householdSafetyState(members,{memberStatuses:{[ids.one]:4,[ids.two]:2}}).complete,true);
  assert.equal(householdSafetyState([],null).complete,false);
  assert.equal(memberSafetyStatus({memberStatuses:new Map([[ids.one,3]])},ids.one),3);
  assert.equal(memberSafetyStatus({memberStatuses:{[ids.one]:0}},ids.one),null);
});

test('report schema validates classifications and uniquely identifies household within an event',()=>{
  const report=new SafetyReport({association:ids.association,household:ids.household,eventKey:'one',updatedBy:ids.user,memberStatuses:{[ids.one]:5}});
  assert.ok(report.validateSync());
  assert.ok(SafetyReport.schema.indexes().some(([keys,options])=>options.unique && keys.association && keys.eventKey && keys.household));
});

test('resident access reads only their household and event',async t=>{
  resident(t);
  const result=await loadResidentSafety(ids.association,ids.user);
  assert.equal(result.household,household);
  assert.equal(result.members,members);
});

test('non-members and inactive associations cannot read or submit any household report',async t=>{
  resident(t,{membership:null});
  await assert.rejects(save(body()),{status:403});
  assert.equal(Household.findOne.mock.callCount(),0);
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query(null));
  await assert.rejects(loadResidentSafety(ids.association,ids.user),{status:403});
});

test('missing household is shown as unregistered and cannot be replaced by a forged household ID',async t=>{
  resident(t,{household:null});
  assert.equal((await loadResidentSafety(ids.association,ids.user)).household,null);
  await assert.rejects(save(body({householdId:ids.other})),{status:400});
});

test('saves merge selected members atomically without overwriting unchecked family reports',async t=>{
  resident(t,{report:{memberStatuses:{[ids.two]:2}}});
  const writes=[];
  t.mock.method(SafetyReport,'updateOne',async(...args)=>{writes.push(args);return {matchedCount:1};});
  await save(body({buildingStatus:'3',householdId:ids.other}));
  const [filter,update,options]=writes[0];
  assert.deepEqual(filter,{association:ids.association,eventKey:'event-one',household:ids.household});
  assert.equal(update.$set[`memberStatuses.${ids.one}`],1);
  assert.equal(update.$set.buildingStatus,3);
  assert.equal(update.$set.updatedBy,ids.user);
  assert.equal(update.$set.memberStatuses,undefined);
  assert.equal(update.$set[`memberStatuses.${ids.two}`],undefined);
  assert.equal(options.upsert,true);
  assert.equal(options.runValidators,true);
});

test('simultaneous first submissions retry duplicate key with a merge instead of losing reports',async t=>{
  resident(t);
  let count=0;
  t.mock.method(SafetyReport,'updateOne',async(_filter,_change,options)=>{if(!count++){assert.equal(options.upsert,true);throw Object.assign(new Error('duplicate'),{code:11000});}assert.equal(options.upsert,undefined);});
  await save(body());
  assert.equal(count,2);
});

test('a cleared alert or a stale event submission never saves to the new disaster',async t=>{
  resident(t);
  const update=t.mock.method(SafetyReport,'updateOne',async()=>{});
  await assert.rejects(save(body({eventKey:'old-event'})),{status:409});
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query({...association,alertLevel:0}));
  await assert.rejects(save(body()),{status:409});
  assert.equal(update.mock.callCount(),0);
});

test('summary counts partial households, every classification, support and damage without ended or unrelated residents',()=>{
  const second={...household,_id:ids.other,displayName:'第二世帯'};
  const extra=[{_id:'three',household:ids.other,name:'三',supportRequired:true,supportPriority:1},{_id:'four',household:ids.other,name:'四'},{_id:'ended',household:ids.other,endsAt:new Date()},{_id:'foreign',household:'elsewhere'}];
  const reports=[{household:ids.household,memberStatuses:{[ids.one]:1,[ids.two]:2},buildingStatus:3},{household:ids.other,memberStatuses:{three:3,four:4,ended:1},buildingStatus:2}];
  const full=summarizeSafety([household,second],members.concat(extra),reports);
  assert.equal(full.totalPeople,4);
  assert.equal(full.confirmedHouseholds,2);
  assert.deepEqual(full.people,{1:1,2:1,3:1,4:1});
  assert.deepEqual(full.buildings,{2:1,3:1,4:0});
  assert.equal(full.supportHouseholds,2);
  assert.equal(full.supportPeople,2);
  assert.equal(full.supportMembers[0].member.supportPriority,1);
  assert.equal(full.damagedHouseholds.length,2);
  const partial=summarizeSafety([household,second],members.concat(extra),[{household:ids.household,memberStatuses:{[ids.one]:1}}]);
  assert.equal(partial.confirmedHouseholds,0);
  assert.equal(partial.unconfirmedHouseholds,2);
  assert.equal(partial.confirmedPeople,1);
  assert.equal(partial.unconfirmedPeople,3);
  assert.deepEqual(partial.buildings,{2:0,3:0,4:0});
});

test('home completion ignores previous events and excludes other households and associations',async t=>{
  const memberships=[{association,household:ids.household}];
  t.mock.method(Household,'find',()=>query([household]));
  t.mock.method(HouseholdMember,'find',()=>query(members));
  t.mock.method(SafetyReport,'find',()=>query([{association:ids.association,household:ids.household,eventKey:'old',memberStatuses:{[ids.one]:1,[ids.two]:1}},{association:ids.other,household:ids.household,eventKey:'event-one',memberStatuses:{[ids.one]:1,[ids.two]:1}}]));
  await attachDashboardSafety(memberships);
  assert.equal(memberships[0].safetyState.complete,false);
  SafetyReport.find.mock.mockImplementation(()=>query([{association:ids.association,household:ids.household,eventKey:'event-one',memberStatuses:{[ids.one]:1,[ids.two]:1}}]));
  await attachDashboardSafety(memberships);
  assert.equal(memberships[0].safetyState.complete,true);
});

const officerAccess=(t,officer)=>{
  t.mock.method(AlertEvent,'findOne',()=>query(null));
  t.mock.method(AlertEvent,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(Household,'find',()=>query([]));
  t.mock.method(HouseholdMember,'find',()=>query([]));
  t.mock.method(SafetyReport,'find',()=>query([]));
  t.mock.method(NeighborhoodAssociation,'findOne',()=>query(association));
  t.mock.method(AssociationMembership,'findOne',()=>query({household:ids.household}));
  t.mock.method(RoleDefinition,'find',()=>query([]));
  t.mock.method(AnnualOfficer,'exists',async()=>officer);
  t.mock.method(RoleAssignment,'exists',async()=>false);
};
test('ordinary residents cannot access officer summaries or support lists',async t=>{
  officerAccess(t,false);
  const read=t.mock.method(Household,'find',()=>{throw new Error('must not read');});
  await assert.rejects(loadOfficerSafety(ids.association,ids.user),{status:403});
  assert.equal(read.mock.callCount(),0);
});
test('officer summaries are restricted to active households in their association and current event',async t=>{
  officerAccess(t,true);
  t.mock.method(Household,'find',filter=>{assert.equal(filter.association,ids.association);assert.equal(filter.active,true);assert.deepEqual(filter.deletedAt,{$exists:false});return query([household]);});
  t.mock.method(HouseholdMember,'find',filter=>{assert.equal(filter.association,ids.association);assert.equal(filter.endsAt,null);return query(members);});
  t.mock.method(SafetyReport,'find',filter=>{assert.equal(filter.association,ids.association);assert.equal(filter.eventKey,'event-one');return query([]);});
  const result=await loadOfficerSafety(ids.association,ids.user);
  assert.equal(result.summary.unconfirmedPeople,2);
  assert.equal(result.summary.supportPeople,1);
});

test('new alert activation starts a new event while changing and clearing levels preserve its key',async t=>{
  officerAccess(t,true);
  let current={...association,alertLevel:0};
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query(current));
  const changes=[];
  t.mock.method(NeighborhoodAssociation,'updateOne',async(filter,update)=>{changes.push({filter,update});return {matchedCount:1};});
  await saveAlertLevel({associationId:ids.association,userId:ids.user,value:'2'});
  const event=changes[0].update.$set.safetyEventKey;
  assert.ok(event && event !== 'event-one');
  current={...current,alertLevel:2,safetyEventKey:event};
  await saveAlertLevel({associationId:ids.association,userId:ids.user,value:'4'});
  assert.equal(changes[1].update.$set.safetyEventKey,undefined);
  assert.equal(changes[1].filter.alertLevel,2);
  await saveAlertLevel({associationId:ids.association,userId:ids.user,value:'0'});
  assert.equal(changes[2].update.$set.safetyEventKey,undefined);
  current={...current,alertLevel:0};
  await saveAlertLevel({associationId:ids.association,userId:ids.user,value:'1'});
  assert.notEqual(changes[3].update.$set.safetyEventKey,event);
});

test('all safety routes require login and report mutations require CSRF',()=>{
  assert.equal(safetyRouter.stack[0].handle,requireLogin);
  assert.equal(safetyRouter.stack.find(layer=>layer.route?.methods.post).route.stack[0].handle,verifyCsrfToken);
});

const locals={title:'安否',assetVersion:'test',currentUser:null,currentPath:'/',notice:null,csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true,safetyStatuses,buildingStatuses,safetyEventKey,memberSafetyStatus,householdSafetyState};
test('registration shows unknown people unchecked with disabled default-safe selectors',async()=>{
  const html=await ejs.renderFile('src/views/safety-register.ejs',{...locals,association,household,members,report:null});
  assert.match(html,/name="memberIds"/);
  assert.doesNotMatch(html,/data-safety-confirmed checked/);
  assert.match(html,/value="1" selected>無事（軽傷含む）/);
  assert.match(html,/data-safety-select disabled/);
  assert.match(html,/name="eventKey" value="event-one"/);
  assert.match(html,/name="_csrf" value="csrf"/);
  assert.match(html,/行方不明者・生き埋め/);
});
test('officer page renders all four sections and relevant support/damage lists with escaped names',async()=>{
  const unsafe={...members[0],name:'<script>bad</script>'};
  const summary=summarizeSafety([household],[unsafe,members[1]],[{household:ids.household,memberStatuses:{[ids.one]:2},buildingStatus:4}]);
  const html=await ejs.renderFile('src/views/safety-officer.ejs',{...locals,association,summary});
  for(const title of ['1. 全体状況','2. 住民の被害状況','3. 要配慮者の状況','4. 建物・ライフラインの被害状況']) assert.ok(html.includes(title));
  assert.match(html,/要支援者のリスト（1人）/);
  assert.match(html,/被害発生世帯のリスト（1世帯）/);
  assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);
});
test('home warning entry includes safety completion without a separate registration button',async()=>{
  const render=complete=>ejs.renderFile('src/views/partials/hazard-map-home.ejs',{memberships:[{association,safetyState:{complete}}]});
  const html=await render(false);
  assert.match(html,/警戒レベル3・安否登録<\/span>/);
  const completed=await render(true);
  assert.match(completed,/警戒レベル3・安否登録完了<\/span>/);
  assert.equal((completed.match(/<a /g)||[]).length,1);
  assert.match(completed,/alert-level-color-3/);
});
test('family selection enables status only when explicitly checked',async()=>{
  const checkbox={checked:false,addEventListener(type,fn){this.change=fn;}};
  const select={disabled:false};
  const row={querySelector:selector=>selector==='[data-safety-confirmed]'?checkbox:select};
  vm.runInNewContext(await readFile('src/public/safety.js','utf8'),{document:{querySelectorAll:()=>[row]}});
  assert.equal(select.disabled,true);
  checkbox.checked=true;checkbox.change();assert.equal(select.disabled,false);
  checkbox.checked=false;checkbox.change();assert.equal(select.disabled,true);
});

test('without an active alert only roster and support totals are calculated; previous reports are never read',async t=>{
  officerAccess(t,true);
  const normal={...association,alertLevel:0};
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query(normal));
  Household.find.mock.mockImplementation(()=>query([household]));
  HouseholdMember.find.mock.mockImplementation(()=>query(members));
  SafetyReport.find.mock.mockImplementation(()=>{throw new Error('must not read the previous disaster');});
  const context=await loadOfficerSafety(ids.association,ids.user);
  assert.equal(SafetyReport.find.mock.callCount(),0);
  assert.equal(context.summary.totalHouseholds,1);assert.equal(context.summary.totalPeople,2);
  assert.equal(context.summary.supportHouseholds,1);assert.equal(context.summary.supportPeople,1);
  assert.equal(context.summary.confirmedPeople,'-');assert.equal(context.summary.unconfirmedPeople,'-');
  assert.deepEqual(context.summary.people,{1:'-',2:'-',3:'-',4:'-'});
  assert.deepEqual(context.summary.buildings,{2:'-',3:'-',4:'-'});
  const html=await ejs.renderFile('src/views/safety-officer.ejs',{...locals,...context});
  assert.match(html,/<th scope="row">安否確認済数<\/th><td>-<\/td><td>-<\/td>/);
  assert.match(html,/<dt>無事（軽傷含む）<\/dt><dd>-<\/dd>/);
  assert.doesNotMatch(html,/直近の登録状況|被害発生世帯のリスト/);
});
