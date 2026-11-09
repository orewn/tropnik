import test from 'node:test';
import assert from 'node:assert/strict';
import {constrainDirectionLabels,reconcileDirectionAnchors} from '../lib/map-direction-layout.ts';

// Model the DOM measurement boundary, not browser paint speed: inline writes
// dirty layout, and the next rectangle read flushes it. Label boxes respond to
// the same width, side and translation inputs as the application's CSS.
function fixture({width=800,height=600,left=0,top=0,panel,obstacles=[]}={}){
  const events=[],buttons=new Map(),trails=[];let dirty=false,flushes=0;
  const write=(target,field,value)=>{events.push({kind:'write',target,field,value});dirty=true;};
  const read=(target,rect)=>{if(dirty){flushes++;dirty=false;}events.push({kind:'read',target});return rect;};
  const rect=(x,y,w,h)=>({x,y,left:x,right:x+w,top:y,bottom:y+h,width:w,height:h});
  const dataset=(id,values={})=>new Proxy(values,{
    set(object,key,value){if(object[key]!==value)write(id,`dataset.${key}`,value);object[key]=value;return true;},
    deleteProperty(object,key){if(key in object){write(id,`dataset.${key}`,undefined);delete object[key];}return true;},
  });
  const style=id=>{
    const properties=new Map();
    return{getPropertyValue:name=>properties.get(name)||'',setProperty(name,value){
      if(properties.get(name)!==value)write(id,`style.${name}`,value);properties.set(name,value);
    }};
  };
  const px=(node,name)=>parseFloat(node.style.getPropertyValue(name))||0;
  const obstacle=(id,value)=>({id,contains:()=>false,getBoundingClientRect:()=>read(id,value)});
  const panelNode=panel?obstacle('panel',rect(...panel)):null;
  const blocks=obstacles.map((value,index)=>obstacle(`obstacle-${index}`,rect(...value)));
  if(panelNode)blocks.push(panelNode);
  const root={querySelector:()=>panelNode,querySelectorAll:()=>blocks};
  const viewport={clientWidth:width,closest:()=>root,querySelectorAll:()=>trails,getBoundingClientRect:()=>read('viewport',rect(left,top,width,height))};
  function add(id,{x=200,y=180,kind='direction',classes=[],hover=false,hidden=false,connected=true,naturalWidth=120,labelHeight=24,empty=false}={}){
    const classNames=new Set(classes),labelId=`${id}:label`;
    const button={id,hidden,isConnected:connected,dataset:dataset(id,{regionId:id}),style:style(id),
      classList:{contains:name=>classNames.has(name),toggle(name,on){
        if(classNames.has(name)!==on)write(id,`class.${name}`,on);
        if(on)classNames.add(name);else classNames.delete(name);
      }},
      matches:()=>hover,
      getBoundingClientRect(){return read(id,rect(left+x-22+px(button,'--map-anchor-shift-x'),top+y-22+px(button,'--map-anchor-shift-y'),44,44));},
    };
    const label={id:labelId,style:style(labelId),getBoundingClientRect(){
      if(empty)return read(labelId,rect(0,0,0,0));
      const maximum=parseFloat(label.style.getPropertyValue('--map-label-max-width'))||168;
      const w=Math.min(naturalWidth,maximum),h=Math.ceil(naturalWidth/w)*labelHeight;
      const placement=button.dataset.mapLabelPlacement||(kind==='trail'?'top':'bottom');
      return read(labelId,rect(left+x+px(button,'--map-anchor-shift-x')-w/2+px(label,'--map-label-shift-x'),
        top+y+px(button,'--map-anchor-shift-y')+(placement==='bottom'?30:-30-h)+px(label,'--map-label-shift-y'),w,h));
    }};
    button.querySelector=selector=>selector===(kind==='trail'?'.trail-marker-label':'.region-marker-label')?label:null;
    button.label=label;button.classes=classNames;
    if(kind==='trail')trails.push(button);else buttons.set(id,button);
    return button;
  }
  function run(fn=()=>constrainDirectionLabels(buttons,viewport)){
    const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
    const previousStyle=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');
    globalThis.window={};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
    try{return fn();}finally{
      if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else delete globalThis.window;
      if(previousStyle)Object.defineProperty(globalThis,'getComputedStyle',previousStyle);else delete globalThis.getComputedStyle;
    }
  }
  const reset=()=>{events.length=0;dirty=false;flushes=0;};
  return{add,run,reset,events,buttons,trails,viewport,flushes:()=>flushes};
}
const overlap=(a,b,gap=0)=>a.left<b.right+gap&&a.right>b.left-gap&&a.top<b.bottom+gap&&a.bottom>b.top-gap;
const snapshot=button=>({
  placement:button.dataset.mapLabelPlacement,hidden:button.dataset.mapLabelHidden,
  x:button.label.style.getPropertyValue('--map-label-shift-x'),y:button.label.style.getPropertyValue('--map-label-shift-y'),
  maximum:button.label.style.getPropertyValue('--map-label-max-width'),shifted:button.classes.has('map-label-shifted'),
  marker:button.getBoundingClientRect(),label:button.label.getBoundingClientRect(),
});

