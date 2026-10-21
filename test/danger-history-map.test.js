import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
const source=fs.readFileSync('src/public/danger-map.js','utf8');
function setup(points) {
  const markers=[], buttons=points.map(point=>({dataset:{dangerFocus:point.id},setAttribute(key,value){this[key]=value;}}));
  const element={dataset:{points:JSON.stringify(points)}}, status={textContent:''};
  let instance, info;
  class MapMock {constructor(){instance=this;this.zoom=5;}fitBounds(bounds){this.bounds=bounds;}getZoom(){return this.zoom;}setZoom(value){this.zoom=value;}panTo(value){this.position=value;}}
  class Marker {constructor(options){Object.assign(this,options);markers.push(this);}addListener(_event,fn){this.click=fn;}getPosition(){return this.position;}setAnimation(value){this.animation=value;}setZIndex(value){this.zIndex=value;}}
  class InfoWindow {constructor(){info=this;}setContent(value){this.content=value;}open(value){this.anchor=value.anchor;}}
  const context={window:{matchMedia:()=>({matches:false})},document:{getElementById:id=>id==='danger-history-map'?element:status,querySelectorAll:()=>buttons,createElement:()=>({append(...children){this.children=children;}})},google:{maps:{Map:MapMock,Marker,InfoWindow,LatLngBounds:class{extend(){}},Geocoder:class{async geocode({address}){if(address==='unknown')throw new Error('not found');return {results:[{geometry:{location:{lat:35,lng:139}}}]};}},Animation:{BOUNCE:'bounce'},event:{addListenerOnce(_map,_event,fn){fn();}}}},setTimeout:()=>1,clearTimeout:()=>{}};
  vm.runInNewContext(source,context);
  return {context,markers,buttons,status,get map(){return instance;},get info(){return info;}};
}
const points=[{id:'a',latitude:35,longitude:139,title:'A',url:'/a'},{id:'b',latitude:36,longitude:140,title:'B',url:'/b'}];
test('renders all coordinate pins on one map and photo selection raises the corresponding pin',async()=>{
  const state=setup(points);await state.context.window.initDangerMap();
  assert.equal(state.markers.length,2);assert.equal(state.markers[0].map,state.markers[1].map);
  await state.context.window.focusDangerReport('b');
  assert.equal(state.info.anchor,state.markers[1]);assert.equal(state.markers[1].animation,'bounce');assert.equal(state.markers[1].zIndex,10000);assert.equal(state.buttons[1]['aria-pressed'],'true');
  await state.context.window.focusDangerReport('a');assert.equal(state.markers[1].animation,null);assert.equal(state.buttons[1]['aria-pressed'],'false');
});
test('geocodes addresses on the same map and handles unresolved locations without losing other pins',async()=>{
  const state=setup([...points,{id:'c',address:'公園',title:'C',url:'/c'},{id:'d',address:'unknown',title:'D',url:'/d'}]);
  await state.context.window.initDangerMap();assert.equal(state.markers.length,3);
  await state.context.window.focusDangerReport('c');assert.equal(state.info.anchor,state.markers[2]);
  await state.context.window.focusDangerReport('d');assert.match(state.status.textContent,/特定できません/);assert.equal(state.markers.length,3);
});
test('queued selection before map startup is highlighted when ready',async()=>{
  const state=setup(points);state.context.window.pendingDangerReport='b';await state.context.window.initDangerMap();assert.equal(state.info.anchor,state.markers[1]);
});
test('history photos are accessible buttons while titles remain detail links',async()=>{
  const reports=[{_id:'a',latitude:35,longitude:139,title:'<危険>',createdAt:new Date(),author:{displayname:'住人'}}];
  const html=await ejs.renderFile('src/views/partials/danger-history-content.ejs',{reports,association:{_id:'association'},mapsKey:'key',assetVersion:'test'});
  assert.match(html,/data-danger-focus="a"/);assert.match(html,/aria-pressed="false"/);assert.match(html,/href="\/associations\/association\/dangers\/a"/);assert.match(html,/&lt;危険&gt;/);assert.equal((html.match(/id="danger-history-map"/g)||[]).length,1);
});
