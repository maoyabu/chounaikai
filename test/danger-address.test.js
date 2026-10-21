import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import fs from 'node:fs';
import { DangerReport } from '../src/models/dangerReport.js';
test('address-only report validates without GPS coordinates or location timestamp', async () => {
  const report=new DangerReport({association:'507f1f77bcf86cd799439011',author:'507f1f77bcf86cd799439012',title:'危険',body:'倒木',photoType:'image/jpeg',locationSource:'address',address:'公園付近'});
  await report.validate();
});
test('address details escape user text and render a map search without precision claims', async () => {
  const html=await ejs.renderFile('src/views/partials/danger-place.ejs',{report:{locationSource:'address',address:'公園 <北側>&付近'}});
  assert.match(html,/公園 &lt;北側&gt;&amp;付近/);assert.doesNotMatch(html,/NaN|undefined|位置精度/);
  assert.match(html,/正確な現場の位置とは異なる/);
});
test('photo chooser allows albums and includes approximate-address fallback',async()=>{
  const html=await ejs.renderFile('src/views/partials/danger-compose.ejs',{dangerMemberships:[{association:{_id:'association',name:'町内会'}}],assetVersion:'test'});
  assert.doesNotMatch(html,/capture=/);assert.match(html,/name="address"/);assert.match(html,/大まかな場所/);
});
test('updated map/history/detail templates compile',()=>{
  for(const file of ['src/views/danger-history.ejs','src/views/danger-detail.ejs']) ejs.compile(fs.readFileSync(file,'utf8'),{filename:file});
});
