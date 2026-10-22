import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import { GoodPlace } from '../src/models/goodPlace.js';
import { DangerReport } from '../src/models/dangerReport.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { Notification } from '../src/models/notification.js';
import { loadGoodPlaceAssociation, queueGoodPlaceNotifications } from '../src/services/goodPlaceService.js';
import { notificationDestination } from '../src/services/notificationService.js';
import { defaultNotificationChannel } from '../src/models/notificationSettings.js';
import { goodPlacesRouter } from '../src/routes/goodPlaces.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const associationId='507f1f77bcf86cd799439011', reportId='507f1f77bcf86cd799439012';
const association={_id:associationId,name:'町内会'};
const report={_id:reportId,association:associationId,title:'公園の桜',body:'春の景色',createdAt:new Date(),locationSource:'address',address:'町内の公園',author:{displayname:'住人'}};
const globals={title:'テスト',assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'csrf',showNotificationPrompt:false,notice:null};
const route=path=>goodPlacesRouter.stack.find(layer=>layer.route?.path===path).route;
test('good places share report validation but have an independent collection and required Drive photo',async()=>{
  assert.notEqual(GoodPlace.collection.name,DangerReport.collection.name);
  const record=new GoodPlace({association:associationId,author:reportId,title:'桜',body:'春の景色',photoType:'image/jpeg',locationSource:'address',address:'公園',photoAttachment:{fileId:'drive',originalName:'photo.jpg'}});
  await record.validate();record.photoAttachment=undefined;
  await assert.rejects(record.validate(),/photoAttachment/);
});
test('public reads require an active undeleted association and reject invalid IDs',async t=>{
  let active=true;
  t.mock.method(NeighborhoodAssociation,'findOne',filter=>{
    assert.deepEqual(filter,{_id:associationId,status:'active',deletedAt:{$exists:false}});
    return {lean:async()=>active?association:null};
  });
  assert.equal((await loadGoodPlaceAssociation(associationId))._id,associationId);
  active=false;await assert.rejects(loadGoodPlaceAssociation(associationId),{status:404});
  await assert.rejects(loadGoodPlaceAssociation('invalid'),{status:404});
});
test('posting and deleting require login and CSRF; posting also checks active membership',async t=>{
  for(const path of ['/associations/:associationId/good-places','/associations/:associationId/good-places/:reportId/delete']){
    const handlers=route(path).stack.map(item=>item.handle);assert.equal(handlers[0],requireLogin);assert.equal(handlers[1],verifyCsrfToken);
  }
  const handlers=route('/associations/:associationId/good-places').stack;
  t.mock.method(NeighborhoodAssociation,'findOne',()=>({lean:async()=>association}));
  t.mock.method(AssociationMembership,'exists',async()=>null);
  let error;await handlers[2].handle({params:{associationId},user:{_id:reportId}},{},value=>{error=value;});
  assert.equal(error.status,403);
});
test('public history/detail query only the requested association',async t=>{
  let filter;
  t.mock.method(GoodPlace,'findOne',value=>{filter=value;return {populate(){return this;},select(){return this;},lean:async()=>report};});
  let rendered;
  await route('/associations/:associationId/good-places/:reportId/:photo(photo)?').stack[0].handle(
    {params:{associationId,reportId}}, {locals:{goodPlaceAssociation:association},render:(view,locals)=>{rendered={view,locals};}},error=>{throw error;}
  );
  assert.deepEqual(filter,{_id:reportId,association:associationId});assert.equal(rendered.view,'good-place-detail');assert.equal(rendered.locals.canDelete,false);
});
test('notification queue includes active residents and links to the good-place detail',async t=>{
  let records;
  t.mock.method(AssociationMembership,'find',filter=>{assert.deepEqual(filter,{association:associationId,status:'active'});return {distinct:async()=>['author','resident','resident']};});
  t.mock.method(Notification,'insertMany',async values=>{records=values;});
  await queueGoodPlaceNotifications(report);assert.equal(records.length,2);
  assert.ok(records.every(item=>item.type==='good_place' && item.relatedType==='GoodPlace'));
  assert.match(records[0].title,/わがまちのいいところ/);
  assert.equal(notificationDestination(records[0]),`/associations/${associationId}/good-places/${reportId}`);
  assert.deepEqual(defaultNotificationChannel('good_place'),{push:true,email:true});
});
test('gallery precedes the calendar and shows large photo, title and small author/date below',async()=>{
  const source=fs.readFileSync('src/views/partials/association-page-content.ejs','utf8');
  assert.ok(source.indexOf("include('good-place-gallery')")<source.indexOf("include('association-event-calendar'"));
  const html=await ejs.renderFile('src/views/partials/good-place-gallery.ejs',{goodPlaces:[report],association,showGoodPlaceAuthors:true});
  assert.match(html,/good-place-feature/);assert.ok(html.indexOf('<img')<html.indexOf('<strong>'));
  assert.match(html,/<small>[\s\S]*住人/);assert.match(html,new RegExp(`/good-places/${reportId}/photo`));
});
test('posting, detail and map/history pages render without paid Google API',async()=>{
  const post=await ejs.renderFile('src/views/good-place-new.ejs',{...globals,memberships:[{association}]});
  assert.match(post,/data-post-path="good-places"/);assert.match(post,/一般公開/);assert.doesNotMatch(post,/capture=/);
  const detail=await ejs.renderFile('src/views/good-place-detail.ejs',{...globals,association,report,canDelete:false});
  assert.match(detail,/春の景色/);assert.match(detail,/good-places">← わがまち/);assert.doesNotMatch(detail,/maps.googleapis|削除する/);
  const history=await ejs.renderFile('src/views/good-place-history.ejs',{...globals,association,reports:[report],page:1,hasNext:false});
  assert.match(history,/data-danger-focus/);assert.match(history,/町内の公園/);assert.doesNotMatch(history,/maps.googleapis|\/dangers/);
});

test('deletion returns to the PR page after successful authorized removal',async t=>{
  const { AnnualOfficer }=await import('../src/models/annualOfficer.js');
  const { RoleDefinition }=await import('../src/models/role.js');
  t.mock.method(NeighborhoodAssociation,'findOne',()=>({lean:async()=>association}));
  t.mock.method(AssociationMembership,'findOne',()=>({lean:async()=>({user:reportId})}));
  t.mock.method(RoleDefinition,'find',()=>({select:()=>({lean:async()=>[]})}));
  t.mock.method(AnnualOfficer,'exists',async()=>true);
  t.mock.method(GoodPlace,'findOneAndDelete',()=>({lean:async()=>({_id:reportId})}));
  const req={params:{associationId,reportId},user:{_id:reportId},session:{}};
  let destination;
  const handler=route('/associations/:associationId/good-places/:reportId/delete').stack.at(-1).handle;
  await handler(req,{redirect:url=>{destination=url;}},error=>{throw error;});
  assert.equal(destination,`/associations/${associationId}/public`);assert.match(req.session.notice,/削除しました/);
});
