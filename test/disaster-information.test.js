import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { Household, HouseholdMember } from '../src/models/organization.js';
import { SafetyReport } from '../src/models/safetyReport.js';
import { Shelter } from '../src/models/shelter.js';
import { loadDisasterInformation } from '../src/services/disasterInformationService.js';
import { safetyRouter } from '../src/routes/safety.js';
import { disasterInformationRouter } from '../src/routes/disasterInformation.js';
import { requireLogin } from '../src/middleware/auth.js';
const aid='aaaaaaaaaaaaaaaaaaaaaaaa',uid='bbbbbbbbbbbbbbbbbbbbbbbb',hid='cccccccccccccccccccccccc',mid='dddddddddddddddddddddddd';
const base={_id:aid,name:'第一町内会',alertLevel:3,safetyEventKey:'incident',hazardMapUrl:'https://example.com/map?a=1&b=2',shelterInformation:{name:'市の避難所',url:'https://example.com/shelters'}};
const shelter={_id:hid,name:'小学校',address:'東京都〇〇区1丁目',photos:[],capacity:100};
const query=value=>({select(){return this;},populate(){return this;},sort(){return this;},lean:async()=>value});
function access(t,association=base,member=true){
  t.mock.method(NeighborhoodAssociation,'findOne',()=>query(association));
  t.mock.method(AssociationMembership,'findOne',()=>query(member?{household:hid}:null));
  t.mock.method(RoleDefinition,'find',()=>query([]));
  t.mock.method(RoleAssignment,'exists',async()=>false);
  t.mock.method(AnnualOfficer,'exists',async()=>false);
  t.mock.method(Shelter,'find',()=>query([shelter]));
  t.mock.method(Household,'findOne',()=>query({_id:hid,displayName:'世帯'}));
  t.mock.method(HouseholdMember,'find',()=>query([{_id:mid,name:'家族',household:hid}]));
  t.mock.method(SafetyReport,'findOne',()=>query(null));
}
const locals={title:'防災情報',assetVersion:'test',notice:null,currentUser:null,currentPath:'/',csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true};
const render=context=>ejs.renderFile('src/views/disaster-information.ejs',{...locals,...context});

test('active warning defaults to household registration with three tabs and a single hazard map link',async t=>{
  access(t);
  const context=await loadDisasterInformation(aid,uid);
  assert.equal(context.selectedTab,'safety');assert.equal(context.activeAlert,true);
  const html=await render(context);
  assert.match(html,/name="memberIds"/);
  for(const tab of ['safety','alerts','shelters']) assert.ok(html.includes(`/disaster?tab=${tab}`));
  assert.match(html,/href="https:\/\/example.com\/map\?a=1&amp;b=2"/);
  assert.match(html,/ハザードマップ（別タブ）/);
});

test('alert and shelter tabs reuse the image popups and selected Google map without fetching family records',async t=>{
  access(t);
  const alert=await loadDisasterInformation(aid,uid,{tab:'alerts'});
  assert.equal(alert.selectedTab,'alerts');assert.equal(HouseholdMember.find.mock.callCount(),0);
  const html=await render(alert);
  assert.match(html,/images\/alert-levels.jpg/);assert.match(html,/data-alert-detail="disaster-alert-guide-level-5"/);
  const shelters=await loadDisasterInformation(aid,uid,{tab:'shelters',selected:hid});
  const page=await render(shelters);
  assert.match(page,/google.com\/maps\?q=/);
  assert.match(page,new RegExp(`href="\\?tab=shelters&amp;selected=${hid}`));
  assert.ok(page.indexOf('市の避難所')<page.indexOf('id="shelter-map"'));
  assert.equal(HouseholdMember.find.mock.callCount(),0);
});

test('normal mode displays shelters and hazard link only, even for stale safety or alert tab URLs',async t=>{
  access(t,{...base,alertLevel:0});
  for(const tab of [undefined,'safety','alerts']){
    const context=await loadDisasterInformation(aid,uid,{tab});
    assert.equal(context.selectedTab,'shelters');assert.equal(context.activeAlert,false);
    const html=await render(context);
    assert.match(html,/避難所情報/);assert.match(html,/ハザードマップ（別タブ）/);
    assert.doesNotMatch(html,/aria-label="防災情報の切り替え"|name="memberIds"|alert-levels.jpg/);
  }
  assert.equal(HouseholdMember.find.mock.callCount(),0);
});

test('missing map URL or shelters leaves a usable normal hub and never creates a broken external link',async t=>{
  access(t,{...base,alertLevel:0,hazardMapUrl:''});
  Shelter.find.mock.mockImplementation(()=>query([]));
  const html=await render(await loadDisasterInformation(aid,uid));
  assert.match(html,/避難所はまだ登録されていません/);
  assert.doesNotMatch(html,/class="button hazard-map-button"|google.com\/maps/);
});

test('hub requires membership and active alert safety registration still handles missing households',async t=>{
  access(t,base,false);
  await assert.rejects(loadDisasterInformation(aid,uid),{status:403});
  AssociationMembership.findOne.mock.mockImplementation(()=>query({}));
  const html=await render(await loadDisasterInformation(aid,uid));
  assert.match(html,/世帯情報が未登録/);
});

test('legacy safety links redirect into the new safety tab and hub is login protected',async()=>{
  assert.equal(disasterInformationRouter.stack[0].handle,requireLogin);
  const handler=safetyRouter.stack.find(layer=>layer.route?.path==='/:associationId/safety'&&layer.route.methods.get).route.stack.at(-1).handle;
  let url;
  await handler({params:{associationId:aid}},{redirect(value){url=value;}},error=>{throw error;});
  assert.equal(url,`/associations/${aid}/disaster?tab=safety`);
});
