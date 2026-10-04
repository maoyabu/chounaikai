import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import mongoose from 'mongoose';
import { documentsRouter } from '../src/routes/documents.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
import { DriveConnection } from '../src/models/driveConnection.js';
import { verifyCsrfToken } from '../src/middleware/csrf.js';
const association = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId();
const query = result => ({ select() { return this; }, lean: async () => result });
const setup = (t, officer = true, member = true) => {
 t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: association, name: '中央町内会' }));
 t.mock.method(AssociationMembership, 'findOne', () => query(member ? { status: 'active' } : null));
 t.mock.method(RoleDefinition, 'find', () => query([]));
 t.mock.method(AnnualOfficer, 'exists', async () => officer ? { _id: user } : null);
};
const route = (path, method = 'get') => documentsRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
const invoke = async (path, request, method = 'get') => {
 let output, status = 200;
 const res = { headersSent: false, status(n) { status = n; return this; }, render(view, data) { output = { view, data, status }; }, redirect(url) { output = { url }; }, set() {} };
 await route(path,method).stack.at(-1).handle(request, res, err => { throw err; }); return output;
};
const req = () => ({ params: { associationId: String(association) }, user: { _id: user }, session: {}, query: {} });
test('residents and former members cannot view documents or buffer uploads', async t => {
 setup(t, false); let reads=0; t.mock.method(DriveConnection,'findOne',()=>{reads++;return query(null);});
 for (const path of ['/:associationId/documents', '/:associationId/documents/upload']) { const output=await invoke(path,req(),path.endsWith('upload')?'post':'get'); assert.equal(output.status,403); }
 assert.equal(reads,0);
 t.mock.method(AssociationMembership,'findOne',()=>query(null)); t.mock.method(AnnualOfficer,'exists',async()=>({_id:user}));
 assert.equal((await invoke('/:associationId/documents',req())).status,403);
});
test('unconfigured tenant has a friendly setup screen and isolated connection query', async t => {
 setup(t); let criteria; t.mock.method(DriveConnection,'findOne', value => { criteria=value; return { select: async()=>null }; });
 const output=await invoke('/:associationId/documents',req()); assert.equal(output.view,'documents-list'); assert.equal(output.data.connected,false); assert.equal(criteria.association,String(association));
});
test('mutating form routes require CSRF before handler', () => {
 for (const layer of documentsRouter.stack.filter(l=>l.route?.methods.post && !l.route.path.endsWith('/upload'))) assert.ok(layer.route.stack.some(s=>s.handle===verifyCsrfToken),layer.route.path);
});
test('callback rejects missing, expired, or cross-tenant OAuth state without Google access', async t => {
 setup(t); let calls=0; t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('unexpected');});
 for (const pending of [undefined,{state:'state',expires:0},{state:'state',expires:Date.now()+10000,association:'other',user:String(user)}]) { const request=req();request.query.state='state';request.session.driveOAuth=pending; const output=await invoke('/:associationId/documents/oauth/callback',request); assert.equal(output.status,400); assert.equal(request.session.driveOAuth,undefined); }
 assert.equal(calls,0);
});
test('document screens render escaped names, navigation and explicit delete confirmation', async () => {
 const shared={assetVersion:'test',currentUser:null,showNotificationPrompt:false,notice:null,csrfToken:'token',association:{_id:association,name:'中央町内会'},base:`/associations/${association}/documents`};
 const item={id:'file',name:'<script>alert(1)</script>.pdf',mimeType:'application/pdf',modifiedTime:new Date().toISOString(),parents:['root'],capabilities:{canTrash:true,canDownload:true}};
 const folder={id:'root',name:'役員資料',capabilities:{canAddChildren:true}};
 const screens={ 'documents-list':{connected:true,folder,breadcrumbs:[folder],items:[item],nextPage:'next'},'documents-settings':{settings:{clientId:'example',connectedAt:new Date(),accountEmail:'town@example.com'},callbackUrl:'https://example.com/callback',message:''},'documents-view':{item,mode:'excel',sheets:[{name:'議事録',rows:[['<script>','会議']]}]},'documents-delete':{item} };
 for (const [view,data] of Object.entries(screens)) {const html=await ejs.renderFile(`src/views/${view}.ejs`,{title:'資料',...shared,...data});assert.ok(!html.includes('<script>alert(1)</script>'));if(view==='documents-list')assert.match(html,/次の100件/);if(view==='documents-delete')assert.match(html,/確認してゴミ箱へ移す/);}
});
test('delete moves only an allowed tenant file to trash and never permanently deletes', async t => {
 setup(t); const keyBefore = process.env.DRIVE_ENCRYPTION_KEY; process.env.DRIVE_ENCRYPTION_KEY='aa'.repeat(32);
 const { encryptDriveSecret } = await import('../src/services/driveService.js');
 const connection = { association, rootFolderId:'root', clientId:'client', clientSecret:encryptDriveSecret('secret',association),refreshToken:encryptDriveSecret('refresh',association) };
 t.mock.method(DriveConnection,'findOne',()=>({ select:async()=>connection }));
 let writes=[]; let parent='root', canTrash=true, mime='application/pdf';
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(url==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'access'}));
  if(options.method==='PATCH'){writes.push({url,options});return new Response('{}');}
  const id=new URL(url).pathname.split('/').pop();
  return new Response(JSON.stringify(id==='file'?{id,mimeType:mime,parents:[parent],capabilities:{canTrash}}:{id,mimeType:'application/vnd.google-apps.folder'}));
 });
 try {
  const request=req();request.params.fileId='file';
  assert.ok((await invoke('/:associationId/documents/files/:fileId/delete',request,'post')).url.endsWith('?folder=root'));
  assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{trashed:true});
  parent='other-root';assert.equal((await invoke('/:associationId/documents/files/:fileId/delete',reqWithFile(),'post')).status,403);
  parent='root';canTrash=false;assert.equal((await invoke('/:associationId/documents/files/:fileId/delete',reqWithFile(),'post')).status,403);
  canTrash=true;mime='application/vnd.google-apps.folder';assert.equal((await invoke('/:associationId/documents/files/:fileId/delete',reqWithFile(),'post')).status,403);
  assert.equal(writes.length,1);
 } finally {if(keyBefore===undefined)delete process.env.DRIVE_ENCRYPTION_KEY;else process.env.DRIVE_ENCRYPTION_KEY=keyBefore;}
 function reqWithFile(){const r=req();r.params.fileId='file';return r;}
});
