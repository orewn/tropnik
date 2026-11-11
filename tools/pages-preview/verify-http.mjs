import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createPreviewServer} from './serve.mjs';
import {APK_FILES, validateApkDelivery, validateApkManifest} from './apk-artifact.mjs';

const out=resolve(process.argv[2]);
const report=JSON.parse(await readFile(join(out,'build-info.json'),'utf8'));
assert.equal(report.hasApk,true,'A public Pages build cannot omit its verified Android download');
const pages=JSON.parse(await readFile(join(out,'page-manifest.json'),'utf8'));
const {server,base}=await createPreviewServer(out);
server.listen(0,'127.0.0.1');
await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
let checks=0;
async function request(path,status,options={}) {
  const response=await fetch(origin+path,{redirect:'manual',...options});
  assert.equal(response.status,status,`${options.method||'GET'} ${path}`);
  checks++;
  return response;
}
try {
  const home=await request(base,200);
  assert.match(await home.text(),/noindex,nofollow/);
  const slash=await request(base.slice(0,-1)+'?region=altai',301);
  assert.equal(slash.headers.get('location'),base+'?region=altai');
  for (const kind of ['region','route','android','offline','sources','account']) {
    const page=pages.find(value=>value.kind===kind);
    assert.ok(page,`No page of kind ${kind}`);
    const path=base+page.path.slice(1);
    const redirect=await request(path,301);
    assert.equal(redirect.headers.get('location'),path+'/');
    const direct=await request(path+'/',200);
    assert.match(await direct.text(),/noindex,nofollow/);
    await request(path+'/index.html',200);
  }
  for (const path of [base+'not-a-real-page/',base+'routes/osm-relation-14407325/',base+'api/health']) {
    const response=await request(path,404);
    assert.match(await response.text(),/Страница не найдена/);
  }
  await request('/',404);
  await request(base+'%invalid',400);
  await request(base+'api/auth/login',405,{method:'POST'});
  for (const asset of ['offline-safety.html','offline-safety.js','offline-safety.css']) await request(base+asset,200);
  const index=await readFile(join(out,'index.html'),'utf8');
  const emitted=[...index.matchAll(/(?:src|href)="(\/[^"<>]+)"/g)].map(match=>match[1]);
  for (const url of new Set([...emitted,...report.customMap.deployedFiles.map(file=>base+'custom-map/'+file.path),base+'data/russia-display-area.geojson',base+'data/russia-canonical-mask.geojson',base+'maps/russia-viewport.js',base+'maps/russia-relief/tilejson.json',base+'maps/russia-relief/manifest.json',base+'maps/russia-relief/0/0/0.png',base+'maps/russia-relief/4/0/0.png',base+'terrain/terrain-grid.json',base+'offline-fonts.css',base+'offline-map/manifest.json',base+'offline-map/terrain/landscape.html',base+'offline.js',base+'sw.js'])) {
    assert.ok(url.startsWith(base),`Public reference lost the project prefix: ${url}`);
    const response=await request(url,200,{method:'HEAD'});
    assert.notEqual(response.headers.get('content-length'),'0');
  }
  if (report.hasApk) {
    const response=await request(base+'downloads/android-manifest.json',200);
    const metadata=validateApkManifest(await response.json());
    validateApkDelivery(report.apk,metadata);
    for(const file of Object.values(APK_FILES)) await request(base+'downloads/'+file,404,{method:'HEAD'});
  }
  const result={verified:true,base,httpChecks:checks,browserRenderingTested:false,backendConnected:false};
  await writeFile(join(out,'http-verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
