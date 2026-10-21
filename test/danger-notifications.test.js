import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { queueDangerReportNotifications } from '../src/services/dangerReportNotificationService.js';
import { deliverNotification, notificationDestination } from '../src/services/notificationService.js';
import { Notification } from '../src/models/notification.js';
import { NotificationSettings, defaultNotificationChannel } from '../src/models/notificationSettings.js';
import { PushSubscription } from '../src/models/pushSubscription.js';
import { User } from '../src/models/user.js';
test('queues one alert per active member, scoped to the report association', async()=>{
  let records;
  await queueDangerReportNotifications({_id:'report',association:'association',author:'author',title:'倒木'}, {
    membershipModel:{find(filter){assert.deepEqual(filter,{association:'association',status:'active'});return {distinct:async field=>{assert.equal(field,'user');return ['author','resident','resident',null];}};}},
    notificationModel:{insertMany:async values=>{records=values;}}
  });
  assert.equal(records.length,2);assert.deepEqual(records.map(record=>record.recipient),['author','resident']);
  assert.ok(records.every(record=>record.type==='danger_report' && record.relatedType==='DangerReport' && record.relatedId==='report' && record.queuedAt instanceof Date));
});
test('danger reports default to both channels and link to the report detail',()=>{
  assert.deepEqual(defaultNotificationChannel('danger_report'),{push:true,email:true});
  assert.deepEqual(defaultNotificationChannel('question'),{push:true,email:false});
  assert.equal(notificationDestination({type:'danger_report',association:'association',relatedId:'report'}),'/associations/association/dangers/report');
});
test('dispatches email and Push independently and respects explicit channel OFF',async t=>{
  const env={SMTP_HOST:'smtp.test',SMTP_USER:'user',SMTP_PASS:'pass',MAIL_FROM:'test@example.test',PUBLIC_BASE_URL:'https://app.example.test',WEB_PUSH_PUBLIC_KEY:'public',WEB_PUSH_PRIVATE_KEY:'private',WEB_PUSH_SUBJECT:'mailto:test@example.test'};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const record={_id:'notification',association:'association',recipient:'recipient',type:'danger_report',relatedId:'report',title:'緊急情報',body:'詳細を確認してください'};
  let settings=null,mail,push,delivery;
  t.mock.method(Notification,'findOneAndUpdate',async()=>record);
  t.mock.method(Notification,'countDocuments',async()=>1);
  t.mock.method(Notification,'updateOne',async(_filter,update)=>{delivery=update.$set;});
  t.mock.method(NotificationSettings,'findOne',()=>({lean:async()=>settings}));
  t.mock.method(User,'findById',()=>({select:()=>({lean:async()=>({_id:'recipient',email:'resident@example.test'})})}));
  t.mock.method(PushSubscription,'find',async()=>[{endpoint:'https://push.example.test',keys:{},save:async()=>{}}]);
  t.mock.method(nodemailer,'createTransport',()=>({sendMail:async value=>{mail=value;}}));
  t.mock.method(webpush,'setVapidDetails',()=>{});
  t.mock.method(webpush,'sendNotification',async(_subscription,payload)=>{push=JSON.parse(payload);});
  await deliverNotification(record);
  assert.equal(mail.to,'resident@example.test');assert.match(mail.text,/https:\/\/app.example.test\/associations\/association\/dangers\/report/);
  assert.equal(push.url,'/associations/association/dangers/report');assert.equal(delivery['delivery.email'].status,'sent');assert.equal(delivery['delivery.push'].status,'sent');
  t.mock.method(nodemailer,'createTransport',()=>({sendMail:async()=>{throw new Error('SMTP unavailable');}}));
  await deliverNotification(record);assert.equal(delivery['delivery.email'].status,'failed');assert.equal(delivery['delivery.push'].status,'sent');
  settings={channels:{danger_report:{push:false,email:false}}};
  const count=webpush.sendNotification.mock.callCount();await deliverNotification(record);
  assert.equal(webpush.sendNotification.mock.callCount(),count);assert.equal(delivery['delivery.email'].status,'skipped');assert.equal(delivery['delivery.push'].status,'skipped');
});
