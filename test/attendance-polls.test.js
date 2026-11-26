import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import ExcelJS from 'exceljs';
import { pollValues, responseValues, resolveAttendanceRecipients, attendanceSummary, attendanceWorkbook } from '../src/services/attendancePollService.js';
import { AttendancePoll, AttendanceResponse } from '../src/models/attendancePoll.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { attendancePollsRouter } from '../src/routes/attendancePolls.js';
import { notificationAction } from '../src/services/notificationDestination.js';
const now = new Date('2026-11-27T01:00:00Z');
const input = { title: '忘年会', memo: '集合', candidateDate: ['2026-12-01','2026-12-02'], candidateTime: ['18:00','19:00'], deadline: '2026-11-30' };
const id = () => new mongoose.Types.ObjectId();
const query = value => ({ sort() { return this; }, lean: async () => value, populate() { return this; }, select() { return this; } });
test('候補日時と締め切りは日本時間の当日末で保存する', () => {
 const poll = pollValues(input, now);
 assert.equal(poll.deadline.toISOString(), '2026-11-30T14:59:59.999Z');
 assert.deepEqual(poll.candidates, [{date:'2026-12-01',time:'18:00'},{date:'2026-12-02',time:'19:00'}]);
 for (const patch of [{candidateDate:['2026-02-30','2026-99-99']},{candidateTime:['24:00','19:00']},{deadline:'2026-11-26'},{candidateDate:[]},{candidateDate:['2026-12-01','2026-12-01'],candidateTime:['18:00','18:00']}]) assert.throws(() => pollValues({...input,...patch},now), error => error.status === 400);
});
test('全候補の回答を必須にし、締め切り後は更新を拒否する', () => {
 const poll = pollValues(input,now);
 assert.deepEqual(responseValues({answer0:'○',answer1:'△',comment:'調整中'},poll,now), {answers:['○','△'],comment:'調整中'});
 assert.throws(() => responseValues({answer0:'○'},poll,now), /すべて/);
 assert.throws(() => responseValues({answer0:'○',answer1:'×'},poll,new Date('2026-11-30T15:00:00Z')), error => error.status === 409);
});
const context = {scope:'officer',userId:'a',members:['a','b','c','d'].map(_id => ({user:{_id}})),officers:[{user:'a',department:'dept'},{user:'b',department:'dept'},{user:'d',department:'other'}],leaders:[{representative:'b'},{representative:'c'}],departments:[{_id:'dept'},{_id:'other'}]};
test('役員・所属部会・班長包含・個別対象を解決し重複送信を防ぐ', () => {
 assert.deepEqual(resolveAttendanceRecipients({audience:'officers'},context),['a','d']);
 assert.deepEqual(resolveAttendanceRecipients({audience:'department',department:'dept',includeLeaders:'on'},context),['a','b','c']);
 assert.deepEqual(resolveAttendanceRecipients({audience:'officer-selected',recipients:['a','a'],includeLeaders:'on'},context),['a','b','c']);
 assert.deepEqual(resolveAttendanceRecipients({audience:'all'},context),['a','b','c','d']);
 assert.throws(() => resolveAttendanceRecipients({audience:'selected',recipients:['outsider']},context),e=>e.status===403);
 assert.throws(() => resolveAttendanceRecipients({audience:'officer-selected',recipients:['c']},context),e=>e.status===403);
 assert.throws(() => resolveAttendanceRecipients({audience:'department',department:'outsider'},context),e=>e.status===403);
});
for(const scope of ['group','district']) test(`${scope}は所属メンバー全員または個別のみ選択可能`,()=>{
 const c={...context,scope,members:context.members.slice(0,2)};
 assert.deepEqual(resolveAttendanceRecipients({audience:'all'},c),['a','b']);
 assert.deepEqual(resolveAttendanceRecipients({audience:'selected',recipients:'b'},c),['b']);
 assert.throws(()=>resolveAttendanceRecipients({audience:'selected',recipients:'c'},c),e=>e.status===403);
 assert.throws(()=>resolveAttendanceRecipients({audience:'officers'},c));
});
test('集計とExcelで未回答とコメント、数式に見える氏名を文字列として保持する',async()=>{
 const poll={...pollValues(input,now),recipients:['a','b']};
 const responses=[{user:'a',answers:['○','×'],comment:'<script>test</script>'}];
 assert.deepEqual(attendanceSummary(poll,responses).map(r=>r.counts),[{'○':1,'△':0,'×':0},{'○':0,'△':0,'×':1}]);
 const buffer=await attendanceWorkbook(poll,responses,[{_id:'a',displayname:'=1+1'},{_id:'b',displayname:'未回答'}]);
 const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);
 assert.equal(book.getWorksheet('出欠表').getCell('A2').value,'=1+1');
 assert.equal(book.getWorksheet('出欠表').getCell('D2').value,'<script>test</script>');
 assert.equal(book.getWorksheet('出欠表').getCell('B3').value,'未回答');
});
for(const mode of ['outside','departed','cross-association','export-recipient']) test(`アクセス制限: ${mode}`,async t=>{
 const user=id(),association=id(),poll={_id:id(),association,creator:id(),scope:'officer',recipients:mode==='outside'?[]:[user],...pollValues(input,now)};
 t.mock.method(AttendancePoll,'findOne', filter=>{assert.equal(filter.association,String(association));return query(mode==='cross-association'?null:poll);});
 t.mock.method(AssociationMembership,'findOne',()=>query(mode==='departed'?null:{user,status:'active'}));
 const responses=t.mock.method(AttendanceResponse,'find',()=>{throw new Error('must not read answers');});
 const path=mode==='export-recipient'?'/:associationId/attendance/:pollId/responses.xlsx':'/:associationId/attendance/:pollId';
 const route=attendancePollsRouter.stack.find(layer=>layer.route?.path===path).route;
 let error;await route.stack.at(-1).handle({params:{associationId:String(association),pollId:String(poll._id)},user:{_id:user}}, {set(){}},e=>{error=e;});
 assert.equal(error.status,mode==='cross-association'?404:403);assert.equal(responses.mock.callCount(),0);
});
test('回答ページは他人のコメントを受け取らず、本人回答と人数だけを表示する',async t=>{
 const user=id(),association=id(),poll={_id:id(),association,creator:id(),scope:'officer',recipients:[user],...pollValues(input,now)};
 t.mock.method(AttendancePoll,'findOne',()=>query(poll));t.mock.method(AssociationMembership,'findOne',()=>query({user,status:'active'}));
 t.mock.method(AttendanceResponse,'find',()=>query([{user,answers:['○','△'],comment:'自分'},{user:id(),answers:['×','×'],comment:'他人の秘密'}]));
 const route=attendancePollsRouter.stack.find(l=>l.route?.path==='/:associationId/attendance/:pollId').route;
 let data;await route.stack.at(-1).handle({params:{associationId:String(association),pollId:String(poll._id)},user:{_id:user}},{set(){},render(view,locals){data=locals;}},e=>{throw e;});
 assert.deepEqual(data.responses,[]);assert.equal(data.ownResponse.comment,'自分');
 const html=await ejs.renderFile('src/views/attendance-detail.ejs',{...data,assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'token'});
 assert.ok(!html.includes('他人の秘密'));assert.match(html,/結果の集計/);
});
test('管理ページは候補カレンダーと安全なJSONを生成し、通知は回答ページへ進む',async()=>{
 const association={_id:id(),name:'町内会'}; const p={_id:id(),title:'</script><script>alert(1)</script>',candidates:[{date:'2026-12-01'}],deadline:now};
 const html=await ejs.renderFile('src/views/attendance-manage.ejs',{title:'出欠',...context,scope:undefined,pollScope:context.scope,association,group:null,districtGroup:null,districtGroups:[],polls:[p],base:'/attendance',scopeQuery:'',assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'token'});
 assert.ok(!html.includes(p.title));assert.ok(html.includes('\\u003c/script>'));
 assert.equal(notificationAction({type:'attendance_poll',association:association._id,relatedId:p._id}).actionUrl,`/associations/${association._id}/attendance/${p._id}`);
});

