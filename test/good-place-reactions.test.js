import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { GoodPlace } from '../src/models/goodPlace.js';
import { GoodPlaceLike, GoodPlaceComment } from '../src/models/goodPlaceReaction.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { parseCommentsEnabled, setGoodPlaceLike, addGoodPlaceComment, moderateGoodPlaceComment, loadGoodPlaceReactions } from '../src/services/goodPlaceReactionService.js';
import { goodPlacesRouter } from '../src/routes/goodPlaces.js';
import { requireLogin } from '../src/middleware/auth.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const input={associationId:'507f1f77bcf86cd799439011',reportId:'507f1f77bcf86cd799439012',userId:'507f1f77bcf86cd799439013'};
const commentId='507f1f77bcf86cd799439014';
function access(t,report={author:input.userId,commentsEnabled:true},active=true){
  t.mock.method(NeighborhoodAssociation,'findOne',()=>({lean:async()=>({_id:input.associationId})}));
  t.mock.method(AssociationMembership,'exists',async filter=>{assert.equal(filter.association,input.associationId);assert.equal(filter.user,input.userId);return active;});
  t.mock.method(GoodPlace,'findOne',filter=>{assert.deepEqual(filter,{_id:input.reportId,association:input.associationId});return {select:()=>({lean:async()=>report})};});
}
test('comments default ON and explicit OFF survives persistence',async()=>{
  assert.equal(parseCommentsEnabled(undefined),true);assert.equal(parseCommentsEnabled('off'),false);assert.equal(parseCommentsEnabled('on'),true);
  assert.throws(()=>parseCommentsEnabled('unexpected'));
  const report=new GoodPlace();assert.equal(report.commentsEnabled,true);
});
test('Like is idempotent per resident and can be removed without exposing other identities',async t=>{
  access(t);let filter,update;
  t.mock.method(GoodPlaceLike,'updateOne',async(f,u)=>{filter=f;update=u;});
  t.mock.method(GoodPlaceLike,'deleteOne',async f=>{filter=f;});
  await setGoodPlaceLike(input,true);assert.deepEqual(filter,{association:input.associationId,report:input.reportId,user:input.userId});assert.deepEqual(update.$setOnInsert,filter);
  await setGoodPlaceLike(input,false);assert.equal(filter.user,input.userId);
  t.mock.method(GoodPlaceLike,'updateOne',async()=>{throw Object.assign(new Error('duplicate'),{code:11000});});await setGoodPlaceLike(input,true);
  assert.ok(GoodPlaceLike.schema.indexes().some(([fields,options])=>fields.user===1&&fields.report===1&&options.unique));
});
test('nonmembers cannot Like or comment and cannot moderate',async t=>{
  access(t,undefined,false);
  for(const action of [()=>setGoodPlaceLike(input,true),()=>addGoodPlaceComment(input,'test'),()=>moderateGoodPlaceComment(input,commentId,true)])await assert.rejects(action(),{status:403});
});
test('comments OFF is enforced server-side, not only by hiding the form',async t=>{
  access(t,{author:input.userId,commentsEnabled:false});
  t.mock.method(GoodPlaceComment,'create',async()=>assert.fail());
  await assert.rejects(addGoodPlaceComment(input,'コメント'),{status:403});
});
test('comments validate length and store the authenticated user scoped to the report',async t=>{
  access(t);let record;t.mock.method(GoodPlaceComment,'create',async data=>{record=data;return data;});
  for(const body of ['', ' ', 'あ'.repeat(1001)])await assert.rejects(addGoodPlaceComment(input,body),{status:400});
  await addGoodPlaceComment(input,'  綺麗ですね  ');assert.deepEqual(record,{association:input.associationId,report:input.reportId,user:input.userId,body:'綺麗ですね'});
});
test('only original post author can hide and restore comments in that report',async t=>{
  access(t);let filter,update;
  t.mock.method(GoodPlaceComment,'updateOne',async(f,u)=>{filter=f;update=u;return {matchedCount:1};});
  await moderateGoodPlaceComment(input,commentId,true);
  assert.deepEqual(filter,{_id:commentId,association:input.associationId,report:input.reportId});assert.ok(update.$set.hiddenAt instanceof Date);assert.equal(update.$set.hiddenBy,input.userId);
  await moderateGoodPlaceComment(input,commentId,false);assert.equal(update.$set.hiddenAt,null);
  t.mock.method(GoodPlace,'findOne',()=>({select:()=>({lean:async()=>({author:'another-user'})})}));
  await assert.rejects(moderateGoodPlaceComment(input,commentId,true),{status:403});
});
test('residents only retrieve visible comments; author may retrieve hidden comments for moderation',async t=>{
  t.mock.method(GoodPlaceComment,'countDocuments',async()=>2);t.mock.method(GoodPlaceLike,'countDocuments',async()=>3);t.mock.method(GoodPlaceLike,'exists',async()=>true);
  let queryFilter;
  t.mock.method(GoodPlaceComment,'find',filter=>{queryFilter=filter;return {populate(_field,fields){assert.equal(fields,'displayname');return this;},sort(){return this;},skip(){return this;},limit(){return this;},lean:async()=>[]};});
  const result=await loadGoodPlaceReactions({...input,owner:false});assert.equal(queryFilter.hiddenAt,null);assert.equal(result.likeCount,3);assert.equal(result.commentCount,2);assert.equal(result.liked,true);
  await loadGoodPlaceReactions({...input,owner:true});assert.equal(Object.hasOwn(queryFilter,'hiddenAt'),false);
});
test('every mutation endpoint requires login and CSRF',()=>{
  for(const suffix of ['/like','/comments','/comments/:commentId/visibility']){
    const route=goodPlacesRouter.stack.find(layer=>layer.route?.path===`/associations/:associationId/good-places/:reportId${suffix}`).route;
    assert.equal(route.stack[0].handle,requireLogin);assert.equal(route.stack[1].handle,verifyCsrfToken);
  }
});
test('public page renders no reaction data; residents see controls, escaped comments and default comment setting',async()=>{
  const locals={report:{_id:input.reportId},association:{_id:input.associationId},csrfToken:'csrf'};
  assert.equal((await ejs.renderFile('src/views/partials/good-place-reactions.ejs',{...locals,reactions:null})).trim(),'');
  const reactions={liked:true,likeCount:3,owner:true,page:1,hasNext:false,comments:[{_id:commentId,user:{displayname:'住人'},body:'<script>alert(1)</script>',createdAt:new Date(),hiddenAt:new Date()}]};
  const html=await ejs.renderFile('src/views/partials/good-place-reactions.ejs',{...locals,reactions});
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/再表示する/);assert.match(html,/<dialog/);assert.ok(html.indexOf('good-place-comments-scroll') < html.indexOf('good-place-comments-composer'));
  const disabled=await ejs.renderFile('src/views/partials/good-place-reactions.ejs',{...locals,report:{...locals.report,commentsEnabled:false},reactions:{...reactions,owner:false,comments:[]}});
  assert.doesNotMatch(disabled,/<textarea|非表示にする/);assert.match(disabled,/コメントを受け付けていません/);
});

test('unknown post and foreign comment IDs cannot be used to change another report',async t=>{
  access(t);
  t.mock.method(GoodPlaceComment,'updateOne',async filter=>{assert.equal(filter.report,input.reportId);assert.equal(filter.association,input.associationId);return {matchedCount:0};});
  await assert.rejects(moderateGoodPlaceComment(input,commentId,true),{status:404});
  t.mock.method(GoodPlace,'findOne',()=>({select:()=>({lean:async()=>null})}));
  await assert.rejects(setGoodPlaceLike(input,true),{status:404});
  await assert.rejects(addGoodPlaceComment(input,'test'),{status:404});
});
test('new-post form sends explicit comment setting and defaults to comments enabled',async()=>{
  const html=await ejs.renderFile('src/views/partials/good-place-compose.ejs',{memberships:[{association:{_id:input.associationId,name:'町内会'}}],assetVersion:'test'});
  assert.match(html,/select name="commentsEnabled"/);assert.match(html,/value="on" selected>コメントあり/);assert.match(html,/value="off">コメントなし/);
});
