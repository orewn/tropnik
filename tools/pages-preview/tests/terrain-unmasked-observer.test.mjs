import test from 'node:test';
import assert from 'node:assert/strict';
import {observePresentation} from './terrain-unmasked-fixture.mjs';

function fixture(t){
 const previous=globalThis.HTMLCanvasElement;
 class Canvas{
  get width(){return this.w||0;}set width(value){this.w=value;}
  get height(){return this.h||0;}set height(value){this.h=value;}
  getContext(){return gl;}
 }
 globalThis.HTMLCanvasElement=Canvas;t.after(()=>{if(previous===undefined)delete globalThis.HTMLCanvasElement;else globalThis.HTMLCanvasElement=previous;});
 const buffers=new WeakMap(),attachments=new WeakMap(),calls=[];
 let draw=null,read=null,bound=null;
 const gl={FRAMEBUFFER:36160,DRAW_FRAMEBUFFER:36009,READ_FRAMEBUFFER:36008,RENDERBUFFER:36161,
  FRAMEBUFFER_COMPLETE:36053,FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:36182,COLOR_ATTACHMENT0:36064,DEPTH_ATTACHMENT:36096,STENCIL_ATTACHMENT:36128,DEPTH_STENCIL_ATTACHMENT:33306,
  RGB8:32849,DEPTH_COMPONENT24:33190,DEPTH24_STENCIL8:35056,SAMPLES:32937,
  FRAMEBUFFER_ATTACHMENT_RED_SIZE:33298,FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:33299,FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:33300,FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:33301,FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:33302,FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:33303,
  RENDERBUFFER_SAMPLES:36011,RENDERBUFFER_RED_SIZE:36176,RENDERBUFFER_GREEN_SIZE:36177,RENDERBUFFER_BLUE_SIZE:36178,RENDERBUFFER_ALPHA_SIZE:36179,RENDERBUFFER_DEPTH_SIZE:36180,RENDERBUFFER_STENCIL_SIZE:36181};
 const targetFor=target=>target===gl.READ_FRAMEBUFFER?read:draw;
 const points=attachment=>attachment===gl.DEPTH_STENCIL_ATTACHMENT?[gl.DEPTH_ATTACHMENT,gl.STENCIL_ATTACHMENT]:[attachment];
 const precision=(format,parameter)=>{
  if([gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE,gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE,gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE,gl.RENDERBUFFER_RED_SIZE,gl.RENDERBUFFER_GREEN_SIZE,gl.RENDERBUFFER_BLUE_SIZE].includes(parameter))return format===gl.RGB8?8:0;
  if([gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE,gl.RENDERBUFFER_DEPTH_SIZE].includes(parameter))return format===gl.RGB8?0:24;
  if([gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE,gl.RENDERBUFFER_STENCIL_SIZE].includes(parameter))return format===gl.DEPTH24_STENCIL8?8:0;
  return 0;
 };
 const storage=(samples,format,width,height)=>buffers.set(bound,{samples,format,width,height});
 Object.assign(gl,{
  bindFramebuffer(target,value){if(target===gl.FRAMEBUFFER||target===gl.DRAW_FRAMEBUFFER)draw=value;if(target===gl.FRAMEBUFFER||target===gl.READ_FRAMEBUFFER)read=value;},
  bindRenderbuffer(_target,value){bound=value;},
  renderbufferStorageMultisample(_target,samples,format,width,height){storage(samples,format,width,height);},
  renderbufferStorage(_target,format,width,height){storage(0,format,width,height);},
  framebufferRenderbuffer(target,attachment,_kind,buffer){const fb=targetFor(target);let map=attachments.get(fb);if(!map)attachments.set(fb,map=new Map());for(const point of points(attachment))if(buffer)map.set(point,buffer);else map.delete(point);},
  framebufferTexture2D(target,attachment){attachments.get(targetFor(target))?.delete(attachment);},
  checkFramebufferStatus(target){const values=[...(attachments.get(targetFor(target))?.values()||[])].map(buffer=>buffers.get(buffer));return values.length&&values.every(value=>value&&value.samples===values[0].samples)?gl.FRAMEBUFFER_COMPLETE:gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE;},
  getParameter(parameter){if(parameter===gl.SAMPLES){const buffer=attachments.get(draw)?.values().next().value;return buffer?buffers.get(buffer).samples:0;}return null;},
  getFramebufferAttachmentParameter(target,attachment,parameter){const buffer=attachments.get(targetFor(target))?.get(attachment),value=buffer&&buffers.get(buffer);return value?value.precision?.[parameter]??precision(value.format,parameter):null;},
  getRenderbufferParameter(_target,parameter){const value=buffers.get(bound);return parameter===gl.RENDERBUFFER_SAMPLES?value.samples:precision(value.format,parameter);},
  deleteFramebuffer(value){attachments.delete(value);if(draw===value)draw=null;if(read===value)read=null;},
 });
 for(const name of ['shaderSource','attachShader','linkProgram','useProgram','fenceSync','clientWaitSync','deleteSync','drawArrays','drawElements','clear','clearBufferfv','clearBufferiv','clearBufferuiv','clearBufferfi','blitFramebuffer'])gl[name]=()=>{};
 for(const[name,method]of Object.entries(gl))if(typeof method==='function')gl[name]=(...args)=>{calls.push([name,...args]);return method(...args);};
 const canvas=new Canvas(),observation=observePresentation(canvas,true);assert.equal(canvas.getContext('webgl2'),gl);
 const pair=(width=512,height=384,samples=4,masked=false)=>{
  const framebuffer={},color={},depth={};gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
  for(const[buffer,format,attachment]of[[color,gl.RGB8,gl.COLOR_ATTACHMENT0],[depth,masked?gl.DEPTH24_STENCIL8:gl.DEPTH_COMPONENT24,masked?gl.DEPTH_STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT]]){
   gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,samples,format,width,height);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,attachment,gl.RENDERBUFFER,buffer);
  }
  return{framebuffer,color,depth};
 };
 const queries=(target=gl.FRAMEBUFFER,masked=false)=>{
  gl.getParameter(gl.SAMPLES);
  for(const key of ['RED','GREEN','BLUE','ALPHA'])gl.getFramebufferAttachmentParameter(target,gl.COLOR_ATTACHMENT0,gl['FRAMEBUFFER_ATTACHMENT_'+key+'_SIZE']);
  gl.getFramebufferAttachmentParameter(target,gl.DEPTH_ATTACHMENT,gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE);
  gl.getFramebufferAttachmentParameter(target,masked?gl.STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT,gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE);
 };
 return{gl,pair,queries,observation,buffers,calls};
}