test('本人の再回答は同じ回答を更新し、通知を既読にする',async t=>{
 const { Notification } = await import('../src/models/notification.js');
 const user=id(), association=id(), poll={_id:id(),association,creator:id(),scope:'officer',recipients:[user],...pollValues(input,now),deadline:new Date('2099-12-31')};
 t.mock.method(AttendancePoll,'findOne',()=>query(poll)); t.mock.method(AssociationMembership,'findOne',()=>query({user,status:'active'}));
 const saves=t.mock.method(AttendanceResponse,'updateOne',async(filter,update,options)=>{assert.equal(String(filter.user),String(user));assert.equal(String(filter.poll),String(poll._id));assert.equal(options.upsert,true);assert.deepEqual(update.$set.answers,['△','×']);});
 const notices=t.mock.method(Notification,'updateMany',async filter=>{assert.equal(String(filter.recipient),String(user));assert.equal(filter.type,'attendance_poll');});
 const route=attendancePollsRouter.stack.find(l=>l.route?.path==='/:associationId/attendance/:pollId/respond').route;
 const req={params:{associationId:String(association),pollId:String(poll._id)},user:{_id:user},session:{},body:{answer0:'△',answer1:'×',comment:'変更'}};
 let redirect;await route.stack.at(-1).handle(req,{redirect(url){redirect=url;}},e=>{throw e;});
 assert.equal(saves.mock.callCount(),1);assert.equal(notices.mock.callCount(),1);assert.ok(redirect.endsWith(String(poll._id)));
});

