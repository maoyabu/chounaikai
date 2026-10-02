import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ejs from 'ejs';
import { equipmentLoanTimes, equipmentWindowCapacity, equipmentDaySchedule, equipmentReservations, nextEquipmentDate } from '../src/services/equipmentTimeService.js';
import { requestEquipmentLoan, setEquipmentLoanBlock, japanDate } from '../src/services/equipmentService.js';
import { AssociationEquipment, EquipmentLoan, EquipmentSettings } from '../src/models/equipment.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { RoleDefinition, RoleAssignment } from '../src/models/role.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
const id = () => new mongoose.Types.ObjectId();
const associationId = id(), userId = id(), equipmentId = id();
const date = nextEquipmentDate(japanDate());
const q = value => ({ lean: async () => value, select() { return this; }, distinct: async () => [], then(resolve,reject) { return Promise.resolve(value).then(resolve,reject); } });
const access = (t, officer = true) => {
  t.mock.method(EquipmentSettings,'findOne',()=>q(null));
  t.mock.method(NeighborhoodAssociation,'findOne',()=>q({_id:associationId}));
  t.mock.method(AssociationMembership,'findOne',()=>q({status:'active'}));
  t.mock.method(RoleDefinition,'find',()=>q([]));
  t.mock.method(AnnualOfficer,'exists',async()=>officer ? {_id:id()} : null);
  for (const model of [RoleAssignment,AnnualOfficer,AssociationMembership]) t.mock.method(model,'find',()=>q([]));
};
const timed = (startTime,endTime,quantity=1) => ({ _id:id(),status:'pending',startDate:date,endDate:date,startTime,endTime,allDay:false,quantity,...equipmentLoanTimes({startDate:date,endDate:date,startTime,endTime,allDay:false}) });
test('Japanese time, midnight end, invalid times and legacy all-day conversion',()=>{
  const times = equipmentLoanTimes({startDate:'2026-10-03',endDate:'2026-10-03',startTime:'09:00',endTime:'24:00',allDay:false});
  assert.equal(times.startAt.toISOString(),'2026-10-03T00:00:00.000Z');
  assert.equal(times.endAt.toISOString(),'2026-10-03T15:00:00.000Z');
  assert.equal(equipmentLoanTimes({startDate:date,endDate:date}).allDay,true);
  for (const [startTime,endTime] of [['24:00','24:00'],['12:00','11:00'],['09:00','09:00'],['9:00','10:00'],['09:00','25:00']]) assert.throws(()=>equipmentLoanTimes({startDate:date,endDate:date,startTime,endTime,allDay:false}),{status:400});
});
test('half-open reservations allow adjacent periods and account for partial quantity',()=>{
  const loans=[timed('09:00','12:00',2),timed('12:00','15:00',1)];
  const window=timed('09:00','15:00');
  assert.equal(equipmentWindowCapacity({quantity:3},loans,window.startAt.getTime(),window.endAt.getTime()),1);
  const segments=equipmentDaySchedule({quantity:3,lendable:true},loans,date);
  assert.deepEqual(segments.map(s=>[s.startTime,s.endTime,s.available]),[['00:00','09:00',3],['09:00','12:00',1],['12:00','15:00',2],['15:00','24:00',3]]);
  const next=timed('15:00','16:00'); assert.equal(equipmentWindowCapacity({quantity:1},loans,next.startAt.getTime(),next.endAt.getTime()),1);
});
test('NG days and legacy all-day loans block availability; orphan claims stay reserved',()=>{
  const legacy={_id:id(),startDate:date,endDate:date,status:'approved',quantity:1};
  assert.equal(equipmentDaySchedule({quantity:1,lendable:true},[legacy],date)[0].available,0);
  assert.equal(equipmentDaySchedule({quantity:5,lendable:true,loanBlocks:[{startDate:date,endDate:date}]},[],date)[0].blocked,true);
  const slot={loanId:id(),...timed('10:00','11:00'),quantity:1};
  assert.equal(equipmentReservations({reservations:[slot]},[]).length,1);
  assert.equal(equipmentReservations({reservations:[slot]},[{_id:slot.loanId,status:'cancelled'}]).length,0);
});
test('loan claims use version fencing on standalone MongoDB and save exact times',async t=>{
  access(t,false);const item={_id:equipmentId,name:'会議室',quantity:1,reservationVersion:4};
  t.mock.method(AssociationEquipment,'findOne',()=>q(item));t.mock.method(EquipmentLoan,'find',()=>q([]));
  t.mock.method(mongoose.connection,'transaction',()=>{throw Error('transaction must not run');});
  t.mock.method(AssociationEquipment,'updateOne',async(filter,update)=>{assert.equal(filter.reservationVersion,4);assert.equal(update.$set.reservations.length,1);assert.equal(update.$inc.reservationVersion,1);return {matchedCount:1};});
  t.mock.method(EquipmentLoan,'create',async loan=>{assert.equal(loan.allDay,false);assert.equal(loan.startTime,'09:00');assert.equal(loan.endTime,'10:00');return loan;});
  await requestEquipmentLoan({associationId,userId,equipmentId,input:{startDate:date,endDate:date,startTime:'09:00',endTime:'10:00',quantity:1,purpose:'会議'}});
});
test('concurrent changes reject admission and failed writes release only their own claim',async t=>{
  access(t);t.mock.method(AssociationEquipment,'findOne',()=>q({quantity:1,reservationVersion:3}));t.mock.method(EquipmentLoan,'find',()=>q([]));
  const input={startDate:date,endDate:date,allDay:'on',quantity:1,purpose:'会議'};
  const update=t.mock.method(AssociationEquipment,'updateOne',async()=>({matchedCount:0}));
  await assert.rejects(requestEquipmentLoan({associationId,userId,equipmentId,input}),{status:409});
  const writes=[]; update.mock.mockImplementation(async(filter,change)=>{writes.push(change);return {matchedCount:1};});
  t.mock.method(EquipmentLoan,'create',async()=>{throw Error('write failed');});
  await assert.rejects(requestEquipmentLoan({associationId,userId,equipmentId,input}),/write failed/);
  assert.equal(String(writes[0].$set.reservations[0].loanId),String(writes[1].$pull.reservations.loanId));
});
test('only officers can set NG days, bookings prevent NG, and blocks can be removed',async t=>{
  access(t,false);const args={associationId,userId,equipmentId,input:{startDate:date,endDate:date,reason:'棚卸し'}};
  await assert.rejects(setEquipmentLoanBlock(args),{status:403});
  t.mock.method(AnnualOfficer,'exists',async()=>({_id:id()}));
  const blockId=id(),item={quantity:1,reservationVersion:7,loanBlocks:[{_id:blockId,startDate:date,endDate:date,reason:'保守'}]};
  t.mock.method(AssociationEquipment,'findOne',()=>q(item));const loans=t.mock.method(EquipmentLoan,'find',()=>q([timed('10:00','11:00')]));
  await assert.rejects(setEquipmentLoanBlock(args),{status:409});
  loans.mock.mockImplementation(()=>q([]));
  const writes=[];t.mock.method(AssociationEquipment,'updateOne',async(filter,update)=>{assert.equal(filter.reservationVersion,7);writes.push(update);return {matchedCount:1};});
  await setEquipmentLoanBlock(args);assert.equal(writes[0].$set.loanBlocks.at(-1).reason,'棚卸し');
  await setEquipmentLoanBlock({...args,blockId});assert.equal(writes[1].$set.loanBlocks.length,0);
});
test('calendar renders safe JSON and officer controls with timed requests',async()=>{
 const html=await ejs.renderFile('src/views/equipment-loans.ejs',{assetVersion:'test',showNotificationPrompt:false,currentPath:'',title:'貸出',currentUser:null,user:null,notice:null,csrfToken:'token',base:'/associations/test/equipment',canAnswer:true,item:{_id:equipmentId,name:'会議室',quantity:1,unit:'室',lendable:true,loanBlocks:[{reason:'</script><script>bad</script>'}]},cells:[],requests:[],today:date,month:date.slice(0,7),previous:'2026-09',next:'2026-11'});
 assert.ok(html.includes("/assets/equipment-calendar.js"));assert.match(html,/name="startTime"/);assert.match(html,/利用NGの日を設定/);assert.doesNotMatch(html,/<script>bad/);
});
test('timed NG blocks only their interval and splits the daily timeline', () => {
  const block = { startDate: date, endDate: date, allDay: false, startTime: '12:00', endTime: '14:00', ...equipmentLoanTimes({startDate:date,endDate:date,allDay:false,startTime:'12:00',endTime:'14:00'}) };
  const item = {quantity:2,lendable:true,loanBlocks:[block]};
  assert.deepEqual(equipmentDaySchedule(item,[],date).map(s=>[s.startTime,s.endTime,s.available,s.blocked]),[['00:00','12:00',2,false],['12:00','14:00',0,true],['14:00','24:00',2,false]]);
  for (const [startTime,endTime,capacity] of [['10:00','12:00',2],['14:00','16:00',2],['11:00','13:00',0]]) {
    const window=timed(startTime,endTime);assert.equal(equipmentWindowCapacity(item,[],window.startAt.getTime(),window.endAt.getTime()),capacity);
  }
});
test('NG settings preserve exact times and allow adjacent reservations', async t => {
  access(t);t.mock.method(AssociationEquipment,'findOne',()=>q({quantity:1,reservationVersion:1}));
  t.mock.method(EquipmentLoan,'find',()=>q([timed('09:00','12:00')]));
  const writes=[];t.mock.method(AssociationEquipment,'updateOne',async(filter,update)=>{writes.push(update);return {matchedCount:1};});
  const args={associationId,userId,equipmentId,input:{startDate:date,endDate:date,startTime:'12:00',endTime:'14:00',reason:'保守'}};
  await setEquipmentLoanBlock(args);
  assert.equal(writes[0].$set.loanBlocks[0].allDay,false);assert.equal(writes[0].$set.loanBlocks[0].startTime,'12:00');
  await assert.rejects(setEquipmentLoanBlock({...args,input:{...args.input,startTime:'11:00'}}),{status:409});
});
test('purchase wishes are excluded from lending even if legacy lending flag remains set', async t => {
  access(t,false);
  const item={_id:equipmentId,name:'camera',quantity:1,lendable:true,wishlist:true,reservationVersion:1};
  assert.equal(equipmentDaySchedule(item,[],date)[0].available,0);
  t.mock.method(AssociationEquipment,'findOne',filter=>{assert.equal(filter.wishlist.$ne,true);return q(null);});
  await assert.rejects(requestEquipmentLoan({associationId,userId,equipmentId,input:{startDate:date,endDate:date,startTime:'09:00',endTime:'10:00',quantity:1,purpose:'photo'}}),{status:404});
  const html=await ejs.renderFile('src/views/equipment-loans.ejs',{assetVersion:'test',showNotificationPrompt:false,currentPath:'',title:'Calendar',currentUser:null,notice:null,csrfToken:'token',base:'/associations/test/equipment',canAnswer:false,item,cells:[],requests:[],today:date,month:date.slice(0,7),previous:'2026-09',next:'2026-11'});
  assert.doesNotMatch(html,/id="equipment-day-loan"/);
});
