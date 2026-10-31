import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { makeSafetyReport, createSafetyReport, loadSafetyReport } from '../src/services/safetyReportService.js';
import { safetyReportPdf } from '../src/services/safetyReportPdf.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { SafetyReport } from '../src/models/safetyReport.js';
import { safetyRouter } from '../src/routes/safety.js';
import { safetyStatuses, buildingStatuses } from '../src/lib/safetyStatus.js';
const aid='aaaaaaaaaaaaaaaaaaaaaaaa',uid='bbbbbbbbbbbbbbbbbbbbbbbb',hid='cccccccccccccccccccccccc',mid='dddddddddddddddddddddddd';
const association={_id:aid,name:'吉田元町町内会',alertLevel:3};
const summary={totalHouseholds:120,totalPeople:310,confirmedHouseholds:95,confirmedPeople:263,unconfirmedHouseholds:25,unconfirmedPeople:47,people:{1:252,2:7,3:3,4:1},buildings:{2:8,3:2,4:19},supportHouseholds:21,supportPeople:24,supportMembers:[],damagedHouseholds:[]};
const query=value=>({select(){return this;},populate(){return this;},sort(){return this;},lean:async()=>value});
function access(t,officer=true){
  t.mock.method(NeighborhoodAssociation,'findOne',()=>query(association));
  t.mock.method(AssociationMembership,'findOne',()=>query({household:hid}));
  t.mock.method(RoleDefinition,'find',()=>query([]));
  t.mock.method(RoleAssignment,'exists',async()=>false);
  t.mock.method(AnnualOfficer,'exists',async()=>officer);
}
const locals={title:'安否レポート',assetVersion:'test',currentUser:null,currentPath:'/',notice:null,csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true};

test('report copies aggregate values only, freezes them and leaves reporter information out',()=>{
  const source=structuredClone(summary);source.supportMembers=[{name:'個人名',address:'非公開住所'}];
  const report=makeSafetyReport(association,source,new Date('2026-10-31T00:12:00Z'));
  source.people[2]=999;source.buildings[3]=999;
  assert.equal(report.people[2],7);assert.equal(report.buildings[3],2);
  assert.equal(report.createdAt,'2026-10-31T00:12:00.000Z');
  assert.equal(report.associationName,'吉田元町町内会');
  assert.ok(!JSON.stringify(report).includes('個人名'));
  assert.ok(!JSON.stringify(report).includes('非公開住所'));
  assert.equal(report.reporter,undefined);
});

test('report creation uses authorized live summary and bounds temporary previews to five per session',async t=>{
  access(t);
  t.mock.method(Household,'find',()=>query([{_id:hid,displayName:'世帯'}]));
  t.mock.method(HouseholdMember,'find',()=>query([{_id:mid,household:hid,name:'住人'}]));
  t.mock.method(SafetyReport,'find',()=>query([{household:hid,memberStatuses:{[mid]:1}}]));
  const session={safetyReports:[{createdAt:'2000-01-01T00:00:00Z',token:'expired'}]};
  let latest;
  for(let i=0;i<6;i++) latest=await createSafetyReport(aid,uid,session);
  assert.equal(session.safetyReports.length,5);
  assert.ok(!session.safetyReports.some(r=>r.token==='expired'));
  assert.equal(latest.confirmedPeople,1);assert.equal(latest.confirmedHouseholds,1);
  assert.equal(await loadSafetyReport(aid,uid,latest.token,session),latest);
});

test('preview and PDF access checks current officer permission, session ownership, tenant and expiry',async t=>{
  access(t);
  const report=makeSafetyReport(association,summary);
  const session={safetyReports:[report]};
  await assert.rejects(loadSafetyReport(aid,uid,report.token,{}),{status:404});
  await assert.rejects(loadSafetyReport(aid,uid,report.token,{safetyReports:[{...report,associationId:hid}]}),{status:404});
  await assert.rejects(loadSafetyReport(aid,uid,report.token,{safetyReports:[{...report,createdAt:'2000-01-01T00:00:00Z'}]}),{status:410});
  AnnualOfficer.exists.mock.mockImplementation(async()=>false);
  await assert.rejects(loadSafetyReport(aid,uid,report.token,session),{status:403});
  await assert.rejects(createSafetyReport(aid,uid,{}),{status:403});
});

test('PDF embeds Japanese font and renders the normal form on one A4 page',async()=>{
  const buffer=await safetyReportPdf(makeSafetyReport(association,summary,new Date('2026-10-31T00:12:00Z')));
  assert.ok(buffer.subarray(0,8).toString().startsWith('%PDF-'));
  const data=buffer.toString('latin1');
  assert.match(data,/\/FontFile2/);
  assert.equal((data.match(/\/Type \/Page\b/g)||[]).length,1);
  assert.match(data,/595\.2/); // A4 width in PDF points.
  assert.ok(buffer.length<1000000);
});

test('download route uses the preview snapshot and returns a private PDF attachment',async t=>{
  access(t);
  const report=makeSafetyReport(association,summary);
  const handler=safetyRouter.stack.find(layer=>layer.route?.path==='/:associationId/safety/officer/report/:token/pdf').route.stack.at(-1).handle;
  let buffer,filename,cache,type;
  await handler({params:{associationId:aid,token:report.token},query:{download:'1'},user:{_id:uid},session:{safetyReports:[report]}},{set(name,value){if(name==='Cache-Control')cache=value;},type(value){type=value;},attachment(value){filename=value;},send(value){buffer=value;}},error=>{throw error;});
  assert.equal(filename,'災害時安否状況報告書.pdf');assert.equal(type,'application/pdf');assert.equal(cache,'private, no-store');
  assert.ok(buffer.subarray(0,5).toString()==='%PDF-');
});

test('report page has inline preview and download using the same token',async()=>{
  const report=makeSafetyReport(association,summary);
  const html=await ejs.renderFile('src/views/safety-report.ejs',{...locals,report});
  assert.match(html,/PDFをダウンロード/);
  assert.match(html,new RegExp(`report/${report.token}/pdf\\?download=1`));
  assert.match(html,new RegExp(`src="/associations/${aid}/safety/officer/report/${report.token}/pdf"`));
  assert.match(html,/報告者氏名・役職・連絡先/);
});

test('current safety heading orders title, green refresh, report and history controls',async()=>{
  const html=await ejs.renderFile('src/views/safety-officer.ejs',{...locals,association,summary,safetyStatuses,buildingStatuses});
  const title=html.indexOf('<h1>安否確認</h1>'),refresh=html.indexOf('>最新の状態に更新</a>'),report=html.indexOf('>レポート出力</a>'),history=html.indexOf('>過去の安否確認</a>');
  assert.ok(title<refresh && refresh<report && report<history);
  assert.match(html,/safety-toolbar-refresh/);
  assert.match(html,/safety-toolbar-history/);
});
