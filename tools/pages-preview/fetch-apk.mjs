import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APK_FILE, ensureApk, readApkManifest} from './apk-artifact.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = join(project, 'web/public/downloads');
if (process.argv.slice(2).some(value => value !== '--check-only')) throw new Error('Only --check-only is supported.');
const metadata = await readApkManifest(join(directory, 'android-manifest.json'));
const result = await ensureApk(join(directory, APK_FILE), metadata, {download: !process.argv.includes('--check-only')});
console.log(JSON.stringify({file: `web/public/downloads/${APK_FILE}`, ...result}, null, 2));
