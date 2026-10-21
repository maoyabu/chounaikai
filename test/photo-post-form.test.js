import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync('src/public/danger-reports.js','utf8');
function setup() {
  const nodes={}, dialogs=[],requests=[];
  const node=()=>({handlers:{},textContent:'',addEventListener(name,handler){(this.handlers[name] ||= []).push(handler);},focus(){this.focused=true;}});
  for(const prefix of ['danger','good-place']) {
    const dialog=node();dialog.dataset={photoPostDialog:prefix,postPath:prefix==='danger'?'dangers':'good-places',autoOpen:prefix==='good-place'?'true':'false'};
    dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};dialogs.push(dialog);
    for(const name of ['form','location','error','submit','open','close','locate','preview']) nodes[`${prefix}-${name}`]=node();
    nodes[`${prefix}-form`].elements={photo:{...node(),files:[{size:4}]},address:{...node(),value:'公園付近'},association:{value:'association'}};
  }
  const context={document:{querySelectorAll:()=>dialogs,getElementById:id=>nodes[id],querySelector:()=>({content:'csrf'})},window:{isSecureContext:true},navigator:{},FormData:class{constructor(){this.values={};}set(key,value){this.values[key]=value;}},fetch:async(url,request)=>{requests.push({url,request});return {ok:true,json:async()=>({url:'/detail'})};},location:{assign(url){this.url=url;}},URL:{},DangerLocation:{}};
  return {context,nodes,dialogs,requests};
}
test('both report dialogs initialize once even when their shared controller is loaded twice',()=>{
  const state=setup();vm.runInNewContext(source,state.context);vm.runInNewContext(source,state.context);
  assert.equal(state.nodes['danger-form'].handlers.submit.length,1);assert.equal(state.nodes['good-place-form'].handlers.submit.length,1);
  assert.equal(state.dialogs[0].open,undefined);assert.equal(state.dialogs[1].open,true);
});
test('each dialog posts address fallback to its own endpoint with CSRF',async()=>{
  const state=setup();vm.runInNewContext(source,state.context);
  for(const [prefix,path]of [['danger','dangers'],['good-place','good-places']]){
    await state.nodes[`${prefix}-form`].handlers.submit[0]({preventDefault(){}});
    const {url,request}=state.requests.at(-1);
    assert.equal(url,`/associations/association/${path}`);assert.equal(request.headers['x-csrf-token'],'csrf');assert.equal(request.body.values.locationSource,'address');
  }
});
