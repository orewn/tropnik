// Read-only network evidence for the focused CI diagnosis. This script is not
// a release gate and does not change any map source or available zoom level.
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';

const center=[40.39729094374184,43.72871233957528];
const directory=new URL('../../web/pages-preview/design-qa/',import.meta.url);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function read(url,maxBytes=2*1024*1024){
  const started=performance.now();
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){
      bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Response exceeds diagnostic byte budget');chunks.push(chunk);
    }
    const body=Buffer.concat(chunks);
    return{url,status:response.status,contentType:response.headers.get('content-type'),bytes,sha256:sha(body),elapsedMs:performance.now()-started,body};
  }catch(error){return{url,error:String(error),elapsedMs:performance.now()-started};}
}
const publicResult=result=>{const {body,...receipt}=result;return receipt;};
const tileJSON=await read('https://tiles.mapterhorn.com/tilejson.json');
let metadata=null;
if(tileJSON.status===200){try{metadata=JSON.parse(tileJSON.body.toString('utf8'));}catch{}}
const urls=await read('https://download.mapterhorn.com/download_urls.json',8*1024*1024);
let coverage=null;
if(urls.status===200){try{coverage=JSON.parse(urls.body.toString('utf8'));}catch{}}
const xy=z=>{const n=2**z,lat=center[1]*Math.PI/180;return{x:Math.floor((center[0]+180)/360*n),y:Math.floor((1-Math.asinh(Math.tan(lat))/Math.PI)/2*n)};};
const cell=xy(6),matchingCoverage=[];
function visit(value,path=[]){
  if(matchingCoverage.length>=40)return;
  if(typeof value==='string'&&value.includes(`6-${cell.x}-${cell.y}`))matchingCoverage.push({path:path.join('.'),value});
  else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
    if(key.includes(`6-${cell.x}-${cell.y}`))matchingCoverage.push({path:[...path,key].join('.'),value:item});
    else visit(item,[...path,key]);
  }
}
visit(coverage);
const tiles=[];
for(let z=11;z<=18;z++){
  const {x,y}=xy(z),url=`https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;
  tiles.push({z,x,y,...publicResult(await read(url))});
}
await mkdir(directory,{recursive:true});
const receipt={verified:false,releaseEligible:false,sourceCommit:process.env.GITHUB_SHA||null,checkedAt:new Date().toISOString(),center,coverageCell:{z:6,...cell},tileJSON:{...publicResult(tileJSON),metadata},highResolutionIndex:{...publicResult(urls),matchingCoverage},tiles};
await writeFile(new URL('terrain-source-evidence.json',directory),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