test('unmasked observer records actual framebuffer samples and precision without adding driver calls',t=>{
 const {gl,pair,queries,observation,buffers,calls}=fixture(t),objects=pair();
 buffers.get(objects.color).samples=2;buffers.get(objects.depth).samples=2;
 buffers.get(objects.color).precision={[gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE]:7};
 queries();assert.deepEqual(observation.summary().allocations.map(value=>[value.samples,value.precision]),[[null,{}],[null,{}]],'an unverified framebuffer cannot supply allocation proof');
 assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE);
 const before=calls.length;queries();assert.equal(calls.length-before,7,'wrappers must not issue additional GL calls');
 assert.deepEqual(observation.summary().allocations,[
  {requestedSamples:4,format:gl.RGB8,width:512,height:384,samples:2,precision:{redBits:7,greenBits:8,blueBits:8,alphaBits:0}},
  {requestedSamples:4,format:gl.DEPTH_COMPONENT24,width:512,height:384,samples:2,precision:{depthBits:24,stencilBits:0}},
 ],'real low precision/sample values must be retained, not replaced by requested formats');
 gl.bindFramebuffer(gl.FRAMEBUFFER,null);assert.equal(gl.getParameter(gl.SAMPLES),0);
 assert.deepEqual(observation.summary().allocations.map(value=>value.samples),[2,2],'default framebuffer readings cannot overwrite target measurements');
 assert.equal(calls.filter(([name])=>name==='getRenderbufferParameter').length,0);
});

