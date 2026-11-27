import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { publicPageCanonical } from '../src/services/publicPageSeoService.js';
import { associationGroupsRouter } from '../src/routes/associationGroups.js';
import { AssociationGroup, AssociationGroupMembership } from '../src/models/associationGroup.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AssociationEvent } from '../src/models/associationEvent.js';
const request = month => ({ app: { locals: { publicBaseUrl: 'https://www.machi-dengon.jp' } }, query: { month }, headers: { host: 'untrusted.example' } });
test('町内会と各グループの代表URLは月やアクセス元のホストに依存しない', () => {
 for (const month of [undefined,'2026-07','2028-01']) {
  assert.equal(publicPageCanonical(request(month),'association'), 'https://www.machi-dengon.jp/associations/association/public');
  assert.equal(publicPageCanonical(request(month),'association','group'), 'https://www.machi-dengon.jp/associations/association/groups/group');
 }
 assert.notEqual(publicPageCanonical(request(),'association','one'),publicPageCanonical(request(),'association','two'));
});
test('HTMLには指定された代表URLを1つだけ出力し、未指定の画面には出力しない', async () => {
 const locals = { title: '公開ページ', assetVersion: 'test', currentUser: null };
 const canonicalUrl = publicPageCanonical(request(),'association');
 const html = await ejs.renderFile('src/views/partials/head.ejs',{...locals,canonicalUrl});
 assert.equal((html.match(/rel="canonical"/g)||[]).length,1);
 assert.ok(html.includes(`href="${canonicalUrl}"`));
 assert.ok(!(await ejs.renderFile('src/views/partials/head.ejs',locals)).includes('rel="canonical"'));
});
for (const visibility of ['open','members']) test(`グループ公開ページの代表URL: ${visibility}`, async t => {
 const q = value => ({ select(){return this;},populate(){return this;},sort(){return this;},lean:async()=>value });
 const group = { _id:'group', association:'association', name:'グループ', publicVisibility:visibility };
 t.mock.method(AssociationGroup,'findOne',()=>q(group));
 t.mock.method(NeighborhoodAssociation,'findById',()=>q({_id:'association'}));
 t.mock.method(AssociationGroupMembership,'find',()=>q([]));
 t.mock.method(AssociationMembership,'findOne',async()=>({status:'active'}));
 t.mock.method(AssociationGroupMembership,'findOne',async()=>null);
 t.mock.method(AssociationGroup,'exists',async()=>false);
 t.mock.method(AssociationEvent,'find',()=>q([]));
 const req={...request('2028-01'),params:{associationId:'association',groupId:'group'},...(visibility==='members'?{user:{_id:'user'}}:{})};
 const { AssociationGroupJoinRequest }=await import('../src/models/associationGroup.js');
 t.mock.method(AssociationGroupJoinRequest,'findOne',()=>q(null));
 const handler=associationGroupsRouter.stack.find(layer=>layer.route?.path==='/:associationId/groups/:groupId' && layer.route.methods.get).route.stack.at(-1).handle;
 let result; await handler(req,{render(view,locals){result=locals;}},error=>{throw error;});
 assert.equal(result.canonicalUrl,visibility==='open'?'https://www.machi-dengon.jp/associations/association/groups/group':undefined);
});

