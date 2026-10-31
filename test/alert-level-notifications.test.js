import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { AlertEvent } from '../src/models/alertEvent.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { Notification } from '../src/models/notification.js';
import { NotificationSettings, defaultNotificationChannel, notificationCategories } from '../src/models/notificationSettings.js';
import { PushSubscription } from '../src/models/pushSubscription.js';
import { User } from '../src/models/user.js';
import { alertLevelNotificationRecord, dispatchAlertLevelNotifications } from '../src/services/alertLevelNotificationService.js';
import { deliverNotification, notificationDestination } from '../src/services/notificationService.js';
import { notificationAction } from '../src/services/notificationDestination.js';
const aid='aaaaaaaaaaaaaaaaaaaaaaaa', eid='bbbbbbbbbbbbbbbbbbbbbbbb';
const change={level:3,noticePreviousLevel:2,noticePending:true,noticeKey:'alert-level:incident:3',noticeAssociationName:'中央町内会',at:new Date('2026-10-31T00:00:00Z')};
const event={_id:eid,association:aid,changes:[change]};

test('new and raised warning text calls for early household safety registration and uses the safety destination',()=>{
  const raised=alertLevelNotificationRecord(event,change,'resident');
  assert.match(raised.title,/警戒レベル3に上昇/);
  assert.match(raised.body,/2から3に上がりました/);
  assert.match(raised.body,/できるだけ早く.*世帯の安否情報を登録/);
  assert.match(raised.body,/既に登録済み.*更新/);
  assert.equal(notificationDestination(raised),`/associations/${aid}/safety`);
  assert.equal(notificationAction(raised).actionLabel,'世帯の安否情報を登録');
  const first=alertLevelNotificationRecord(event,{...change,noticePreviousLevel:0},'resident');
  assert.match(first.title,/警戒レベル3発生/);
  assert.match(first.body,/警戒レベル3が登録されました/);
  assert.equal(String(first._id),String(raised._id));
  assert.notEqual(String(raised._id),String(alertLevelNotificationRecord(event,{...change,noticeKey:'next-rise'},'resident')._id));
  assert.notEqual(String(raised._id),String(alertLevelNotificationRecord(event,change,'other')._id));
});

test('outbox includes all distinct active residents, including the registering officer, without exposing archives',async t=>{
  let marked=false, operations;
  t.mock.method(AlertEvent,'find',filter=>{assert.deepEqual(filter,{'changes.noticePending':true});return {select(projection){assert.equal(projection,'_id association changes');return this;},limit(){return this;},lean:async()=>[event]};});
  t.mock.method(AssociationMembership,'find',filter=>{assert.deepEqual(filter,{association:aid,status:'active'});return {distinct:async field=>{assert.equal(field,'user');return ['officer','resident','resident',null];}};});
  t.mock.method(Notification,'bulkWrite',async ops=>{operations=ops;});
  t.mock.method(AlertEvent,'updateOne',async(filter,update,options)=>{assert.equal(filter._id,eid);assert.equal(filter.association,aid);assert.equal(update.$set['changes.$[change].noticePending'],false);assert.deepEqual(options.arrayFilters,[{'change.noticeKey':change.noticeKey}]);marked=true;});
  await dispatchAlertLevelNotifications();
  assert.equal(marked,true);
  assert.deepEqual(operations.map(op=>op.updateOne.update.$setOnInsert.recipient),['officer','resident']);
  assert.ok(operations.every(op=>op.updateOne.upsert && !op.updateOne.update.$set));
});

