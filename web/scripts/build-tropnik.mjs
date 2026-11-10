import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {verifyMapLibreTerrainPatch} from './maplibre-terrain-patch.mjs';
const cwd=path.resolve(import.meta.dirname,'..');
// Sites may reuse node_modules: reject stale dependencies before any build output can change.
await verifyMapLibreTerrainPatch({webRoot:cwd});
// The portable scene always embeds the same renderer as the interactive map.
for(const args of[['--experimental-strip-types','scripts/build-trail-connections.mjs','--check'],['scripts/create-map-style.mjs'],['scripts/verify-overview-relief.mjs'],['scripts/build-landscape.mjs'],['scripts/prepare-offline.mjs'],['scripts/stamp-service-worker.mjs'],['scripts/build-region-artwork.mjs','--check'],['scripts/verify-map-shell.mjs'],['scripts/run-framework.mjs','build']]){
 const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