test('作成者のExcelは暗号化され、画面と同じパスワードで開く',async t=>{
 const crypto=await import('officecrypto-tool');
 const { RoleDefinition }=await import('../src/models/role.js');
 const { AnnualOfficer }=await import('../src/models/annualOfficer.js');
 const { NeighborhoodAssociation }=await import('../src/models/neighborhoodAssociation.js');
 const user=id(),association=id(),poll={_id:id(),association,creator:user,scope:'officer',recipients:[user],...pollValues(input,now)};
 t.mock.method(AttendancePoll,'findOne',()=>query(poll));t.mock.method(NeighborhoodAssociation,'findOne',()=>query({_id:association}));t.mock.method(AssociationMembership,'findOne',()=>query({user,status:'active'}));
 t.mock.method(RoleDefinition,'find',()=>query([]));t.mock.method(AnnualOfficer,'exists',async()=>true);
 t.mock.method(AttendanceResponse,'find',()=>query([{user,answers:['○','△'],comment:'参加'}]));
 t.mock.method(AssociationMembership,'find',()=>query([{user:{_id:user,displayname:'参加者'}}]));
 const { AnnualLeaderAssignment }=await import('../src/models/annualLeaderAssignment.js');
 const { Department }=await import('../src/models/organization.js');
 t.mock.method(AnnualOfficer,'find',()=>query([{user}]));t.mock.method(AnnualLeaderAssignment,'find',()=>query([]));t.mock.method(Department,'find',()=>query([]));
 const req={params:{associationId:String(association),pollId:String(poll._id)},user:{_id:user},session:{}};
 const detail=attendancePollsRouter.stack.find(l=>l.route?.path==='/:associationId/attendance/:pollId').route;
 let view;await detail.stack.at(-1).handle(req,{set(){},render(_,data){view=data;}},e=>{throw e;});
 assert.equal(view.exportPassword.length,20);
 const html=await ejs.renderFile('src/views/attendance-detail.ejs',{...view,assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'token'});
 assert.ok(html.includes(view.exportPassword));assert.match(html,/出欠表をダウンロード/);
 const route=attendancePollsRouter.stack.find(l=>l.route?.path==='/:associationId/attendance/:pollId/responses.xlsx').route;
 let output;await route.stack.at(-1).handle(req,{set(){},attachment(){},send(data){output=data;}},e=>{throw e;});
 assert.equal(crypto.default.isEncrypted(output),true);
 const plain=await crypto.default.decrypt(output,{password:view.exportPassword});const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(plain);
 assert.equal(workbook.getWorksheet('出欠表').getCell('B2').value,'○');
});

