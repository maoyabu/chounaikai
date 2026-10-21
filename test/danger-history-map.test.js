import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
const reports=[{_id:'a',latitude:35,longitude:139,title:'<危険>',createdAt:new Date(),author:{displayname:'住人'}},{_id:'b',locationSource:'address',address:'○○公園付近',title:'倒木',createdAt:new Date()}];
const render=values=>ejs.renderFile('src/views/partials/danger-history-content.ejs',{reports:values,association:{_id:'association'}});
test('history uses one embedded map with photo buttons and no paid API scripts',async()=>{
  const html=await render(reports);
  assert.equal((html.match(/<iframe/g)||[]).length,1);
  assert.doesNotMatch(html,/maps.googleapis|geocod|<script/);
  assert.match(html,/data-danger-focus="a"/);assert.match(html,/href="\/associations\/association\/dangers\/a"/);assert.match(html,/&lt;危険&gt;/);
  assert.match(html,/data-danger-query="○○公園付近"/);
});
test('empty history has no map',async()=>{
  const html=await render([]);assert.doesNotMatch(html,/<iframe/);assert.match(html,/投稿はありません/);
});
test('photo taps switch coordinates or approximate address on the same map',()=>{
  const frame={scrollIntoView(){}},status={};
  const buttons=['35,139','○○公園付近'].map(query=>({dataset:{dangerQuery:query},addEventListener(_event,handler){this.click=handler;},setAttribute(name,value){this[name]=value;},querySelector(){return {alt:'現場写真'};}}));
  vm.runInNewContext(fs.readFileSync('src/public/danger-history.js','utf8'),{document:{querySelectorAll:()=>buttons,getElementById:id=>id==='danger-history-frame'?frame:status},window:{matchMedia:()=>({matches:false})}});
  buttons[0].click();assert.match(frame.src,/35%2C139/);assert.equal(buttons[0]['aria-pressed'],'true');
  buttons[1].click();assert.ok(frame.src.includes(encodeURIComponent('○○公園付近')));assert.equal(buttons[0]['aria-pressed'],'false');assert.equal(buttons[1]['aria-pressed'],'true');
});
