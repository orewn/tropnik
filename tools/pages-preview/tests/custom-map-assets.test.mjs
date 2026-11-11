import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {customMapWebRecords,customMapShellRecords,readCustomMapShellResources,rewriteCustomMapShellResources,legacyMapRuntime} from '../custom-map-assets.mjs';
import {rewriteScript,rewriteCSS,pagesPath} from '../paths.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const record=(path,value='fixture')=>({path,sizeBytes:Buffer.byteLength(value),sha256:hash(value)});
const fixture=()=>({runtime:'tropnik-canvas',files:['map-runtime.js','map.css','workers/custom-map-tiles.worker-test.js'].map(path=>record(path)),manifest:record('manifest.json')});

test('Pages common runtime inventory excludes native entries, unpinned workers and unsafe output paths',()=>{
 const source=fixture();assert.equal(customMapWebRecords(source).length,4);
 for(const change of [
  value=>value.files.push(record('android-bootstrap.js')),value=>value.files.push(record('index.html')),
  value=>value.files.push(record('../outside.js')),value=>value.files.push(record('maplibre-gl.js')),
  value=>value.files.push(value.files[0]),value=>value.files.pop(),value=>value.files[0].sha256='unverified',
 ]){const invalid=fixture();change(invalid);assert.throws(()=>customMapWebRecords(invalid));}
 assert.equal(legacyMapRuntime.test('maps/leaflet.js'),true);assert.equal(legacyMapRuntime.test('custom-map/map-runtime.js'),false);
});

test('Pages rebases own runtime and packed public URLs once while preserving relative worker imports',()=>{
 const code="import('/custom-map/map-runtime.js');const worker=new URL('./workers/own.js',import.meta.url);const urls='/data/a.json,/custom-map/map.css'.split(',');const separator='/';";
 const transformed=rewriteScript(code,'runtime.js',{base:'/tropnik/'});
 assert.ok(transformed.includes("import('/tropnik/custom-map/map-runtime.js')"));assert.ok(transformed.includes("new URL('./workers/own.js',import.meta.url)"));
 assert.ok(transformed.includes("'/tropnik/data/a.json,/tropnik/custom-map/map.css'.split(',')"));assert.ok(transformed.includes("separator='/'"));
 assert.equal(rewriteScript(transformed,'runtime.js',{base:'/tropnik/'}),transformed);
 assert.equal(pagesPath('/custom-map/manifest.json','/tropnik/'),'/tropnik/custom-map/manifest.json');
 assert.equal(rewriteCSS('a{src:url(/fonts/a.woff2)}','/tropnik/'),'a{src:url(/tropnik/fonts/a.woff2)}');
});

test('offline checksums pin transformed Pages bytes and reject a stale or duplicate source registry',()=>{
 const source=customMapWebRecords(fixture()),deployed=source.map(file=>({...file}));
 const runtime="import('/custom-map/map-runtime.js')",bytes=rewriteScript(runtime,'entry.js',{base:'/tropnik/'});
 deployed[0]=record('map-runtime.js',bytes);
 const previous=customMapShellRecords(source,'/tropnik/'),next=customMapShellRecords(deployed,'/tropnik/');
 const worker='const VERSION="fixture";\nconst CUSTOM_MAP_RESOURCES='+JSON.stringify(previous)+';\nself.addEventListener("install",()=>{});';
 const changed=rewriteCustomMapShellResources(worker,previous,next);
 assert.deepEqual(readCustomMapShellResources(changed),next);assert.notEqual(next[0].sha256,previous[0].sha256);
 assert.throws(()=>rewriteCustomMapShellResources(changed,previous,next),/Regenerate/);
 assert.throws(()=>readCustomMapShellResources(worker+'\nconst CUSTOM_MAP_RESOURCES=[];'),/one generated/);
 assert.throws(()=>readCustomMapShellResources('const OTHER=[];'),/one generated/);
});
