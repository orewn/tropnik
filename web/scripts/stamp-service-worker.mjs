import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, relative, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Stable-URL geometry and manifests need the same cache invalidation as the
 * renderer. GitHub Pages additionally namespaces its worker by the build ID. */
export async function stampServiceWorker(root) {
  const publicRoot = join(root, 'public');
  const workerPath = join(publicRoot, 'sw.js');
  const source = await readFile(workerPath, 'utf8');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid application release version');
  const normalized = source.replace(/const VERSION\s*=\s*['"][^'"]+['"]/, "const VERSION='tropnik-shell-build'");
  if (normalized === source) throw new Error('Service worker cache version declaration is missing');
  const hash = createHash('sha256').update(version).update(normalized);
  const walk = async directory => {
    const entries = (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== workerPath && /\.(?:[cm]?js|css|html|json|geojson|coverage|webmanifest)$/.test(entry.name)) {
        hash.update(relative(publicRoot, path)).update(await readFile(path));
      }
    }
  };
  await walk(publicRoot);
  const identity = `tropnik-shell-${version}-${hash.digest('hex').slice(0, 16)}`;
  const next = normalized.replace("const VERSION='tropnik-shell-build'", `const VERSION='${identity}'`);
  if (next !== source) await writeFile(workerPath, next);
  return identity;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await stampServiceWorker(resolve(import.meta.dirname, '..')));
}
