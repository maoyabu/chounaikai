import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ejs from 'ejs';
const script=fs.readFileSync('src/public/good-place-gallery.js','utf8');
function fixture(count,reduced=false,dissolve=false,associations=null) {
  let tick=null,active=false;
  const element=()=>({handlers:{},addEventListener(name,handler){this.handlers[name]=handler;}});
  const overlays=[];
  const grid=dissolve?{offsetLeft:20,offsetTop:60,offsetWidth:900,offsetHeight:500,animate(){},cloneNode(){
    let complete,reject;const finished=new Promise((resolve,fail)=>{complete=resolve;reject=fail;});
    const link={removeAttribute(){this.hrefRemoved=true;}};
    const snapshot={style:{},classList:{add(){}},setAttribute(name,value){this[name]=value;},querySelectorAll:()=>[link],remove(){this.removed=true;},animate(frames,options){this.frames=frames;this.options=options;return {finished,cancel(){reject();}};},complete:()=>complete(),link};
    overlays.push(snapshot);return snapshot;
  }}:null;
  const cards=Array.from({length:count},()=>({querySelector:()=>({decode:()=>Promise.resolve()}),hidden:false,style:{},featured:false,classList:{toggle(_name,value){this.owner.featured=value;}}}));
  cards.forEach(card=>{card.classList.owner=card;});
  const controls={hidden:true},pause={...element(),setAttribute(name,value){this[name]=value;}},prev=element(),next=element();
  const gallery={...element(),dataset:{rotating:String(count===2||count>=4),slots:String(count<=2?1:count<=4?3:5)},querySelectorAll:()=>cards,append(){},querySelector:selector=>({'.good-place-grid':grid,'.good-place-gallery-controls':controls,'[data-gallery-pause]':pause,'[data-gallery-prev]':prev,'[data-gallery-next]':next})[selector],contains:()=>false};
  if (associations) { gallery.dataset.diverseAssociations='true'; gallery.dataset.slots=String(Math.min(5,count)); cards.forEach((card,index)=>{card.dataset={association:associations[index]};}); }
  const context={document:{hidden:false,activeElement:null,querySelectorAll:()=>[gallery],addEventListener(){}},window:{addEventListener(){},matchMedia:()=>({matches:reduced,addEventListener(){}})},setInterval:fn=>{tick=fn;active=true;return 1;},clearInterval:()=>{active=false;},setTimeout:fn=>fn()};
  vm.runInNewContext(script,context);
  return {cards,controls,pause,prev,next,gallery,overlays,get active(){return active;},advance(){if(active)tick();}};
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

test('cross dissolve keeps an inert copy of the previous layout until the next photos are decoded',async()=>{
  const state=fixture(4,false,true);
  state.next.handlers.click();
  assert.equal(state.overlays.length,1);
  const outgoing=state.overlays[0];
  assert.equal(outgoing.inert,true);assert.equal(outgoing['aria-hidden'],'true');assert.equal(outgoing.link.hrefRemoved,true);
  assert.equal(outgoing.options,undefined);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(outgoing.options.duration,800);assert.equal(outgoing.frames[0].opacity,1);assert.equal(outgoing.frames[1].opacity,0);
  outgoing.complete();await new Promise(resolve=>setImmediate(resolve));assert.equal(outgoing.removed,true);
});
test('rapid photo changes discard stale overlays and reduced motion skips the dissolve',async()=>{
  const state=fixture(5,false,true);
  state.next.handlers.click();state.next.handlers.click();
  assert.equal(state.overlays[0].removed,true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(state.overlays[0].options,undefined);assert.equal(state.overlays[1].options.duration,800);
  const reduced=fixture(4,true,true);reduced.next.handlers.click();assert.equal(reduced.overlays.length,0);
});

test('directory rotation prefers distinct associations and eventually features every photo',()=>{
  for (const associations of [['a','a','a','b','c','d','e','f'], ['a','a','a','a','a','a'], ['a','a','a','b','b','c']]) {
    const state=fixture(associations.length,false,false,associations), seen=new Set();
    for(let step=0;step<associations.length;step++) {
      const visible=state.cards.filter(card=>!card.hidden);
      assert.equal(visible.length,5);
      assert.equal(new Set(visible.map(card=>card.dataset.association)).size,Math.min(5,new Set(associations).size));
      seen.add(state.cards.findIndex(card=>card.featured));
      state.advance();
    }
    assert.equal(seen.size,associations.length);
  }
});
test('directory cards link to their own association and hide author identities',async()=>{
  const html=await ejs.renderFile('src/views/partials/directory-good-place-gallery.ejs',{goodPlaces:[{_id:'photo',association:{_id:'town',name:'町内会名'},title:'風景',createdAt:new Date(),author:{displayname:'非公開氏名'}}]});
  assert.match(html,/href="\/associations\/town\/good-places\/photo"/);
  assert.match(html,/町内会名/);
  assert.doesNotMatch(html,/非公開氏名/);
});

test('gallery restores and saves accordion state separately for each page',()=>{
  const saved=new Map([['gallery-open:/dashboard:good-places-town','closed']]);
  function visit(path, unavailable=false) {
    const gallery={open:true,dataset:{galleryStateKey:'good-places-town',rotating:'false'},addEventListener(_event,handler){this.toggle=handler;}};
    const storage={getItem(key){if(unavailable)throw Error('blocked');return saved.get(key);},setItem(key,value){if(unavailable)throw Error('blocked');saved.set(key,value);}};
    vm.runInNewContext(script,{document:{querySelectorAll:()=>[gallery]},window:{location:{pathname:path},localStorage:storage}});
    return gallery;
  }
  const home=visit('/dashboard');assert.equal(home.open,false);
  assert.equal(visit('/associations/town/public').open,true);
  home.open=true;home.toggle();assert.equal(visit('/dashboard').open,true);
  home.open=false;home.toggle();assert.equal(visit('/dashboard').open,false);
  const blocked=visit('/dashboard',true);assert.equal(blocked.open,true);assert.doesNotThrow(()=>blocked.toggle());
});