for (const calendarPath of ['/associations/association/public','/associations/association/groups/group']) test(`公開カレンダーは月別リンクを並べずGETフォームで月を切り替える: ${calendarPath}`,async()=>{
 const html=await ejs.renderFile('src/views/partials/association-event-calendar.ejs',{
  calendarPath,calendarAnchor:'events',publicCalendarNavigation:true,calendarWindow:{previousMonth:'2026-12',currentMonth:'2027-01',nextMonth:'2027-02'},months:[],events:[]
 });
 const navigation=html.match(/<nav[\s\S]*?<\/nav>/)[0];
 assert.ok(!navigation.includes('<a '));assert.ok(!navigation.includes('?month='));
 assert.equal((navigation.match(/method="get"/g)||[]).length,3);
 assert.equal((navigation.match(new RegExp(`action="${calendarPath}#events"`,'g'))||[]).length,3);
 assert.match(navigation,/name="month" value="2026-12"/);assert.match(navigation,/name="month" value="2027-02"/);
 assert.match(navigation,/type="month" name="month" value="2027-01"/);
});
test('会員向けカレンダーは従来の月移動リンクを維持する',async()=>{
 const html=await ejs.renderFile('src/views/partials/association-event-calendar.ejs',{
  calendarPath:'/member-calendar',calendarAnchor:'events',calendarWindow:{previousMonth:'2026-12',currentMonth:'2027-01',nextMonth:'2027-02'},months:[],events:[]
 });
 assert.match(html,/href="\/member-calendar\?month=2026-12#events"/);
 assert.match(html,/href="\/member-calendar\?month=2027-02#events"/);
});

import { publicSeoValues, publicPageMetadata } from '../src/services/publicPageSeoService.js';
import { publicSeoRouter } from '../src/routes/publicSeo.js';
test('公開ページごとのタイトル・紹介文による説明文の自動生成と上書き',()=>{
 const association={name:'中央町内会',introduction:'横浜市で\n地域の交流活動をしています。'};
 const meta=publicPageMetadata(association);
 assert.equal(meta.title,'中央町内会のご案内');assert.equal(meta.documentTitle,'中央町内会のご案内 | まちの伝言板');
 assert.equal(meta.metaDescription,'中央町内会：横浜市で 地域の交流活動をしています。');
 const group={name:'清掃クラブ',publicDescription:'毎月清掃します。',publicPageTitle:'地域の清掃活動',publicMetaDescription:'ご参加ください。'};
 assert.deepEqual(publicPageMetadata(association,group),{title:'地域の清掃活動',documentTitle:'地域の清掃活動 | まちの伝言板',metaDescription:'ご参加ください。'});
 assert.equal(publicPageMetadata(association,{name:'クラブ',purpose:'交流します。'}).metaDescription,'中央町内会・クラブ：交流します。');
 assert.ok(publicPageMetadata({...association,introduction:'文'.repeat(5000)}).metaDescription.length<=160);
});
test('検索設定の入力検証と空欄への変更、既存フォームとの互換性',()=>{
 assert.deepEqual(publicSeoValues({}),{});
 assert.deepEqual(publicSeoValues({publicPageTitle:'  タイトル\n 名称 ',publicMetaDescription:''}),{publicPageTitle:'タイトル 名称',publicMetaDescription:''});
 for(const body of [{publicPageTitle:'名'.repeat(121)},{publicMetaDescription:'文'.repeat(301)},{publicPageTitle:['invalid']}])assert.throws(()=>publicSeoValues(body),e=>e.status===400);
});
test('検索設定欄は保存値をエスケープして表示し、タイトルも安全に出力する',async()=>{
 const page={publicPageTitle:'<script>title</script>',publicMetaDescription:'"<説明>'};
 const form=await ejs.renderFile('src/views/partials/public-seo-fields.ejs',{page});
 assert.match(form,/name="publicPageTitle"/);assert.match(form,/name="publicMetaDescription"/);assert.ok(!form.includes('<script>title</script>'));
 const head=await ejs.renderFile('src/views/partials/head.ejs',{title:'default',...publicPageMetadata({name:'町内会',...page}),assetVersion:'test',currentUser:null});
 assert.ok(head.includes('&lt;script&gt;title&lt;/script&gt; | まちの伝言板'));assert.ok(!head.includes('| 町内会管理'));
});
test('サイトマップは有効な町内会と一般公開グループの代表URLのみを取得・出力する',async t=>{
 const query=value=>({select(){return this;},sort(){return this;},lean:async()=>value});
 t.mock.method(NeighborhoodAssociation,'find',filter=>{
  assert.deepEqual(filter,{status:'active',deletedAt:{$exists:false}});
  return query([{_id:'one',optionalFeatures:{groups:true}},{_id:'two',optionalFeatures:{groups:false}}]);
 });
 t.mock.method(AssociationGroup,'find',filter=>{
  assert.deepEqual(filter,{association:{$in:['one']},publicVisibility:'open',status:{$in:['active','suspended']}});
  return query([{_id:'club',association:'one'}]);
 });
 const handler=publicSeoRouter.stack.find(l=>l.route?.path==='/sitemap.xml').route.stack[0].handle;
 let body,type,cache;await handler(request(),{set(k,v){cache=v;},type(v){type=v;return this;},send(v){body=v;}},e=>{throw e;});
 assert.equal(type,'application/xml');assert.equal(cache,'no-store');assert.equal((body.match(/<url>/g)||[]).length,5);
 for(const path of ['/app/','/associations','/associations/one/public','/associations/two/public','/associations/one/groups/club'])assert.ok(body.includes(`<loc>https://www.machi-dengon.jp${path}</loc>`));
 assert.ok(!/\?month=|\/manage|\/login|\/dashboard/.test(body));
});
test('サイトマップのDB障害時には空の成功応答を返さない',async t=>{
 t.mock.method(NeighborhoodAssociation,'find',()=>{throw new Error('offline');});
 const handler=publicSeoRouter.stack.find(l=>l.route?.path==='/sitemap.xml').route.stack[0].handle;
 let error;await handler(request(),{set(){},send(){throw new Error('must not send');}},e=>{error=e;});assert.equal(error.message,'offline');
});
test('robots.txtで代表URLと同じ公開ドメインのサイトマップを案内する',()=>{
 const handler=publicSeoRouter.stack.find(l=>l.route?.path==='/robots.txt').route.stack[0].handle;
 let body;handler(request(),{type(){return this;},send(v){body=v;}},e=>{throw e;});
 assert.ok(body.includes('Sitemap: https://www.machi-dengon.jp/sitemap.xml'));
 assert.ok(!body.includes('Disallow:'));
});

