import test from 'node:test';
import assert from 'node:assert/strict';
import {observeTerrainViewport} from '../lib/terrain-viewport.ts';

function environment(t,{desktop=false,panel=true,hud={}}={}){
 const eventTarget=()=>{
  const listeners=new Map();
  return{listeners,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),
   emit(name,event={}){listeners.get(name)?.({target:this,...event});},
  };
 };
 const oldWindow=globalThis.window,oldObserver=globalThis.ResizeObserver;
 const viewport=eventTarget(),drawer=eventTarget(),observed=[];
 const area=desktop?{left:380,right:1360,top:68,bottom:936,width:980,height:868}:{left:0,right:390,top:68,bottom:844,width:390,height:776};
 const sheet=desktop?{left:0,right:380,top:68,bottom:936,width:380,height:868}:{left:0,right:390,top:688,bottom:1464,width:390,height:776};
 drawer.getBoundingClientRect=()=>sheet;
 const hudNode=selector=>hud[selector]?{getBoundingClientRect:()=>hud[selector]}:null;
 const surface={getBoundingClientRect:()=>area,querySelector:hudNode,closest:selector=>selector==='.explore-layout'?{querySelector:()=>panel?drawer:null}:selector==='.atlas-wrap'?{querySelector:hudNode}:null};
 const observers=[];
 let measurements=0,warmups=0;
 globalThis.window=viewport;
 globalThis.ResizeObserver=class{
  constructor(callback){this.callback=callback;observers.push(this);}
  observe(element){observed.push(element);}
  disconnect(){this.disconnected=true;}
 };
 t.after(()=>{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;if(oldObserver===undefined)delete globalThis.ResizeObserver;else globalThis.ResizeObserver=oldObserver;});
 const insets=[];
 const target={setViewportInsets:value=>{measurements++;insets.push(value);},warmup:()=>warmups++};
 const unbind=observeTerrainViewport(surface,target);
 return{viewport,drawer,area,sheet,surface,target,hud,insets,observed,observer:observers[0],unbind,count:()=>measurements,warmups:()=>warmups};
}

const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});

test('transform-only sheet movement updates terrain insets once at its final visible position',t=>{
 const env=environment(t);
 assert.deepEqual(env.insets,[{top:192,right:64,bottom:172,left:16}]);
 assert.deepEqual(env.observed,[env.surface,env.drawer]);
 // CSS transforms move the same-size drawer. No ResizeObserver fires.
 env.sheet.top=371;env.sheet.bottom=1147;
 assert.equal(env.count(),1,'drag frames do not continuously reframe the terrain');
 env.drawer.emit('transitionend',{propertyName:'transform'});
 assert.deepEqual(env.insets.at(-1),{top:192,right:64,bottom:489,left:16});
 assert.equal(env.count(),2);assert.equal(env.warmups(),2);
 env.drawer.emit('transitionend',{propertyName:'transform'});
 env.drawer.emit('tropnik:sheet-settled');env.observer.callback();
 assert.equal(env.count(),2,'duplicate final notifications must not request another terrain render');
 env.unbind();
});

test('reduced-motion settle works without CSS animation; nested and unrelated transitions are ignored',t=>{
 const env=environment(t);env.sheet.top=420;
 env.drawer.emit('transitionend',{propertyName:'opacity'});
 env.drawer.emit('transitionend',{target:{},propertyName:'transform'});
 env.drawer.emit('tropnik:sheet-settled',{target:{}});
 assert.equal(env.count(),1);
 env.drawer.emit('tropnik:sheet-settled');
 assert.equal(env.insets.at(-1).bottom,440);assert.equal(env.count(),2);
 env.sheet.top=688;env.drawer.emit('transitionend',{propertyName:'height'});
 assert.equal(env.insets.at(-1).bottom,172);assert.equal(env.count(),3);
 env.unbind();
});

test('desktop sidebars do not occlude the terrain and real viewport resize keeps responsive insets',t=>{
 const env=environment(t,{desktop:true});
 assert.deepEqual(env.insets.at(-1),{top:176,right:80,bottom:64,left:32});
 env.drawer.emit('tropnik:sheet-settled');assert.equal(env.count(),1);
 Object.assign(env.area,{left:0,right:390,width:390,bottom:844,height:776});
 Object.assign(env.sheet,{left:0,right:390,top:688,bottom:1464});
 env.viewport.emit('resize');
 assert.deepEqual(env.insets.at(-1),{top:192,right:64,bottom:172,left:16});
 env.unbind();
});

