import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { deleteDangerReport } from '../src/services/dangerReportDeletionService.js';
import { dangerReportsRouter } from '../src/routes/dangerReports.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const input = { associationId: '507f1f77bcf86cd799439011', reportId: '507f1f77bcf86cd799439012', userId: 'user' };
function fixture(canAnswer = true) {
  const calls = [];
  const attachment = { fileId: 'photo' };
  const deps = {
    loadAccess: async args => {assert.equal(args.associationId,input.associationId);assert.equal(args.userId,input.userId);return {canAnswer};},
    model: {findOneAndDelete: filter => {calls.push(filter);return {lean:async()=>({photoAttachment:attachment})};}},
    attachmentContext:async association => {assert.equal(association,input.associationId);return {client:'client'};},
    removeMessageAttachments:async (files,client) => {assert.deepEqual(files,[attachment]);assert.equal(client,'client');calls.push('photo removed');return [{status:'fulfilled'}];}
  };
  return {deps,calls};
}
test('officer/manager authority permits scoped deletion and Drive photo cleanup', async () => {
  const {deps,calls}=fixture();
  assert.deepEqual(await deleteDangerReport(input,deps),{photoCleanupPending:false});
  assert.deepEqual(calls,[{_id:input.reportId,association:input.associationId},'photo removed']);
});
test('ordinary resident including original author cannot delete', async () => {
  const {deps,calls}=fixture(false);
  await assert.rejects(deleteDangerReport(input,deps),{status:403});assert.equal(calls.length,0);
});
test('access denied to another association prevents any deletion', async () => {
  const {deps,calls}=fixture();deps.loadAccess=async()=>{throw Object.assign(new Error('forbidden'),{status:403});};
  await assert.rejects(deleteDangerReport(input,deps),{status:403});assert.equal(calls.length,0);
});
test('missing report cannot trigger Drive deletion', async () => {
  const {deps,calls}=fixture();deps.model.findOneAndDelete=()=>({lean:async()=>null});
  await assert.rejects(deleteDangerReport(input,deps),{status:404});assert.equal(calls.length,0);
});
test('Drive failures report cleanup warning after report deletion', async () => {
  const {deps}=fixture();deps.removeMessageAttachments=async()=>[{status:'rejected'}];
  assert.equal((await deleteDangerReport(input,deps)).photoCleanupPending,true);
  deps.attachmentContext=async()=>{throw new Error('disconnected');};
  assert.equal((await deleteDangerReport(input,deps)).photoCleanupPending,true);
});
test('legacy database photo deletion does not require a Drive connection', async () => {
  const {deps}=fixture();deps.model.findOneAndDelete=()=>({lean:async()=>({})});
  deps.attachmentContext=async()=>assert.fail();
  assert.equal((await deleteDangerReport(input,deps)).photoCleanupPending,false);
});
test('delete endpoint requires CSRF and confirmation button is restricted to authorized actors', async () => {
  const route=dangerReportsRouter.stack.find(layer=>layer.route?.path.endsWith('/delete')).route;
  assert.equal(route.methods.post,true);assert.equal(route.stack[0].handle,verifyCsrfToken);
  const locals={association:{_id:'association'},report:{_id:'report'},csrfToken:'token'};
  const denied=await ejs.renderFile('src/views/partials/danger-delete.ejs',{...locals,canDelete:false});
  assert.equal(denied.trim(),'');
  const allowed=await ejs.renderFile('src/views/partials/danger-delete.ejs',{...locals,canDelete:true});
  assert.match(allowed,/confirm\(/);assert.match(allowed,/name="_csrf" value="token"/);assert.match(allowed,/method="post"/);
});
