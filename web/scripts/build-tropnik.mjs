import {spawnSync} from 'node:child_process';
import path from 'node:path';
const cwd=path.resolve(import.meta.dirname,'..');
// The portable scene always embeds the same renderer as the interactive map.
for(const args of[['--experimental-strip-types','scripts/build-trail-connections.mjs','--check'],['scripts/create-map-style.mjs'],['scripts/verify-overview-relief.mjs'],['scripts/build-landscape.mjs'],['scripts/prepare-offline.mjs'],['scripts/stamp-service-worker.mjs'],['scripts/build-region-artwork.mjs','--check'],['scripts/verify-map-shell.mjs'],['scripts/run-framework.mjs','build']]){
 const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
