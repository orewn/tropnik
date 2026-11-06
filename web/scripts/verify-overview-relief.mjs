import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root=new URL('../public/maps/russia-relief/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
if(!manifest.complete||manifest.minzoom!==0||manifest.maxzoom!==4||manifest.tileCount!==341||manifest.files.length!==341||manifest.terrainElevationData!==false)throw new Error('Invalid Russia overview relief manifest');
const expected=new Set();for(let z=0;z<=4;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++)expected.add(`${z}/${x}/${y}.png`);
let bytes=0;
for(const file of manifest.files){
 if(!expected.delete(file.path))throw new Error('Unexpected or repeated overview tile');
 const data=await readFile(new URL(file.path,root));bytes+=data.length;
 if(data.length!==file.bytes||createHash('sha256').update(data).digest('hex')!==file.sha256)throw new Error('Invalid overview tile: '+file.path);
}
if(expected.size||bytes!==manifest.totalTileBytes||bytes>3*1024*1024)throw new Error('Overview tile pyramid is incomplete or oversized');
const mask=await readFile(new URL('../public'+manifest.mask.path,import.meta.url));
if(createHash('sha256').update(mask).digest('hex')!==manifest.mask.sha256)throw new Error('Overview relief is using a different RF mask');
console.log(JSON.stringify({overviewTiles:341,bytes,sourceVersion:manifest.source.usedVersion,allHashesVerified:true,networkRequests:0}));
