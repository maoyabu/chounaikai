import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Shelter } from '../src/models/shelter.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { shelterValues, shelterInformationValues, saveShelterInformation, loadShelters, saveShelter, removeShelter } from '../src/services/shelterService.js';
import { sheltersRouter } from '../src/routes/shelters.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
import { acceptPublicPhotos } from '../src/services/publicPageImageService.js';

const aid='aaaaaaaaaaaaaaaaaaaaaaaa',uid='bbbbbbbbbbbbbbbbbbbbbbbb',sid='cccccccccccccccccccccccc';
const association={_id:aid,name:'第一町内会'};
const body={name:' 第一小学校 ',address:'東京都〇〇市一丁目1番地',phone:'03-1234-5678',capacity:'200',kind:'指定避難所',dangerPoints:'裏側の崖に注意',informationUrl:'https://example.com/shelters',informationName:'市の指定避難所一覧'};
const shelter={_id:sid,association:aid,__v:0,...shelterValues(body),informationUrl:body.informationUrl,informationName:body.informationName,photos:[]};
const query=value=>({select(){return this;},sort(){return this;},lean:async()=>value});
function access(t,officer=true,member=true){
  t.mock.method(NeighborhoodAssociation,'findOne',()=>query(association));
  t.mock.method(AssociationMembership,'findOne',()=>query(member?{}:null));
  t.mock.method(RoleDefinition,'find',()=>query([]));
  t.mock.method(RoleAssignment,'exists',async()=>false);
  t.mock.method(AnnualOfficer,'exists',async()=>officer);
}
const locals={title:'避難所',assetVersion:'test',currentUser:null,currentPath:'/',notice:null,csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true};

test('shelter validation accepts optional unknown capacity, zero and safe named information URLs',()=>{
  const values=shelterValues(body);
  assert.equal(values.name,'第一小学校');assert.equal(values.capacity,200);
  assert.equal(shelterValues({...body,capacity:''}).capacity,null);
  assert.equal(shelterValues({...body,capacity:'0'}).capacity,0);
  assert.equal(shelterInformationValues({informationUrl:'',informationName:''}).url,'');
  for(const capacity of ['-1','1.5','1000001','x']) assert.throws(()=>shelterValues({...body,capacity}),{status:400});
  for(const informationUrl of ['javascript:alert(1)','//example.com','https://user:pass@example.com']) assert.throws(()=>shelterInformationValues({...body,informationUrl}),{status:400});
  assert.throws(()=>shelterInformationValues({...body,informationName:''}),{status:400});
  assert.throws(()=>shelterValues({...body,name:''}),{status:400});
  assert.throws(()=>shelterValues({...body,address:['bad']}),{status:400});
});

test('members may read only their association shelters and duplicate official links are collapsed',async t=>{
  access(t,false);
  t.mock.method(Shelter,'find',filter=>{assert.deepEqual(filter,{association:aid,active:true});return query([shelter,{...shelter,_id:uid,name:'第二小学校'}]);});
  const result=await loadShelters(aid,uid,uid);
  assert.equal(result.canManage,false);assert.equal(result.selected.name,'第二小学校');assert.equal(result.informationLinks.length,1);
  await assert.rejects(loadShelters(aid,uid,'other-association-shelter'),{status:404});
});

test('non-members cannot read shelters and ordinary residents cannot create or remove',async t=>{
  access(t,false,false);
  const read=t.mock.method(Shelter,'find',()=>{throw new Error('must not read');});
  await assert.rejects(loadShelters(aid,uid),{status:403});
  assert.equal(read.mock.callCount(),0);
  AssociationMembership.findOne.mock.mockImplementation(()=>query({}));
  await assert.rejects(saveShelter({associationId:aid,userId:uid,body}),{status:403});
  await assert.rejects(removeShelter(aid,sid,uid),{status:403});
});

test('new shelters use the authorized tenant and allow no photos',async t=>{
  access(t);
  t.mock.method(Shelter.prototype,'save',async function(){assert.equal(String(this.association),aid);assert.equal(String(this.createdBy),uid);assert.equal(String(this.updatedBy),uid);assert.equal(this.name,'第一小学校');return this;});
  const result=await saveShelter({associationId:aid,userId:uid,body:{...body,association:'foreign',photos:[{url:'javascript:bad'}]}});
  assert.equal(result.photos.length,0);
});

test('editing is tenant scoped and stale versions fail before any photo upload',async t=>{
  access(t);
  t.mock.method(Shelter,'findOne',async filter=>{assert.deepEqual(filter,{_id:sid,association:aid,active:true});return {...shelter,__v:2};});
  let uploaded=false;
  await assert.rejects(saveShelter({associationId:aid,userId:uid,shelterId:sid,body:{...body,version:'1'},files:{photo0:[{}]}},{uploadPublicPhoto:async()=>{uploaded=true;},deletePublicPhoto:async()=>{}}),{status:409});
  assert.equal(uploaded,false);
  Shelter.findOne.mock.mockImplementation(async()=>null);
  await assert.rejects(saveShelter({associationId:aid,userId:uid,shelterId:sid,body}),{status:404});
});