test('a standalone terrain surface can resize without a sheet',t=>{
 const env=environment(t,{panel:false});
 assert.deepEqual(env.observed,[env.surface]);
 assert.deepEqual(env.insets.at(-1),{top:192,right:64,bottom:64,left:16});
 Object.assign(env.area,{right:1000,width:1000});env.observer.callback();
 assert.deepEqual(env.insets.at(-1),{top:176,right:80,bottom:64,left:32});
 env.unbind();
});

test('real mobile HUD edges reserve clear space above the rail and reclaim the hidden heading area',t=>{
 const env=environment(t,{hud:{
  '.map-context':rect(12,80,220,56),
  '.terrain-heading':rect(12,148,260,98),
  '.terrain-controls':rect(12,622,366,54),
  '.terrain-bottom':rect(12,574,350,36),
 }});
 assert.deepEqual(env.insets.at(-1),{top:194,right:16,bottom:286,left:16},'both the footer and horizontal rail stay outside the fitted terrain');
 env.sheet.top=371;env.sheet.bottom=1147;
 env.hud['.terrain-heading']=rect(0,0,0,0);
 env.hud['.terrain-bottom']=rect(0,0,0,0);
 env.hud['.terrain-controls']=rect(12,307,366,52);
 env.drawer.emit('transitionend',{propertyName:'transform'});
 assert.deepEqual(env.insets.at(-1),{top:84,right:16,bottom:553,left:16});
 assert.equal(env.area.height-env.insets.at(-1).top-env.insets.at(-1).bottom,139,'the complete clear band between context and controls is available');
 const count=env.count();env.drawer.emit('tropnik:sheet-settled');env.observer.callback();
 assert.equal(env.count(),count);assert.equal(env.warmups(),count);
 env.unbind();
});

test('desktop HUD measurement retains its side gutter and vertical controls do not consume the full bottom',t=>{
 const env=environment(t,{desktop:true,hud:{
  '.map-context':rect(396,80,220,56),
  '.terrain-heading':rect(396,148,300,92),
  '.terrain-controls':rect(1290,144,54,356),
  '.terrain-bottom':rect(396,860,400,40),
 }});
 assert.deepEqual(env.insets.at(-1),{top:188,right:80,bottom:92,left:32});
 env.hud['.terrain-bottom']=rect(0,0,0,0);env.viewport.emit('resize');
 assert.deepEqual(env.insets.at(-1),{top:188,right:80,bottom:64,left:32});
 env.unbind();
});

test('zero-size and off-surface HUDs are ignored, while vertical mobile controls retain only the side gutter',t=>{
 const env=environment(t,{hud:{
  '.map-context':rect(12,-100,220,56),
  '.terrain-heading':rect(0,0,0,0),
  '.terrain-controls':rect(314,140,54,340),
  '.terrain-bottom':rect(0,0,0,0),
 }});
 assert.deepEqual(env.insets.at(-1),{top:192,right:64,bottom:172,left:16});
 env.hud['.map-context']=rect(12,80,220,56);env.drawer.emit('tropnik:sheet-settled');
 assert.deepEqual(env.insets.at(-1),{top:84,right:64,bottom:172,left:16});
 env.unbind();
});

test('cleanup disconnects every source and late queued observer callbacks cannot reach a destroyed renderer',t=>{
 const env=environment(t);const stale=env.observer.callback;
 const transition=env.drawer.listeners.get('transitionend'),settled=env.drawer.listeners.get('tropnik:sheet-settled');
 env.unbind();env.sheet.top=200;
 stale();transition({target:env.drawer,propertyName:'transform'});settled({target:env.drawer});
 assert.equal(env.observer.disconnected,true);assert.equal(env.viewport.listeners.size,0);assert.equal(env.drawer.listeners.size,0);
 assert.equal(env.count(),1);assert.equal(env.warmups(),1);
});
