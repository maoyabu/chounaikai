import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
const script=fs.readFileSync('src/public/good-place-gallery.js','utf8');
function fixture(count,reduced=false) {
  let tick=null,active=false;
  const element=()=>({handlers:{},addEventListener(name,handler){this.handlers[name]=handler;}});
  const cards=Array.from({length:count},()=>({hidden:false,style:{},featured:false,classList:{toggle(_name,value){this.owner.featured=value;}}}));
  cards.forEach(card=>{card.classList.owner=card;});
  const controls={hidden:true},pause={...element(),setAttribute(name,value){this[name]=value;}},prev=element(),next=element();
  const gallery={...element(),dataset:{rotating:String(count===2||count>=4),slots:String(count<=2?1:count<=4?3:5)},querySelectorAll:()=>cards,querySelector:selector=>({'.good-place-gallery-controls':controls,'[data-gallery-pause]':pause,'[data-gallery-prev]':prev,'[data-gallery-next]':next})[selector],contains:()=>false};
  const context={document:{hidden:false,activeElement:null,querySelectorAll:()=>[gallery],addEventListener(){}},window:{matchMedia:()=>({matches:reduced,addEventListener(){}})},setInterval:fn=>{tick=fn;active=true;return 1;},clearInterval:()=>{active=false;},setTimeout:fn=>fn()};
  vm.runInNewContext(script,context);
  return {cards,controls,pause,prev,next,gallery,get active(){return active;},advance(){if(active)tick();}};
}
test('1–8 photos render the requested 1 / 3 / 5-slot layout with latest photo featured',async()=>{
  for(let count=1;count<=8;count++){
    const slots=count<=2?1:count<=4?3:5;
    const reports=Array.from({length:count},(_,index)=>({_id:String(index),title:`写真${index}`,createdAt:new Date(),author:{displayname:'非公開氏名'}}));
    const html=await ejs.renderFile('src/views/partials/good-place-gallery.ejs',{association:{_id:'association'},goodPlaces:reports,showGoodPlaceAuthors:false});
    assert.match(html,new RegExp(`good-place-layout-${slots}`));assert.match(html,new RegExp(`data-rotating="${count===2||count>=4}"`));
    assert.equal((html.match(/class="good-place-feature/g)||[]).length,count);
    assert.equal((html.match(/\/photo" alt="写真\d+" loading="lazy"/g)||[]).length,count);
    assert.doesNotMatch(html,/非公開氏名/);
    assert.match(html,/good-place-feature is-featured[\s\S]*?good-places\/0/);
  }
});
test('2, 4 and 5+ photos rotate without duplicates and eventually feature every photo',()=>{
  for(const count of [2,4,5,8]){
    const state=fixture(count),seen=new Set();
    for(let step=0;step<count;step++){
      const visible=state.cards.filter(card=>!card.hidden);
      assert.equal(visible.length,count===2?1:count===4?3:5);
      assert.equal(visible.filter(card=>card.featured).length,1);
      seen.add(state.cards.findIndex(card=>card.featured));state.advance();
    }
    assert.equal(seen.size,count);
  }
});
test('1 and 3 photos remain static',()=>{
  for(const count of [1,3]){const state=fixture(count);assert.equal(state.active,false);assert.equal(state.controls.hidden,true);}
});
test('manual controls, pause and reduced motion work independently of automatic playback',()=>{
  const state=fixture(4);state.pause.handlers.click();assert.equal(state.active,false);
  state.next.handlers.click();assert.equal(state.cards[1].featured,true);
  state.prev.handlers.click();assert.equal(state.cards[0].featured,true);
  state.pause.handlers.click();assert.equal(state.active,true);
  state.gallery.handlers.mouseenter();assert.equal(state.active,false);
  state.gallery.handlers.mouseleave();assert.equal(state.active,true);
  const reduced=fixture(5,true);assert.equal(reduced.active,false);reduced.next.handlers.click();assert.equal(reduced.cards[1].featured,true);
});