test('作成時に対象者を確定し、各人へ回答リンク付き通知を作成する',async t=>{
 const { RoleDefinition }=await import('../src/models/role.js');
 const { AnnualOfficer }=await import('../src/models/annualOfficer.js');
 const { AnnualLeaderAssignment }=await import('../src/models/annualLeaderAssignment.js');
 const { NeighborhoodAssociation }=await import('../src/models/neighborhoodAssociation.js');
 const { Department }=await import('../src/models/organization.js');
 const { Notification }=await import('../src/models/notification.js');
 const user=id(),other=id(),association=id(),pollId=id();
 t.mock.method(NeighborhoodAssociation,'findOne',()=>query({_id:association}));t.mock.method(AssociationMembership,'findOne',()=>query({user,status:'active'}));
 t.mock.method(RoleDefinition,'find',()=>query([]));t.mock.method(AnnualOfficer,'exists',async()=>true);
 t.mock.method(AnnualOfficer,'find',()=>query([{user},{user:other}]));t.mock.method(AnnualLeaderAssignment,'find',()=>query([]));t.mock.method(Department,'find',()=>query([]));
 t.mock.method(AssociationMembership,'find',()=>query([{user:{_id:user,displayname:'作成者'}},{user:{_id:other,displayname:'対象者'}}]));
 let saved,notices;
 t.mock.method(AttendancePoll,'create',async values=>{saved=values;return {_id:pollId,...values};});
 t.mock.method(Notification,'insertMany',async values=>{notices=values;return [];});
 const route=attendancePollsRouter.stack.find(l=>l.route?.path==='/:associationId/attendance'&&l.route.methods.post).route;
 const req={params:{associationId:String(association)},user:{_id:user},session:{},body:{...input,candidateDate:['2099-12-01','2099-12-02'],deadline:'2099-11-30',scope:'officer',audience:'selected',recipients:[String(other),String(other)]}};
 let redirect;await route.stack.at(-1).handle(req,{redirect(url){redirect=url;}},e=>{throw e;});
 assert.deepEqual(saved.recipients,[String(other)]);assert.equal(saved.scope,'officer');assert.equal(notices.length,1);assert.equal(notices[0].recipient,String(other));
 assert.ok(notices[0].body.includes(`/associations/${association}/attendance/${pollId}`));assert.ok(redirect.endsWith(String(pollId)));
});

test('登録フォームは共通デザインのモーダルに収まり、役員と住民は別の単一選択になる',async()=>{
 const association={_id:id(),name:'町内会'};
 const html=await ejs.renderFile('src/views/attendance-manage.ejs',{title:'出欠',...context,scope:undefined,pollScope:'officer',association,group:null,districtGroup:null,districtGroups:[],polls:[],base:'/attendance',scopeQuery:'',assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'token'});
 const dialog=html.match(/<dialog\b[\s\S]*?<\/dialog>/)?.[0];
 assert.ok(dialog);assert.match(dialog,/class="equipment-day-dialog attendance-dialog"/);
 assert.match(dialog,/<form[^>]+class="form-stack"/);assert.match(dialog,/name="title"/);
 assert.equal((dialog.match(/name="targetKind"/g)||[]).length,2);
 assert.equal((dialog.match(/name="officerAudience"/g)||[]).length,3);
 assert.equal((dialog.match(/name="residentAudience"/g)||[]).length,2);
 assert.match(dialog,/<input type="radio" name="officerAudience" value="officers" checked>/);
 assert.match(dialog,/<input type="radio" name="residentAudience" value="all" checked disabled>/);
 assert.match(dialog,/name="audience" id="attendance-audience" value="officers"/);
 assert.match(html,/class="equipment-calendar attendance-calendar"/);
});
for(const scope of ['group','district'])test(`${scope}のモーダルは全員と個別の二択で登録する`,async()=>{
 const association={_id:id(),name:'町内会'},group=scope==='group'?{_id:id(),name:'グループ'}:null;
 const html=await ejs.renderFile('src/views/attendance-manage.ejs',{title:'出欠',...context,scope:undefined,pollScope:scope,association,group,districtGroup:scope==='district'?id():null,districtGroups:[],polls:[],base:'/attendance',scopeQuery:'',assetVersion:'test',currentUser:null,currentPath:'/',csrfToken:'token'});
 assert.equal((html.match(/type="radio" name="audience"/g)||[]).length,2);
 assert.ok(!html.includes('name="officerAudience"'));assert.match(html,/name="audience" value="all" checked/);
 assert.match(html,/id="attendance-dialog"/);
});

