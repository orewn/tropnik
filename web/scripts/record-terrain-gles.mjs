/** Capture renderer GL commands for native GLES shader/framebuffer verification.
 * This is an engine test. It does not run a browser or verify the React UI. */
import fs from 'node:fs';
import path from 'node:path';
import {TerrainRenderer} from '../public/terrain/terrain-renderer.js';
const [destination,widthArg='1200',heightArg='900',yawArg,zoomArg]=process.argv.slice(2);
if(!destination)throw Error('Usage: record-terrain-gles.mjs output.json [width height yaw zoom]');
const width=Number(widthArg),height=Number(heightArg),commands=[],frames=new Map();let objectId=0,frameId=0;
const constants={NO_ERROR:0,ARRAY_BUFFER:0x8892,ELEMENT_ARRAY_BUFFER:0x8893,STATIC_DRAW:0x88e4,FLOAT:0x1406,
 VERTEX_SHADER:0x8b31,FRAGMENT_SHADER:0x8b30,COMPILE_STATUS:0x8b81,LINK_STATUS:0x8b82,
 MAX_TEXTURE_SIZE:0x0d33,MAX_VERTEX_TEXTURE_IMAGE_UNITS:0x8b4c,TEXTURE_2D:0x0de1,TEXTURE0:0x84c0,TEXTURE1:0x84c1,TEXTURE2:0x84c2,TEXTURE3:0x84c3,TEXTURE4:0x84c4,
 TEXTURE_MIN_FILTER:0x2801,TEXTURE_MAG_FILTER:0x2800,TEXTURE_WRAP_S:0x2802,TEXTURE_WRAP_T:0x2803,TEXTURE_MAX_LEVEL:0x813d,
 NEAREST:0x2600,LINEAR:0x2601,LINEAR_MIPMAP_LINEAR:0x2703,REPEAT:0x2901,CLAMP_TO_EDGE:0x812f,
 UNPACK_ALIGNMENT:0x0cf5,R32F:0x822e,RED:0x1903,RGBA:0x1908,RGBA8:0x8058,UNSIGNED_BYTE:0x1401,UNSIGNED_SHORT:0x1403,UNSIGNED_INT:0x1405,
 FRAMEBUFFER:0x8d40,FRAMEBUFFER_COMPLETE:0x8cd5,COLOR_ATTACHMENT0:0x8ce0,DEPTH_TEST:0x0b71,BLEND:0x0be2,CULL_FACE:0x0b44,
 COLOR_BUFFER_BIT:0x4000,DEPTH_BUFFER_BIT:0x0100,LEQUAL:0x0203,TRIANGLES:0x0004,SRC_ALPHA:0x0302,ONE_MINUS_SRC_ALPHA:0x0303};
const encode=value=>ArrayBuffer.isView(value)?{bytes:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64'),type:value.constructor.name}:value;
const gl=new Proxy({}, {get(_,name){
 if(name in constants)return constants[name];
 if(name==='getExtension')return()=>null;
 if(name==='getError')return()=>0;
 if(name==='getParameter')return value=>value===constants.MAX_TEXTURE_SIZE?4096:16;
 if(name==='getShaderParameter'||name==='getProgramParameter')return()=>true;
 if(name==='getShaderInfoLog'||name==='getProgramInfoLog')return()=>'';
 if(name==='checkFramebufferStatus')return()=>constants.FRAMEBUFFER_COMPLETE;
 if(typeof name==='string'&&(/^[A-Z_0-9]+$/.test(name)))throw Error('Unknown GL constant '+name);
 return(...args)=>{const result=name.startsWith('create')||name==='getUniformLocation'?{ref:++objectId}:undefined;commands.push({name,args:args.map(encode),...(result?{result:result.ref}:{})});return result;};
}});
globalThis.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};
globalThis.cancelAnimationFrame=id=>frames.delete(id);
globalThis.devicePixelRatio=1;
const canvas={style:{},dataset:{},ownerDocument:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},
 getContext:type=>type==='webgl2'?gl:null,getBoundingClientRect:()=>({width,height,left:0,top:0}),addEventListener(){},removeEventListener(){}};
const root=path.resolve(import.meta.dirname,'..');
const grid=JSON.parse(fs.readFileSync(path.join(root,'public/terrain/terrain-grid.json'),'utf8'));
const route=JSON.parse(fs.readFileSync(path.join(root,'public/data/routes/11566519.geojson'),'utf8'));
const errors=[];
const renderer=new TerrainRenderer(canvas,grid,{viewportInsets:{top:64,right:64,bottom:64,left:64},onError:error=>errors.push(error)});
if(yawArg!==undefined)renderer.rotate(Number(yawArg));
if(zoomArg!==undefined)renderer.zoomBy(Number(zoomArg));
renderer.setGeometry(route);
let count=0;while(frames.size&&count++<5){const tasks=[...frames.values()];frames.clear();for(const fn of tasks)fn(performance.now());}
if(errors.length)throw Error(errors.join('; '));
fs.writeFileSync(destination,JSON.stringify({kind:'native-gles-engine-test',browserVerified:false,width:canvas.width,height:canvas.height,commands,scene:canvas.dataset}));
console.log(JSON.stringify({trace:destination,width:canvas.width,height:canvas.height,commands:commands.length,scene:canvas.dataset}));