test('photo replacement keeps three slots and deletes replaced images only after saving',async t=>{
  access(t);let saved=false;
  const record={...shelter,photos:[{url:'/old0',publicId:'old0'},{url:'/old1',publicId:'old1'}],save:async()=>{saved=true;}};
  t.mock.method(Shelter,'findOne',async()=>record);
  const deleted=[];
  await saveShelter({associationId:aid,userId:uid,shelterId:sid,body:{...body,version:'0',removePhoto1:'on'},files:{photo0:[{}],photo2:[{}]}},{uploadPublicPhoto:async(_file,_aid,slot)=>({url:'/'+slot,publicId:slot}),deletePublicPhoto:async id=>{assert.equal(saved,true);deleted.push(id);}});
  assert.equal(record.photos.length,2);assert.deepEqual(deleted.sort(),['old0','old1']);
});

test('failed photo save cleans new uploads while preserving previously saved photos',async t=>{
  access(t);
  const record={...shelter,photos:[{url:'/old',publicId:'old'}],save:async()=>{throw new Error('database unavailable');}};
  t.mock.method(Shelter,'findOne',async()=>record);
  const deleted=[];
  await assert.rejects(saveShelter({associationId:aid,userId:uid,shelterId:sid,body:{...body,version:'0'},files:{photo0:[{}]}},{uploadPublicPhoto:async()=>({url:'/new',publicId:'new'}),deletePublicPhoto:async id=>deleted.push(id)}),/database unavailable/);
  assert.deepEqual(deleted,['new']);
});

test('more than three photos or unexpected fields are rejected',async t=>{
  access(t);t.mock.method(Shelter.prototype,'save',async()=>{});
  await assert.rejects(saveShelter({associationId:aid,userId:uid,body,files:{photo0:[{},{},{},{}]}}),{status:400});
  const doc=new Shelter({association:aid,createdBy:uid,updatedBy:uid,...shelterValues(body),photos:Array.from({length:4},()=>({url:'/image'}))});
  assert.ok(doc.validateSync().errors.photos);
});

test('removal is scoped and soft deletes the shelter',async t=>{
  access(t);
  t.mock.method(Shelter,'updateOne',async(filter,update)=>{assert.deepEqual(filter,{_id:sid,association:aid,active:true});assert.equal(update.$set.active,false);assert.equal(update.$set.updatedBy,uid);return {matchedCount:1};});
  await removeShelter(aid,sid,uid);
});

test('upload routes require login, officer access before multipart parsing, and CSRF',()=>{
  assert.equal(sheltersRouter.stack[0].handle,requireLogin);
  for(const layer of sheltersRouter.stack.filter(l=>l.route?.methods.post)){
    const stack=layer.route.stack;
    assert.ok(stack.some(s=>s.handle===verifyCsrfToken));
    if(layer.route.path.endsWith('/delete') || layer.route.path.endsWith('/information'))continue;
    assert.equal(stack[1].handle,acceptPublicPhotos);assert.equal(stack[2].handle,verifyCsrfToken);
  }
});

test('management tab renders create/edit dialogs, all fields, three photo inputs and CSRF',async()=>{
  const html=await ejs.renderFile('src/views/association-shelters-manage.ejs',{...locals,association,shelters:[shelter]});
  assert.match(html,/防災関連情報/);assert.match(html,/id="new-shelter"/);assert.match(html,/data-shelter-open="new-shelter"/);
  for(const name of ['name','address','phone','capacity','kind','dangerPoints','informationUrl','informationName','photo0','photo1','photo2']) assert.ok(html.includes(`name="${name}"`));
  assert.match(html,/name="_csrf" value="csrf"/);assert.match(html,/避難所の登録/);
});

test('resident list shows official links above map and safely encodes the selected address',async()=>{
  const item={...shelter,name:'<小学校>',photos:[]};
  const html=await ejs.renderFile('src/views/shelters.ejs',{...locals,association,shelters:[item],selected:item,canManage:false,informationLinks:[{url:'https://example.com/',name:'自治体の指定避難所'}]});
  assert.ok(html.indexOf('自治体の指定避難所')<html.indexOf('id="shelter-map"'));
  assert.match(html,/&lt;小学校&gt;/);assert.ok(html.includes(encodeURIComponent(item.address)));
  assert.doesNotMatch(html,/避難所を登録・管理/);
  assert.match(html,/裏側の崖に注意/);
});