test('日本時間で登録日より前の候補を拒否し、当日は許可する',()=>{
 const midnight = new Date('2026-11-27T15:00:00Z');
 assert.throws(()=>pollValues({...input,candidateDate:['2026-11-27','2026-12-02']},midnight),/過去の日付/);
 assert.equal(pollValues({...input,candidateDate:['2026-11-28','2026-12-02']},midnight).candidates[0].date,'2026-11-28');
});
test('複数の部会の役員をまとめ、部会や会員の重複を除外する',()=>{
 const c={...context,officers:[...context.officers,{user:'a',department:'other'}]};
 assert.deepEqual(resolveAttendanceRecipients({audience:'department',department:['dept','other','dept']},c),['a','d']);
 assert.deepEqual(resolveAttendanceRecipients({audience:'department',department:['dept','other'],includeLeaders:'on'},c),['a','b','d','c']);
 assert.throws(()=>resolveAttendanceRecipients({audience:'department',department:[]},c),/1つ以上/);
 assert.throws(()=>resolveAttendanceRecipients({audience:'department',department:['dept','outside']},c),e=>e.status===403);
});
test('回答ボタンは選択を切り替え、未回答での送信を止めて選択後に解除する',async()=>{
 const vm=await import('node:vm'); const fs=await import('node:fs/promises');
 const makeGroup=()=>{
  const input={value:''};
  const buttons=['○','△','×'].map(answer=>({dataset:{answer},attributes:{'aria-pressed':'false'},events:{},setAttribute(name,value){this.attributes[name]=value;},addEventListener(type,fn){this.events[type]=fn;},focus(){this.focused=true;}}));
  return {input,buttons,querySelector(selector){return selector==='input[type="hidden"]'?input:buttons[0];},querySelectorAll(){return buttons;}};
 };
 const groups=[makeGroup(),makeGroup()],error={hidden:true},events={};
 const form={querySelectorAll(){return groups;},addEventListener(type,fn){events[type]=fn;}};
 vm.runInNewContext(await fs.readFile('src/public/attendance-response.js','utf8'),{document:{getElementById(id){return id==='attendance-response-form'?form:error;}}});
 let prevented=false;events.submit({preventDefault(){prevented=true;}});assert.ok(prevented);assert.equal(error.hidden,false);assert.equal(groups[0].buttons[0].focused,true);
 groups[0].buttons[0].events.click();assert.equal(groups[0].input.value,'○');assert.equal(groups[0].buttons[0].attributes['aria-pressed'],'true');
 groups[0].buttons[1].events.click();assert.equal(groups[0].input.value,'△');assert.equal(groups[0].buttons[0].attributes['aria-pressed'],'false');assert.equal(groups[0].buttons[1].attributes['aria-pressed'],'true');
 groups[1].buttons[2].events.click();assert.equal(error.hidden,true);
 prevented=false;events.submit({preventDefault(){prevented=true;}});assert.equal(prevented,false);
});
