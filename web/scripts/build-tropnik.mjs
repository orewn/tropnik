import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import path from 'node:path';
import {verifyCustomMap} from './verify-custom-map.mjs';
const cwd=path.resolve(import.meta.dirname,'..');
// Sites consumes the same reviewed renderer/worker bundle as Android. Reject
// stale compiled source before any derivative can change.
await verifyCustomMap({webRoot:cwd});
// The portable scene always embeds the same renderer as the interactive map.
for(const args of[['--experimental-strip-types','scripts/build-trail-connections.mjs','--check'],['scripts/verify-overview-relief.mjs'],['scripts/build-landscape.mjs'],['scripts/prepare-offline.mjs'],['scripts/stamp-service-worker.mjs'],['scripts/build-region-artwork.mjs','--check'],['scripts/verify-map-shell.mjs'],['scripts/run-framework.mjs','build']]){
 const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
// Worker static assets have a 25 MiB per-file limit. The /downloads/[file]
// route redirects the selected APK to its pinned GitHub release. Pages uses
// its separate builder and retains the checksum-verified local APK download.
for(const file of ['tropnik-preview.apk','tropnik-arm64-preview.apk']) {
 rmSync(path.join(cwd,'dist/client/downloads',file),{force:true});
}