test('selecting a shelter switches its map marker, detail panel and accessible selection',async()=>{
  const elements={};let action;
  const selected={dataset:{shelterSelect:sid,shelterAddress:body.address,shelterName:'第二小学校'},addEventListener(_type,handler){action=handler;},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];}};
  const previous={...selected,dataset:{shelterSelect:uid},addEventListener(){},'aria-current':'true'};
  const panels=[{dataset:{shelterDetails:sid},hidden:true},{dataset:{shelterDetails:uid},hidden:false}];
  for(const id of ['shelter-map-frame','shelter-map-external','shelter-map-title','shelter-map-status']) elements[id]={};
  const document={querySelectorAll(selector){return selector==='[data-shelter-select]'?[previous,selected]:selector==='[data-shelter-details]'?panels:[];},getElementById:id=>elements[id]};
  vm.runInNewContext(await readFile('src/public/shelters.js','utf8'),{document,URL,location:{href:'https://example.test/shelters'},history:{replaceState(){}}});
  let prevented=false;action({button:0,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.ok(elements['shelter-map-frame'].src.includes(encodeURIComponent(body.address)));
  assert.equal(elements['shelter-map-title'].textContent,'第二小学校');assert.equal(selected['aria-current'],'true');
  assert.equal(previous['aria-current'],undefined);assert.equal(panels[0].hidden,false);assert.equal(panels[1].hidden,true);
});

test('disaster information defaults to alert registration and switches to the shelter management tab',async t=>{
  access(t);
  t.mock.method(Shelter,'find',()=>query([]));
  const { alertLevelsRouter }=await import('../src/routes/alertLevels.js');
  const handler=alertLevelsRouter.stack.find(layer=>layer.route?.path==='/:associationId/alert-level' && layer.route.methods.get).route.stack.at(-1).handle;
  const views=[];
  const response={render(view){views.push(view);}};
  const request={params:{associationId:aid},user:{_id:uid},query:{}};
  await handler(request,response,error=>{throw error;});
  await handler({...request,query:{tab:'shelters'}},response,error=>{throw error;});
  assert.deepEqual(views,['association-alert-level','association-shelters-manage']);
});

test('shared public information is saved once for the authorized association and cannot be changed by residents',async t=>{
  access(t);
  const writes=[];
  t.mock.method(NeighborhoodAssociation,'updateOne',async(filter,change)=>{writes.push({filter,change});return {matchedCount:1};});
  await saveShelterInformation(aid,uid,{informationName:'市の避難所一覧',informationUrl:'https://example.com/shelters'});
  assert.equal(writes[0].filter._id,aid);
  assert.deepEqual(writes[0].change.$set.shelterInformation,{name:'市の避難所一覧',url:'https://example.com/shelters'});
  await saveShelterInformation(aid,uid,{informationName:'',informationUrl:''});
  assert.deepEqual(writes[1].change.$set.shelterInformation,{name:'',url:''});
  AnnualOfficer.exists.mock.mockImplementation(async()=>false);
  await assert.rejects(saveShelterInformation(aid,uid,body),{status:403});
  assert.equal(writes.length,2);
});

test('shared page overrides old per-shelter links, is shown without shelters and stays cleared when removed',async t=>{
  access(t);
  t.mock.method(Shelter,'find',()=>query([shelter,{...shelter,informationUrl:'https://other.example.com/'}]));
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query({...association,shelterInformation:{name:'共通ページ',url:'https://shared.example.com/'}}));
  const result=await loadShelters(aid,uid);
  assert.deepEqual(result.informationLinks,[{name:'共通ページ',url:'https://shared.example.com/'}]);
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query({...association,shelterInformation:{name:'',url:''}}));
  assert.equal((await loadShelters(aid,uid)).informationLinks.length,0);
  Shelter.find.mock.mockImplementation(()=>query([]));
  NeighborhoodAssociation.findOne.mock.mockImplementation(()=>query({...association,shelterInformation:{name:'共通ページ',url:'https://shared.example.com/'}}));
  assert.equal((await loadShelters(aid,uid)).informationLinks.length,1);
});

test('public information fields appear only once on the management page and never inside add/edit shelter forms',async()=>{
  const page=await ejs.renderFile('src/views/association-shelters-manage.ejs',{...locals,association,shelters:[shelter]});
  assert.equal((page.match(/name="informationUrl"/g)||[]).length,1);
  assert.equal((page.match(/name="informationName"/g)||[]).length,1);
  const modal=await ejs.renderFile('src/views/partials/shelter-form.ejs',{association,csrfToken:'csrf',shelter});
  assert.doesNotMatch(modal,/informationUrl|informationName/);
  assert.equal(shelterValues(body).informationUrl,undefined);
});