test('公開ページの登録・ログインリンクにはnofollowを指定し、公開紹介リンクは維持する',async()=>{
 const fs=await import('node:fs/promises');
 for(const file of ['src/views/association-list.ejs','src/views/association-join.ejs','src/views/partials/association-page-content.ejs']){
  const source=await fs.readFile(file,'utf8');
  const links=source.match(/<a\b[\s\S]*?href="\/associations\/<%= association\._id %>\/register\/start[^\"]*"[^>]*>/g)||[];
  assert.ok(links.length,file);
  for(const link of links)assert.match(link,/rel="nofollow"/);
 }
});

import { publicSiteCanonical, goodPlaceHistoryCanonical } from '../src/services/publicPageSeoService.js';
test('町内会一覧といいところ一覧は表示選択を除いて正規URLを生成し、別ページは区別する',()=>{
 const req={...request(),query:{selected:'report',utm_source:'test',page:'2'}};
 assert.equal(publicSiteCanonical(req,'/associations'),'https://www.machi-dengon.jp/associations');
 assert.equal(publicSiteCanonical(req,'/associations',{prefecture:'神奈川県',city:'',keyword:''}),'https://www.machi-dengon.jp/associations?prefecture=%E7%A5%9E%E5%A5%88%E5%B7%9D%E7%9C%8C');
 assert.equal(goodPlaceHistoryCanonical(req,'town',1,'newest'),'https://www.machi-dengon.jp/associations/town/good-places');
 assert.equal(goodPlaceHistoryCanonical(req,'town',2,'newest'),'https://www.machi-dengon.jp/associations/town/good-places?page=2');
 assert.equal(goodPlaceHistoryCanonical(req,'town',2,'likes'),'https://www.machi-dengon.jp/associations/town/good-places?page=2&sort=likes');
 assert.throws(()=>publicSiteCanonical(req,'https://other.example/'),/public origin/);
});