test('unmasked observer preserves the exact six initial, resized and restored allocation records',t=>{
 const {gl,pair,queries,observation}=fixture(t);
 for(const[width,height]of[[512,384],[384,512],[384,512]]){pair(width,height);assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE);queries();}
 assert.deepEqual(observation.summary().allocations,[[512,384],[384,512],[384,512]].flatMap(([width,height])=>[
  {requestedSamples:4,format:gl.RGB8,width,height,samples:4,precision:{redBits:8,greenBits:8,blueBits:8,alphaBits:0}},
  {requestedSamples:4,format:gl.DEPTH_COMPONENT24,width,height,samples:4,precision:{depthBits:24,stencilBits:0}},
 ]));
});

test('unmasked observer binds completeness to the queried framebuffer and current storage generation',t=>{
 const {gl,pair,queries,observation}=fixture(t),first=pair();gl.checkFramebufferStatus(gl.FRAMEBUFFER);queries();
 const second=pair(384,512,2);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,first.framebuffer);gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
 gl.getParameter(gl.SAMPLES);assert.deepEqual(observation.summary().allocations.slice(2).map(value=>value.samples),[null,null],'a complete read framebuffer does not verify the draw framebuffer');
 gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);queries(gl.DRAW_FRAMEBUFFER);assert.deepEqual(observation.summary().allocations.slice(2).map(value=>value.samples),[2,2]);
 gl.bindRenderbuffer(gl.RENDERBUFFER,second.color);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,6,gl.RGB8,384,512);
 queries(gl.DRAW_FRAMEBUFFER);assert.equal(observation.summary().allocations.at(-1).samples,null,'storage replacement invalidates old completeness');
 assert.equal(gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER),gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE);queries(gl.DRAW_FRAMEBUFFER);assert.equal(observation.summary().allocations.at(-1).samples,null);
 gl.bindRenderbuffer(gl.RENDERBUFFER,second.depth);gl.renderbufferStorageMultisample(gl.RENDERBUFFER,6,gl.DEPTH_COMPONENT24,384,512);
 assert.equal(gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE);queries(gl.DRAW_FRAMEBUFFER);
 assert.deepEqual(observation.summary().allocations.slice(4).map(value=>value.samples),[6,6]);
 gl.deleteFramebuffer(second.framebuffer);assert.equal(gl.getParameter(gl.SAMPLES),0);
 assert.deepEqual(observation.summary().allocations.slice(4).map(value=>value.samples),[6,6],'deletion cannot redirect later default queries to old allocations');
});

test('unmasked observer invalidates changed attachments and keeps the existing allocation bound',t=>{
 const {gl,pair,queries,observation}=fixture(t),objects=pair(512,384,4,true);gl.checkFramebufferStatus(gl.FRAMEBUFFER);queries(gl.FRAMEBUFFER,true);
 assert.deepEqual(observation.summary().allocations[1].precision,{depthBits:24,stencilBits:8});
 gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,null);
 gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,objects.depth);queries();
 assert.deepEqual(observation.summary().allocations[1].precision,{depthBits:24,stencilBits:8},'attachment changes cannot reuse a previous completeness proof');
 gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,0,{},0);queries();
 assert.deepEqual(observation.summary().allocations[1].precision,{depthBits:24,stencilBits:8});
 for(let i=0;i<7;i++)pair();
 assert.equal(observation.summary().allocations.length,16);
 assert.throws(()=>pair(),/Unbounded framebuffer allocations/);
});
