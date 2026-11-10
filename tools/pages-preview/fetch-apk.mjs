import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apkFileName, ensureApk, readApkManifest} from './apk-artifact.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(project, 'web/public/downloads');
if (process.argv.slice(2).some(value => value !== '--check-only')) throw new Error('Only --check-only is supported.');
const metadata = await readApkManifest(join(directory, 'android-manifest.json'));
const filename = apkFileName(metadata);
const result = await ensureApk(join(directory, filename), metadata, {download: !process.argv.includes('--check-only')});
console.log(JSON.stringify({file: `web/public/downloads/${filename}`, ...result}, null, 2));
