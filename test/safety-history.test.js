import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import { AlertEvent } from '../src/models/alertEvent.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { SafetyReport } from '../src/models/safetyReport.js';
import { saveAlertLevel } from '../src/services/alertLevelService.js';
import { saveResidentSafety } from '../src/services/safetyService.js';
import { listAlertHistory, listSafetyHistory, loadAlertHistory, loadSafetyHistory } from '../src/services/safetyHistoryService.js';
import { buildingStatuses, safetyStatuses } from '../src/lib/safetyStatus.js';
import { decryptPersonalData } from '../src/security/personalDataCrypto.js';

mongoose.connection.db = {admin:()=>({command:async()=>({})})};
const aid='aaaaaaaaaaaaaaaaaaaaaaaa', uid='bbbbbbbbbbbbbbbbbbbbbbbb', hid='cccccccccccccccccccccccc', mid='dddddddddddddddddddddddd';
const key='11111111-1111-4111-8111-111111111111';
const query=value=>({select(){return this;},populate(){return this;},sort(){return this;},lean:async()=>value});
const base={_id:aid,name:'第一町内会',alertLevel:3,alertRevision:1,safetyEventKey:key};
const snapshot={households:[{_id:hid,displayName:'当時の世帯',address:{street:'当時の住所'},districtGroup:{name:'当時の班'}}],members:[{_id:mid,household:hid,name:'当時の家族',supportRequired:true,supportPriority:1}],reports:[{household:hid,memberStatuses:{[mid]:2},buildingStatus:3}]};
function access(t,association=base,canAnswer=true){
  t.mock.method(NeighborhoodAssociation,'findOne',()=>query(association));
  t.mock.method(AssociationMembership,'findOne',()=>query({household:hid}));
  t.mock.method(RoleDefinition,'find',()=>query([]));
  t.mock.method(RoleAssignment,'exists',async()=>false);
  t.mock.method(AnnualOfficer,'exists',async()=>canAnswer);
}
function roster(t){
  t.mock.method(Household,'find',()=>query(snapshot.households));
  t.mock.method(HouseholdMember,'find',()=>query(snapshot.members));
  t.mock.method(SafetyReport,'find',()=>query(snapshot.reports));
}

test('activation, rise, fall and release are one dated event; next activation starts another',async t=>{
  let association={...base,alertLevel:0,alertRevision:0}, events=new Map();
  access(t);
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query({...association}));
  roster(t);
  t.mock.method(NeighborhoodAssociation,'updateOne',async(filter,change)=>{
    assert.equal(filter.alertRevision,association.alertRevision);
    assert.equal(filter.safetyEventKey,association.safetyEventKey);
    Object.assign(association,change.$set);association.alertRevision++;
    return {matchedCount:1};
  });
  t.mock.method(AlertEvent,'findOne',filter=>query(events.get(filter.eventKey)||null));
  t.mock.method(AlertEvent,'updateOne',async(filter,change)=>{
    const event=events.get(filter.eventKey)||{...change.$setOnInsert,_id:filter._id,changes:[],peakLevel:0};
    event.changes.push(...change.$push.changes.$each);
    event.peakLevel=Math.max(event.peakLevel,change.$max.peakLevel);
    Object.assign(event,change.$set);events.set(filter.eventKey,event);
    return {matchedCount:1};
  });
  for(const [value,name] of [['1','役員A'],['4','役員B'],['2','役員C'],['0','役員D']]) await saveAlertLevel({associationId:aid,userId:uid,value,actorName:name});
  assert.equal(events.size,1);
  const oldKey=association.safetyEventKey, event=events.get(oldKey);
  assert.deepEqual(event.changes.map(c=>c.level),[1,4,2,0]);
  assert.deepEqual(event.changes.map(c=>c.byName),['役員A','役員B','役員C','役員D']);
  assert.ok(event.changes.every(c=>c.at instanceof Date && c.by===uid));
  assert.equal(event.peakLevel,4);
  assert.deepEqual(event.changes.map(c=>Boolean(c.noticePending)),[true,true,false,false]);
  assert.notEqual(event.changes[0].noticeKey,event.changes[1].noticeKey);
  assert.equal(event.endedAt,event.changes[3].at);
  assert.equal(JSON.parse(event.safetySnapshot).members[0].name,'当時の家族');
  await saveAlertLevel({associationId:aid,userId:uid,value:'3',actorName:'役員E'});
  assert.equal(events.size,2);
  assert.notEqual(association.safetyEventKey,oldKey);
  assert.deepEqual(events.get(association.safetyEventKey).changes.map(c=>c.level),[3]);
  assert.equal(events.get(oldKey).changes.length,4);
});