test('all labels are prepared and measured before grouped side flips and final writes',()=>{
  const env=fixture({width:1200,height:600});
  const labels=[env.add('bottom-a',{x:250,y:550}),env.add('bottom-b',{x:500,y:550}),env.add('middle',{x:750,y:250}),
    env.add('trail-top',{x:1000,y:45,kind:'trail',hover:true})];
  env.run();
  assert.equal(env.flushes(),2,'one preparation flush and one flip flush, regardless of the label count');
  const reads=id=>env.events.flatMap((event,index)=>event.kind==='read'&&event.target===`${id}:label`?[index]:[]);
  for(const button of labels)assert.equal(env.events.filter(event=>event.kind==='read'&&event.target===button.id).length,1);
  assert.equal(reads('middle').length,1);for(const id of ['bottom-a','bottom-b','trail-top'])assert.equal(reads(id).length,2);
  const firstReads=labels.map(button=>reads(button.id)[0]);
  const flips=env.events.flatMap((event,index)=>event.kind==='write'&&event.field==='dataset.mapLabelPlacement'
    &&((event.target.startsWith('bottom-')&&event.value==='top')||(event.target==='trail-top'&&event.value==='bottom'))?[index]:[]);
  assert.equal(flips.length,3);assert.ok(Math.min(...flips)>Math.max(...firstReads));
  assert.ok(Math.max(...flips)<Math.min(...['bottom-a','bottom-b','trail-top'].map(id=>reads(id)[1])));
  const lastRead=Math.max(...env.events.flatMap((event,index)=>event.kind==='read'?[index]:[]));
  assert.ok(env.events.every((event,index)=>!event.field?.startsWith('class.')||index>lastRead));
  assert.deepEqual(labels.map(button=>button.dataset.mapLabelPlacement),['top','top','bottom','bottom']);
});

test('label layout flushes stay constant as more independent directions are shown',()=>{
  for(const count of [15,45]){
    const env=fixture({width:12000,height:1000});
    for(let i=0;i<count;i++)env.add(`direction-${i}`,{x:200+i*240,y:200});
    env.run();assert.equal(env.flushes(),1,`${count} labels share one measurement flush`);
    env.reset();env.run();assert.equal(env.flushes(),0,'settled unchanged placement does not rewrite inline values');
    assert.equal(env.events.filter(event=>event.kind==='write').length,0);
  }
});

test('anchor corrections read every marker before writes and remain idempotent at 44px',()=>{
  const env=fixture({left:100,top:80});
  const a=env.add('a',{x:140,y:200}),b=env.add('b',{x:370,y:270});
  const points=new Map([['a',{x:152.5,y:220.25}],['b',{x:360,y:290}]]),original=structuredClone(points);
  assert.equal(env.run(()=>reconcileDirectionAnchors(env.buttons,points,env.viewport)),2);
  const firstWrite=env.events.findIndex(event=>event.kind==='write');
  assert.ok(firstWrite>env.events.findIndex(event=>event.kind==='read'&&event.target==='b'));
  assert.equal(env.events.slice(firstWrite).some(event=>event.kind==='read'),false);
  for(const button of [a,b]){
    const bounds=button.getBoundingClientRect(),point=points.get(button.id);
    assert.equal((bounds.left+bounds.right)/2,100+point.x);assert.equal((bounds.top+bounds.bottom)/2,80+point.y);
    assert.equal(bounds.width,44);assert.equal(bounds.height,44);
  }
  env.reset();assert.equal(env.run(()=>reconcileDirectionAnchors(env.buttons,points,env.viewport)),2);
  assert.equal(env.events.some(event=>event.kind==='write'),false);assert.deepEqual(points,original);
});

