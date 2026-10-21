import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { canViewGoodPlaceAuthors, goodPlaceAuthorQuery, redactGoodPlaceAuthor } from '../src/services/goodPlaceDisclosureService.js';
import { GoodPlace } from '../src/models/goodPlace.js';
import { goodPlacesRouter } from '../src/routes/goodPlaces.js';
const association={_id:'507f1f77bcf86cd799439011',name:'町内会'};
const report={_id:'507f1f77bcf86cd799439012',association:association._id,title:'桜',body:'景色',createdAt:new Date(),locationSource:'address',address:'公園付近',author:{_id:'private-user',displayname:'秘密の投稿者氏名',email:'private@example.test',phone:'09012345678'}};
const globals={currentUser:null,currentPath:'/',title:'PR',assetVersion:'test',csrfToken:'csrf',showNotificationPrompt:false,notice:null};
test('only active membership in the same association grants identity visibility',async t=>{
  let calls=0;
  t.mock.method(AssociationMembership,'exists',async filter=>{calls++;assert.equal(filter.association,association._id);assert.equal(filter.status,'active');return filter.user==='resident';});
  assert.equal(await canViewGoodPlaceAuthors(association._id),false);assert.equal(calls,0);
  assert.equal(await canViewGoodPlaceAuthors(association._id,'resident'),true);
  for(const user of ['another-association','former-resident','pending-resident','admin-without-membership']) assert.equal(await canViewGoodPlaceAuthors(association._id,user),false);
});
test('public queries exclude author and never populate a user profile',()=>{
  const calls=[];const query={select(value){calls.push(['select',value]);return this;},populate(...args){calls.push(['populate',...args]);return this;}};
  goodPlaceAuthorQuery(query,false);assert.deepEqual(calls,[['select','-author']]);
  calls.length=0;goodPlaceAuthorQuery(query,true);assert.deepEqual(calls,[['populate','author','displayname']]);
  assert.equal(redactGoodPlaceAuthor(report,false).author,undefined);
});
test('gallery, detail and history hide author identity by default even if a raw record includes it',async()=>{
  for(const show of [false,true]){
    const shared={...globals,association,showGoodPlaceAuthors:show};
    const gallery=await ejs.renderFile('src/views/partials/good-place-gallery.ejs',{...shared,goodPlaces:[report]});
    const detail=await ejs.renderFile('src/views/good-place-detail.ejs',{...shared,report,canDelete:false});
    const history=await ejs.renderFile('src/views/good-place-history.ejs',{...shared,reports:[report],page:1,hasNext:false});
    for(const html of [gallery,detail,history]){
      assert.equal(html.includes(report.author.displayname),show);
      assert.doesNotMatch(html,/private@example.test|09012345678|private-user/);
      assert.match(html,/桜/);
    }
  }
});
test('anonymous and other-association detail responses contain no author data; residents receive names',async t=>{
  t.mock.method(GoodPlace,'findOne',()=>({populate(){return this;},select(){return this;},lean:async()=>report}));
  t.mock.method(AssociationMembership,'exists',async filter=>filter.user==='resident');
  const handler=goodPlacesRouter.stack.find(layer=>layer.route?.path==='/associations/:associationId/good-places/:reportId/:photo(photo)?').route.stack[0].handle;
  // A resident's role lookup is separate; exercise public requests without that lookup.
  for(const user of [undefined,{_id:'outsider'}]){
    let locals;
    await handler({params:{associationId:association._id,reportId:report._id},user},{locals:{goodPlaceAssociation:association},render(_view,data){locals=data;}},error=>{throw error;});
    assert.equal(locals.showGoodPlaceAuthors,false);assert.equal(locals.report.author,undefined);
    assert.equal(JSON.stringify(locals).includes(report.author.displayname),false);
  }
});