test('existing active warning is carried forward with an incomplete-history marker',async t=>{
  access(t,{...base,alertLevelUpdatedAt:new Date('2026-10-30T00:00:00Z'),alertLevelUpdatedBy:uid});
  t.mock.method(NeighborhoodAssociation,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(AlertEvent,'findOne',()=>query(null));
  const write=t.mock.method(AlertEvent,'updateOne',async()=>({matchedCount:1}));
  await saveAlertLevel({associationId:aid,userId:uid,value:'4',actorName:'役員'});
  const change=write.mock.calls[0].arguments[1];
  assert.equal(change.$setOnInsert.historyIncomplete,true);
  assert.deepEqual(change.$push.changes.$each.map(c=>c.kind),['carried','changed']);
  assert.equal(change.$push.changes.$each[0].at.toISOString(),'2026-10-30T00:00:00.000Z');
});

test('archive failure rolls back the standalone warning update instead of silently losing history',async t=>{
  access(t);
  t.mock.method(AlertEvent,'findOne',()=>query({_id:hid,startedAt:new Date()}));
  t.mock.method(AlertEvent,'updateOne',async()=>{throw new Error('archive failed');});
  const updates=[];
  t.mock.method(NeighborhoodAssociation,'updateOne',async(filter,change)=>{updates.push({filter,change});return {matchedCount:1};});
  await assert.rejects(saveAlertLevel({associationId:aid,userId:uid,value:'4'}),/archive failed/);
  assert.equal(updates.length,2);
  assert.equal(updates[1].filter.alertRevision,2);
  assert.equal(updates[1].change.$set.alertLevel,3);
  assert.equal(updates[1].change.$set.safetyEventKey,key);
});

test('stale warning writers and late safety submissions do not change an archived disaster',async t=>{
  access(t);
  t.mock.method(NeighborhoodAssociation,'updateOne',async()=>({matchedCount:0}));
  const archive=t.mock.method(AlertEvent,'findOne',()=>{throw new Error('must not read');});
  await assert.rejects(saveAlertLevel({associationId:aid,userId:uid,value:'0'}),{status:409});
  assert.equal(archive.mock.callCount(),0);
  t.mock.method(Household,'findOne',()=>query({_id:hid}));
  t.mock.method(HouseholdMember,'find',()=>query([{_id:mid}]));
  t.mock.method(SafetyReport,'findOne',()=>query(null));
  const report=t.mock.method(SafetyReport,'updateOne',async()=>{});
  await assert.rejects(saveResidentSafety({associationId:aid,userId:uid,body:{eventKey:key,memberIds:mid,[`status_${mid}`]:'1'}}),{status:409});
  assert.equal(report.mock.callCount(),0);
});

test('archived summary uses only the release snapshot, unaffected by later roster changes',async t=>{
  access(t);
  t.mock.method(AlertEvent,'findOne',filter=>{assert.equal(filter.association,aid);assert.equal(filter.eventKey,key);return query({eventKey:key,startedAt:new Date(),endedAt:new Date(),safetySnapshot:JSON.stringify(snapshot)});});
  const live=t.mock.method(Household,'find',()=>{throw new Error('must not read live roster');});
  const result=await loadSafetyHistory(aid,uid,key);
  assert.equal(result.historyMode,true);
  assert.equal(result.summary.confirmedPeople,1);
  assert.equal(result.summary.supportMembers[0].member.name,'当時の家族');
  assert.equal(result.summary.damagedHouseholds[0].household.address.street,'当時の住所');
  assert.equal(live.mock.callCount(),0);
});

test('history permission is checked before reading timeline, archive or old records',async t=>{
  access(t,base,false);
  const read=t.mock.method(AlertEvent,'find',()=>{throw new Error('must not read');});
  await assert.rejects(listAlertHistory(aid,uid),{status:403});
  await assert.rejects(loadAlertHistory(aid,uid,key),{status:403});
  await assert.rejects(loadSafetyHistory(aid,uid,key),{status:403});
  assert.equal(read.mock.callCount(),0);
});

test('history lookup is tenant scoped and missing or malformed event IDs return 404',async t=>{
  access(t);
  const find=t.mock.method(AlertEvent,'findOne',filter=>{assert.equal(filter.association,aid);assert.equal(filter.eventKey,key);return query(null);});
  await assert.rejects(loadAlertHistory(aid,uid,'../../other'),{status:404});
  assert.equal(find.mock.callCount(),0);
  await assert.rejects(loadAlertHistory(aid,uid,key),{status:404});
});

test('list excludes encrypted snapshots and retains legacy safety records with unknown warning dates',async t=>{
  access(t);
  let projection;
  t.mock.method(AlertEvent,'find',filter=>{assert.equal(filter.association,aid);const q=query([]);q.select=value=>{projection=value;return q;};return q;});
  t.mock.method(SafetyReport,'aggregate',async pipeline=>{assert.equal(String(pipeline[0].$match.association),aid);return [{_id:key,firstReportAt:new Date(),lastReportAt:new Date()}];});
  const result=await listSafetyHistory(aid,uid);
  assert.equal(projection,'-safetySnapshot');
  assert.equal(result.events[0].legacy,true);
  assert.equal(result.events[0].startedAt,undefined);
  assert.equal(result.events[0].endedAt,undefined);
});

test('legacy safety history retains reported counts even after a family was deleted',async t=>{
  access(t,{...base,alertLevel:0});
  t.mock.method(AlertEvent,'findOne',()=>query(null));
  t.mock.method(SafetyReport,'find',filter=>{assert.equal(filter.association,aid);assert.equal(filter.eventKey,key);return query(snapshot.reports);});
  t.mock.method(Household,'find',()=>query([]));
  t.mock.method(HouseholdMember,'find',()=>query([]));
  const result=await loadSafetyHistory(aid,uid,key);
  assert.equal(result.legacyHistory,true);
  assert.equal(result.people[2],1);
  assert.equal(result.legacyReports[0].family[0].name,'削除済みの家族');
});

test('model update encrypts the archived roster including addresses before storage',async t=>{
  const previous=process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  process.env.PERSONAL_DATA_ENCRYPTION_KEY='a'.repeat(64);
  t.after(()=>{if(previous===undefined)delete process.env.PERSONAL_DATA_ENCRYPTION_KEY;else process.env.PERSONAL_DATA_ENCRYPTION_KEY=previous;});
  let stored;
  t.mock.method(AlertEvent.collection,'updateOne',async(_filter,update)=>{stored=update.$set.safetySnapshot;return {matchedCount:1};});
  const id=new mongoose.Types.ObjectId();
  await AlertEvent.updateOne({_id:id},{$set:{safetySnapshot:JSON.stringify(snapshot)}});
  assert.match(stored,/^pii:v1:/);
  assert.ok(!stored.includes('当時の住所'));
  assert.equal(JSON.parse(decryptPersonalData(stored,'alert_events',id,'safetySnapshot')).households[0].address.street,'当時の住所');
});

const locals={title:'履歴',assetVersion:'test',currentUser:null,currentPath:'/',notice:null,csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true};
const event={eventKey:key,startedAt:new Date('2026-10-30T00:00:00Z'),endedAt:new Date('2026-10-30T03:00:00Z'),peakLevel:4,changes:[{level:2,at:new Date('2026-10-30T00:00:00Z'),byName:'<役員A>',kind:'registered'},{level:4,at:new Date('2026-10-30T01:00:00Z'),byName:'役員B',kind:'changed'},{level:0,at:new Date('2026-10-30T03:00:00Z'),byName:'役員C',kind:'cleared'}]};
test('history lists and timeline render actor names, changes, release and linked safety page',async()=>{
  const html=await ejs.renderFile('src/views/alert-history-detail.ejs',{...locals,association:base,event});
  assert.match(html,/&lt;役員A&gt;/);
  assert.match(html,/レベル変更/);
  assert.match(html,/役員C/);
  assert.match(html,/2026\/10\/30 12:00:00/);
  assert.match(html,new RegExp(`safety/officer/history/${key}`));
  for(const historyType of ['alert','safety']){
    const list=await ejs.renderFile('src/views/alert-history-list.ejs',{...locals,association:base,events:[event],historyType});
    assert.match(list,/登録者/);assert.match(list,/解除者/);
    assert.ok(list.includes(key));
  }
});
test('past safety page is read-only, identifies release time and links back to history',async t=>{
  access(t);
  t.mock.method(AlertEvent,'findOne',()=>query({...event,safetySnapshot:JSON.stringify(snapshot)}));
  const context=await loadSafetyHistory(aid,uid,key);
  const html=await ejs.renderFile('src/views/safety-officer.ejs',{...locals,...context,buildingStatuses,safetyStatuses});
  assert.match(html,/解除時点の安否状況/);
  assert.match(html,/過去の安否確認一覧/);
  assert.match(html,/当時の住所/);
  assert.doesNotMatch(html,/<form|安否情報を送信|最新の状況に更新/);
});

test('same level, lower level and release do not schedule another warning notice',async t=>{
  access(t);
  roster(t);
  t.mock.method(NeighborhoodAssociation,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(AlertEvent,'findOne',()=>query({_id:hid,startedAt:new Date(),changes:[]}));
  const changes=[];
  t.mock.method(AlertEvent,'updateOne',async(_filter,update)=>{changes.push(...update.$push.changes.$each);return {matchedCount:1};});
  for(const value of ['3','2','0']) await saveAlertLevel({associationId:aid,userId:uid,value});
  assert.ok(changes.every(change=>!change.noticePending && !change.noticeKey));
});
