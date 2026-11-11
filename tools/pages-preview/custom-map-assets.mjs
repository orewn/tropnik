import assert from 'node:assert/strict';

export const legacyMapRuntime = /(?:^|\/)(?:maplibre(?:-gl|-worker)?|leaflet|protomaps-leaflet)(?:[.-]|\/)/i;

/** The source manifest also inventories Android-only files. Pages ships the
 * verified common subset plus that unchanged provenance manifest. */
export function customMapWebRecords(source) {
 assert.equal(source?.runtime,'tropnik-canvas');
 assert.ok(Array.isArray(source.files)&&source.files.length>0&&source.files.length<64);
 const records=[...source.files,source.manifest].map(record=>({...record}));
 const paths=new Set();
 for(const record of records){
  assert.ok(typeof record.path==='string'&&/^[\w./-]+$/.test(record.path)&&record.path.split('/').every(part=>part&&part!=='.'&&part!=='..'));
  assert.ok(!paths.has(record.path)&&!legacyMapRuntime.test(record.path));paths.add(record.path);
  assert.ok(Number.isSafeInteger(record.sizeBytes)&&record.sizeBytes>0&&record.sizeBytes<=2*1024*1024);
  assert.match(record.sha256,/^[a-f0-9]{64}$/);
 }
 for(const name of ['index.html','android-bootstrap.js','offline-manifest.json'])assert.ok(!paths.has(name),'Pages must exclude the native application entry');
 for(const name of ['map-runtime.js','map.css','manifest.json'])assert.ok(paths.has(name));
 assert.ok(records.some(record=>/^workers\/custom-map-tiles\.worker-[\w-]+\.js$/.test(record.path)));
 return records;
}

export function customMapShellRecords(records,base){
 assert.ok(/^\/(?:[a-z0-9][a-z0-9-]*\/)?$/i.test(base));
 return records.map(({path,sizeBytes,sha256})=>({path:base+'custom-map/'+path,sizeBytes,sha256}));
}

function registry(code){
 const matches=[...code.matchAll(/\bconst\s+CUSTOM_MAP_RESOURCES\s*=\s*(\[[^\r\n]*\]);/g)];
 assert.equal(matches.length,1,'The service worker must have one generated custom-map checksum registry');
 const match=matches[0];return{match,value:JSON.parse(match[1])};
}

export function readCustomMapShellResources(code){return registry(code).value;}

/** Base-path rewriting changes JS/CSS bytes. Pin the actual deployed bytes in
 * the offline shell, after verifying the source registry was current. */
export function rewriteCustomMapShellResources(code,expectedSource,deployed){
 const {match,value}=registry(code);assert.deepEqual(value,expectedSource,'Regenerate the source offline shell before building Pages');
 return code.slice(0,match.index)+'const CUSTOM_MAP_RESOURCES='+JSON.stringify(deployed)+';'+code.slice(match.index+match[0].length);
}
