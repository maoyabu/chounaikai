import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import fs from 'node:fs';
import { DistrictGroup, Household } from '../src/models/organization.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { JoinApplication } from '../src/models/workflow.js';
import { AuditLog } from '../src/models/auditLog.js';
import { LocationLinkRequest } from '../src/models/locationLinkRequest.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { Notification } from '../src/models/notification.js';
import { loadLocationLink, applyLocationLink, locationId } from '../src/services/locationLinkService.js';
import { handleLocationLink, locationLinksRouter } from '../src/routes/locationLinks.js';
import { annualRoleYear } from '../src/lib/annualRoleAccess.js';

const id = () => new mongoose.Types.ObjectId();
const equal = (a,b) => String(a || '') === String(b || '');
const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === '$or') return value.some(condition => match(row, condition));
  if (key === '$and') return value.every(condition => match(row, condition));
  const actual = row[key];
  if (value && typeof value === 'object' && !value._bsontype && !(value instanceof Date)) {
    return Object.entries(value).every(([op, v]) => op === '$in' ? v.some(item => equal(actual,item)) : op === '$ne' ? !equal(actual,v) : op === '$gte' ? actual >= v : op === '$exists' ? (actual !== undefined) === v : op === '$lte' ? actual <= v : false);
  }
  if (value === null) return actual == null;
  return equal(actual,value);
});
const query = value => ({ select() { return this; }, session() { return this; }, populate() { return this; }, sort() { return this; }, lean: async () => Array.isArray(value) ? value.map(row => ({ ...row })) : value && { ...value }, distinct: async field => value.map(row => row[field]), then(resolve,reject) { return Promise.resolve(value).then(resolve,reject); } });
const setup = t => {
  mongoose.connection.db = { admin: () => ({ command: async () => ({}) }) };
  const association = id(), user = id(), actor = id(), family = id(), ledger = id(), parent = id(), a = id(), b = id(), year = annualRoleYear();
  const tables = new Map();
  for (const Model of [DistrictGroup, Household, AssociationMembership, AnnualOfficer, AnnualLeaderAssignment, JoinApplication, AuditLog, LocationLinkRequest, RoleDefinition, RoleAssignment, Notification]) {
    const rows = []; tables.set(Model, rows);
    t.mock.method(Model, 'find', filter => query(rows.filter(row => match(row,filter))));
    t.mock.method(Model, 'findOne', filter => query(rows.find(row => match(row,filter)) || null));
    t.mock.method(Model, 'exists', filter => query(rows.find(row => match(row,filter)) || null));
    t.mock.method(Model, 'updateOne', async (filter, update) => {
      const row = rows.find(row => match(row,filter));
      if (!row) return { matchedCount: 0 };
      Object.assign(row,update.$set);
      for (const key of Object.keys(update.$unset || {})) delete row[key];
      return { matchedCount: 1 };
    });
    t.mock.method(Model, 'create', async data => {
      const many = Array.isArray(data), entries = (many ? data : [data]).map(value => ({ _id: id(), ...(Model === LocationLinkRequest ? { status: 'pending' } : {}), ...value }));
      rows.push(...entries); return many ? entries : entries[0];
    });
    t.mock.method(Model, 'deleteOne', async filter => {
      const index = rows.findIndex(row => match(row,filter)); if (index >= 0) rows.splice(index,1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    });
    t.mock.method(Model, 'insertMany', async values => { rows.push(...values); return values; });
  }
  const add = (Model, values) => { const row = { _id: id(), association, ...values }; tables.get(Model).push(row); return row; };
  add(DistrictGroup, { _id: parent, name: '地区', active: true });
  add(DistrictGroup, { _id: a, name: '1班', parentDistrict: parent, active: true });
  add(DistrictGroup, { _id: b, name: '2班', parentDistrict: parent, active: true });
  const membership = add(AssociationMembership, { user, household: family, districtGroup: a, status: 'active' });
  add(AssociationMembership, { user: actor, districtGroup: a, status: 'active' });
  const profile = add(Household, { _id: family, districtGroup: a, representative: user, active: true });
  const target = add(Household, { _id: ledger, districtGroup: a, districtLabel: '01', active: true });
  add(AnnualLeaderAssignment, { representative: actor, districtGroup: a, fiscalYear: year, cancelledAt: null });
  const input = { associationId: association, userId: user, actorId: actor, kind: 'ledger', recordId: ledger, manager: false };
  return { association,user,actor,family,ledger,parent,a,b,year,tables,add,membership,profile,target,input };
};

test('班長の台帳紐付けは一致時に家族世帯IDを保って登録する', async t => {
  const f = setup(t), context = await loadLocationLink(f.input);
  assert.equal(context.conflict,false);
  await applyLocationLink(f.input, { fingerprint: context.fingerprint, districtId: f.a });
  assert.equal(String(f.membership.household),String(f.family));
  assert.equal(String(f.target.profileHousehold),String(f.family));
  assert.equal(String(f.target.feeRepresentative),String(f.user));
  assert.equal(f.tables.get(AuditLog).length,1);
});

test('管理者の後付けで不一致を表示し、会員側に合わせて役員の地区・班を正規化する', async t => {
  const f = setup(t), officer = f.add(AnnualOfficer,{ districtGroup: f.b, district: f.parent, group: f.b, fiscalYear: f.year });
  const input = { ...f.input, manager:true,kind:'officer',recordId:officer._id };
  const context = await loadLocationLink(input);
  assert.equal(context.conflict,true);
  assert.equal(officer.user,undefined);
  await applyLocationLink(input,{ fingerprint:context.fingerprint,districtId:f.a });
  assert.equal(String(officer.user),String(f.user));
  assert.equal(String(officer.group),String(f.a));
  assert.equal(String(officer.district),String(f.parent));
});

test('管理者側に合わせると世帯・家族会員・別の役員・申請を一括変更する', async t => {
  const f = setup(t), spouse = f.add(AssociationMembership,{ user:id(), household:f.family,districtGroup:f.a,status:'active' });
  const officer = f.add(AnnualOfficer,{ districtGroup:f.b,fiscalYear:f.year });
  const spouseOfficer = f.add(AnnualOfficer,{ user:spouse.user,districtGroup:f.a,fiscalYear:f.year+1 });
  const past = f.add(AnnualOfficer,{ user:f.user,districtGroup:f.a,fiscalYear:f.year-2 });
  const application=f.add(JoinApplication,{household:f.family,districtGroup:f.a,status:'pending'});
  const input={...f.input,manager:true,kind:'officer',recordId:officer._id}, context=await loadLocationLink(input);
  await applyLocationLink(input,{fingerprint:context.fingerprint,districtId:f.b});
  for (const row of [f.membership,f.profile,spouse,officer,spouseOfficer,application]) assert.equal(String(row.districtGroup),String(f.b));
  assert.equal(String(past.districtGroup),String(f.a));
});

test('班長は不一致を確認後に申請し、承認まで既存情報を変更しない', async t => {
  const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
  const req={params:{associationId:f.association},body:{userId:f.user,householdId:f.ledger},user:{_id:f.actor},session:{},originalUrl:`/associations/${f.association}/leader/fees/link`};
  let view, redirect; const res={set(){},render(name,data){view=data;},redirect(url){redirect=url;}};
  await handleLocationLink(req,res,{kind:'ledger',recordId:f.ledger,manager:false});
  assert.equal(f.target.feeRepresentative,undefined);
  assert.equal(view.manager,false);
  assert.equal(String(view.householdId),String(f.ledger));
  req.body={...req.body,confirmationToken:view.confirmationToken,districtId:String(f.b)};
  await handleLocationLink(req,res,{kind:'ledger',recordId:f.ledger,manager:false});
  assert.equal(f.target.feeRepresentative,undefined);
  assert.equal(String(f.membership.districtGroup),String(f.a));
  assert.equal(f.tables.get(LocationLinkRequest).length,1);
  assert.match(redirect,/leader\/fees$/);
});

test('保留依頼の承認は地区・班変更と紐付けを同時に確定する', async t => {
  const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
  const context=await loadLocationLink(f.input);
  const request=f.add(LocationLinkRequest,{requestedBy:f.actor,user:f.user,household:f.ledger,districtGroup:f.a,status:'pending',fingerprint:context.fingerprint});
  await applyLocationLink({...f.input,manager:true},{fingerprint:context.fingerprint,districtId:f.a,approvedRequest:request});
  assert.equal(request.status,'approved');
  assert.equal(String(f.target.feeRepresentative),String(f.user));
  assert.ok(f.tables.get(AnnualOfficer).every(row=>equal(row.districtGroup,f.a)));
});

for (const scenario of ['stale','forged-choice','leader-bypass','duplicate-leader','out-of-scope']) test(`危険な変更を拒否: ${scenario}`,async t=>{
  const f=setup(t);const officer=f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
  const context=await loadLocationLink(f.input);
  let input={...f.input,manager:true}, districtId=f.a;
  if(scenario==='stale') officer.districtGroup=f.a;
  if(scenario==='forged-choice') districtId=id();
  if(scenario==='leader-bypass') input.manager=false;
  if(scenario==='duplicate-leader') {
    f.add(AnnualLeaderAssignment,{representative:f.user,districtGroup:f.b,fiscalYear:f.year});
    const updated=await loadLocationLink(input);
    await assert.rejects(applyLocationLink(input,{fingerprint:updated.fingerprint,districtId:f.a}),/既に班長/);
    assert.equal(f.target.feeRepresentative,undefined);return;
  }
  if(scenario==='out-of-scope'){f.target.districtGroup=f.b;input.manager=false;}
  await assert.rejects(applyLocationLink(input,{fingerprint:context.fingerprint,districtId}));
  assert.equal(f.target.feeRepresentative,undefined);
});

test('途中で保存に失敗した場合は単独DBでも変更を取り消す',async t=>{
 const f=setup(t),context=await loadLocationLink(f.input);
 t.mock.method(AuditLog,'create',async()=>{throw new Error('audit failure');});
 await assert.rejects(applyLocationLink(f.input,{fingerprint:context.fingerprint,districtId:f.a}),/audit failure/);
 assert.equal(f.target.feeRepresentative,undefined);
 assert.equal(String(f.membership.household),String(f.family));
});

test('新しい班長には世帯プロフィールを作成し、台帳の会員紐付けとは分ける',async t=>{
 const f=setup(t);f.tables.get(Household).length=0;delete f.membership.household;
 const leader=f.add(AnnualLeaderAssignment,{districtGroup:f.a,fiscalYear:f.year+1});
 const input={...f.input,manager:true,kind:'leader',recordId:leader._id},context=await loadLocationLink(input);
 await applyLocationLink(input,{fingerprint:context.fingerprint,districtId:f.a});
 const household=f.tables.get(Household)[0];
 assert.equal(String(household.representative),String(f.user));
 assert.equal(household.feeRepresentative,undefined);
 assert.equal(household.districtLabel,undefined);
 assert.equal(String(leader.household),String(household._id));
 assert.equal(String(f.membership.household),String(household._id));
});

test('確認画面は両方の情報、影響、未選択の選択肢、取消を表示する',async t=>{
 const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
 const req={params:{associationId:f.association},body:{userId:f.user},user:{_id:f.actor},session:{},originalUrl:'/test'};
 let data;await handleLocationLink(req,{set(){},render(name,values){data=values;}},{kind:'ledger',recordId:f.ledger,manager:false});
 const template=fs.readFileSync('src/views/location-link-confirm.ejs','utf8').replace(/<%- include\([\s\S]*?%>/g,'');
 const html=ejs.render(template,{...data,csrfToken:'token'});
 assert.ok(html.includes('地区・1班'));assert.ok(html.includes('地区・2班'));
 assert.ok(html.includes('管理者へ確認を依頼する'));assert.ok(html.includes('登録を中止'));
 assert.ok(!html.includes('checked'));
});

test('確認の改ざん・期限切れ・再送信を拒否する',async t=>{
 const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
 const req={params:{associationId:f.association},body:{userId:f.user},user:{_id:f.actor},session:{},originalUrl:'/test'};
 await assert.rejects(handleLocationLink({...req,body:{...req.body,confirmationToken:'forged',districtId:String(f.a)}},{},{kind:'ledger',recordId:f.ledger,manager:false}),/確認画面/);
});

test('管理者の承認・却下は権限検査とCSRF検査を通す',()=>{
 for(const layer of locationLinksRouter.stack.filter(layer=>layer.route?.methods.post))assert.ok(layer.route.stack.length>=3);
});

for (const mode of ['expired','replayed','changed-user']) test(`確認の使い回しを拒否: ${mode}`,async t=>{
 const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
 const req={params:{associationId:f.association},body:{userId:f.user},user:{_id:f.actor},session:{},originalUrl:'/test'};
 let data;const res={set(){},render(name,value){data=value;},redirect(){}};
 await handleLocationLink(req,res,{kind:'ledger',recordId:f.ledger,manager:false});
 const token=data.confirmationToken;
 req.body={...req.body,confirmationToken:token,districtId:String(f.a)};
 if(mode==='expired')req.session.locationLinkConfirmations[token].expiresAt=0;
 if(mode==='replayed')await handleLocationLink(req,res,{kind:'ledger',recordId:f.ledger,manager:false});
 if(mode==='changed-user')req.session.locationLinkConfirmations[token].userId=String(id());
 await assert.rejects(handleLocationLink(req,res,{kind:'ledger',recordId:f.ledger,manager:false}),/確認画面/);
 assert.equal(f.target.feeRepresentative,undefined);
});

test('古い班長用の仮世帯から、家族IDを保って実際の台帳へ紐付けられる',async t=>{
 const f=setup(t);delete f.profile.representative;f.profile.feeRepresentative=f.user;f.profile.districtLabel='班長世帯';
 f.add(AnnualLeaderAssignment,{representative:f.user,household:f.family,districtGroup:f.a,fiscalYear:f.year+1});
 const context=await loadLocationLink(f.input);
 await applyLocationLink(f.input,{fingerprint:context.fingerprint,districtId:f.a});
 assert.equal(f.profile.feeRepresentative,undefined);
 assert.equal(f.profile.districtLabel,undefined);
 assert.equal(String(f.profile.representative),String(f.user));
 assert.equal(String(f.target.profileHousehold),String(f.family));
});

test('世帯プロフィールがない会員は台帳を所属世帯として登録する',async t=>{
 const f=setup(t);delete f.membership.household;f.tables.get(Household).splice(0,1);
 const context=await loadLocationLink(f.input);
 await applyLocationLink(f.input,{fingerprint:context.fingerprint,districtId:f.a});
 assert.equal(String(f.membership.household),String(f.ledger));
 assert.equal(String(f.target.representative),String(f.user));
});

test('すでに台帳へ紐付いた会員と他の町内会の対象を拒否する',async t=>{
 const f=setup(t);f.profile.districtLabel='02';f.profile.feeRepresentative=f.user;
 await assert.rejects(loadLocationLink(f.input),/すでに台帳/);
 delete f.profile.districtLabel;delete f.profile.feeRepresentative;
 f.target.association=id();
 await assert.rejects(loadLocationLink(f.input),/確認できません/);
 assert.equal(f.target.feeRepresentative,undefined);
});

test('管理者の承認画面から確定まで処理し、同じ承認を繰り返せない',async t=>{
 const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
 const context=await loadLocationLink(f.input);
 const request=f.add(LocationLinkRequest,{requestedBy:f.actor,user:f.user,household:f.ledger,districtGroup:f.b,status:'pending',fingerprint:context.fingerprint});
 const path='/:associationId/manage/location-links/:requestId';
 const show=locationLinksRouter.stack.find(layer=>layer.route?.path===path).route.stack.at(-1).handle;
 const approve=locationLinksRouter.stack.find(layer=>layer.route?.path===`${path}/approve`).route.stack.at(-1).handle;
 const req={params:{associationId:f.association,requestId:request._id},user:{_id:id()},body:{},session:{},originalUrl:`/associations/${f.association}/manage/location-links/${request._id}/approve`};
 let view,error;const res={set(){},render(name,data){view=data;},redirect(){}};
 await show(req,res,e=>{error=e;});assert.equal(error,undefined);
 assert.equal(view.requestedDistrict,String(f.b));
 req.body={confirmationToken:view.confirmationToken,districtId:String(f.b)};
 await approve(req,res,e=>{error=e;});assert.equal(error,undefined);
 assert.equal(request.status,'approved');assert.equal(String(f.membership.districtGroup),String(f.b));
 assert.equal(String(f.target.feeRepresentative),String(f.user));
 await approve(req,res,e=>{error=e;});assert.equal(error.status,404);
});

test('申請後の情報変更と班長の権限喪失時には管理者も承認できない',async t=>{
 const f=setup(t);f.add(AnnualOfficer,{user:f.user,districtGroup:f.b,fiscalYear:f.year});
 const context=await loadLocationLink(f.input);
 const request=f.add(LocationLinkRequest,{requestedBy:f.actor,user:f.user,household:f.ledger,districtGroup:f.b,status:'pending',fingerprint:context.fingerprint});
 const show=locationLinksRouter.stack.find(layer=>layer.route?.path==='/:associationId/manage/location-links/:requestId').route.stack.at(-1).handle;
 const req={params:{associationId:f.association,requestId:request._id},user:{_id:id()},session:{}};
 f.profile.districtGroup=f.b;
 let error;await show(req,{set(){}},e=>{error=e;});assert.equal(error.status,409);
 f.profile.districtGroup=f.a;f.tables.get(AnnualLeaderAssignment).length=0;
 await show(req,{set(){}},e=>{error=e;});assert.equal(error.status,403);
 assert.equal(request.status,'pending');assert.equal(f.target.feeRepresentative,undefined);
});

test('所属班が担当外の会員も警告に進めるが、班長だけでは確定できない',async t=>{
 const f=setup(t);f.membership.districtGroup=f.b;f.profile.districtGroup=f.b;
 const context=await loadLocationLink(f.input);assert.equal(context.conflict,true);
 await assert.rejects(applyLocationLink(f.input,{fingerprint:context.fingerprint,districtId:f.a}),/管理者の承認/);
 assert.equal(f.target.feeRepresentative,undefined);
});