test('selected and cluster priorities are retained while collisions move labels only',()=>{
  const env=fixture();
  const ordinary=env.add('a-ordinary',{x:220,y:220}),cluster=env.add('b-cluster',{x:220,y:220,classes:['direction-cluster']});
  const selected=env.add('z-selected',{x:220,y:220,classes:['is-selected']});
  const markers=[ordinary,cluster,selected].map(button=>button.getBoundingClientRect());env.reset();env.run();
  assert.equal(selected.label.style.getPropertyValue('--map-label-shift-x'),'0px');
  assert.equal(selected.label.style.getPropertyValue('--map-label-shift-y'),'0px');
  assert.equal(selected.dataset.mapLabelHidden,undefined);
  const visible=[selected,cluster,ordinary].filter(button=>button.dataset.mapLabelHidden!=='true');
  assert.ok(visible.includes(cluster),'the next priority label gets the available adjacent space');
  for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++)assert.equal(overlap(visible[i].label.getBoundingClientRect(),visible[j].label.getBoundingClientRect(),8),false);
  assert.deepEqual([ordinary,cluster,selected].map(button=>button.getBoundingClientRect()),markers);
});

test('mobile edge clamp, sheet clearance and overlay avoidance preserve repeated geometry',()=>{
  const card={left:260,right:378,top:320,bottom:390};
  const env=fixture({width:390,height:640,panel:[0,440,390,200],obstacles:[[card.left,card.top,118,70]]});
  const button=env.add('edge',{x:365,y:390,naturalWidth:190});
  const markerBefore=button.getBoundingClientRect();env.reset();env.run();const first=snapshot(button);
  assert.equal(first.placement,'top');assert.equal(first.hidden,undefined);assert.equal(first.maximum,'168px');
  assert.ok(first.label.left>=12&&first.label.right<=378&&first.label.top>=12&&first.label.bottom<=428);
  assert.equal(overlap(first.label,card,8),false);assert.deepEqual(first.marker,markerBefore);
  env.reset();env.run();assert.deepEqual(snapshot(button),first,'resetting measurement translations must not accumulate drift');
});

test('inactive, detached and grouped-away markers do not consume label measurements or collision space',()=>{
  const env=fixture(),hidden=env.add('hidden',{hidden:true}),detached=env.add('detached',{connected:false});
  const inactive=env.add('inactive',{kind:'trail'}),active=env.add('active',{kind:'trail',classes:['is-selected'],x:420,y:180,naturalWidth:220});
  inactive.dataset.mapLabelHidden='true';inactive.label.style.setProperty('--map-label-shift-x','80px');inactive.label.style.setProperty('--map-label-shift-y','30px');
  const empty=env.add('empty',{empty:true});env.reset();env.run();
  for(const node of [hidden,detached,inactive])assert.equal(env.events.some(event=>event.kind==='read'&&(event.target===node.id||event.target===`${node.id}:label`)),false);
  assert.equal(inactive.dataset.mapLabelHidden,undefined);assert.equal(inactive.label.style.getPropertyValue('--map-label-shift-x'),'0px');
  assert.equal(inactive.label.style.getPropertyValue('--map-label-shift-y'),'0px');
  assert.equal(active.dataset.mapLabelPlacement,'top');assert.equal(active.label.style.getPropertyValue('--map-label-max-width'),'230px');
  assert.equal(active.dataset.mapLabelHidden,undefined);assert.equal(active.label.getBoundingClientRect().width,220);
  assert.equal(empty.classes.has('map-label-shifted'),false);
});