test('retry after partial queue or acknowledgement failure preserves existing and already-delivered notifications',async t=>{
  t.mock.method(console,'error',()=>{});
  t.mock.method(AlertEvent,'find',()=>({select(){return this;},limit(){return this;},lean:async()=>[event]}));
  t.mock.method(AssociationMembership,'find',()=>({distinct:async()=>['one','two']}));
  const stored=new Map();let attempts=0, acknowledgements=0;
  t.mock.method(Notification,'bulkWrite',async ops=>{
    attempts++;
    for(const op of ops){const id=String(op.updateOne.filter._id);if(!stored.has(id)) stored.set(id,{...op.updateOne.update.$setOnInsert,delivery:{push:{status:'sent'}}});if(attempts===1)throw new Error('partial failure');}
  });
  t.mock.method(AlertEvent,'updateOne',async()=>{acknowledgements++;if(acknowledgements===1)throw new Error('acknowledgement failed');});
  await dispatchAlertLevelNotifications();
  assert.equal(acknowledgements,0);
  await dispatchAlertLevelNotifications();
  await dispatchAlertLevelNotifications();
  assert.equal(stored.size,2);
  assert.ok([...stored.values()].every(n=>n.delivery.push.status==='sent'));
  assert.equal(acknowledgements,2);
});

test('warning delivery shares safety links and honors push/email switches independently',async t=>{
  const values={SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'test',SMTP_PASS:'test',MAIL_FROM:'sender@example.test',PUBLIC_BASE_URL:'https://example.test',WEB_PUSH_PUBLIC_KEY:'test',WEB_PUSH_PRIVATE_KEY:'test',WEB_PUSH_SUBJECT:'mailto:test@example.test'};
  const previous=Object.fromEntries(Object.keys(values).map(name=>[name,process.env[name]]));
  Object.assign(process.env,values);
  t.after(()=>Object.entries(previous).forEach(([name,value])=>{if(value===undefined)delete process.env[name];else process.env[name]=value;}));
  const record=alertLevelNotificationRecord(event,change,'resident');
  let mail,push,result;
  let channel={email:true,push:true};
  t.mock.method(Notification,'findOneAndUpdate',async()=>record);
  t.mock.method(Notification,'countDocuments',async()=>2);
  t.mock.method(NotificationSettings,'findOne',()=>({lean:async()=>({channels:{alert_level:channel}})}));
  t.mock.method(User,'findById',()=>({select:()=>({lean:async()=>({_id:'resident',displayname:'住人',email:'resident@example.test'})})}));
  t.mock.method(PushSubscription,'find',async()=>[{endpoint:'https://push.example.test',keys:{},save:async()=>{}}]);
  t.mock.method(webpush,'setVapidDetails',()=>{});
  t.mock.method(webpush,'sendNotification',async(_,payload)=>{push=JSON.parse(payload);});
  t.mock.method(nodemailer,'createTransport',()=>({sendMail:async message=>{mail=message;}}));
  t.mock.method(Notification,'updateOne',async(_,update)=>{result=update.$set;});
  await deliverNotification(record);
  assert.equal(mail.to,'resident@example.test');
  assert.ok(mail.text.includes(`https://example.test/associations/${aid}/safety`));
  assert.equal(push.url,`/associations/${aid}/safety`);
  assert.equal(result['delivery.email'].status,'sent');
  assert.equal(result['delivery.push'].status,'sent');
  for(const setting of [{email:false,push:true},{email:true,push:false},{email:false,push:false}]) {
    channel=setting;mail=undefined;push=undefined;
    await deliverNotification(record);
    assert.equal(Boolean(mail),setting.email);
    assert.equal(Boolean(push),setting.push);
    assert.equal(result['delivery.email'].status,setting.email?'sent':'skipped');
    assert.equal(result['delivery.push'].status,setting.push?'sent':'skipped');
  }

});

test('warning notification switches reflect saved settings and remain editable',async()=>{
  assert.deepEqual(defaultNotificationChannel('alert_level'),{push:true,email:true});
  const html=await ejs.renderFile('src/views/notification-settings.ejs',{title:'設定',assetVersion:'test',currentUser:null,currentPath:'/',notice:null,csrfToken:'csrf',showNotificationPrompt:false,hideDangerCompose:true,association:{_id:aid,name:'町内会'},categories:notificationCategories,channels:{alert_level:{email:false,push:false}}});
  assert.match(html,/name="alert_level_push"/);
  assert.match(html,/name="alert_level_email"/);
  assert.doesNotMatch(html,/name="alert_level_(?:push|email)"[^>]*(?:checked|disabled)/);
});
