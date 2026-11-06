// Export the current trusted application catalogue without loading any message
// text or contacting a service. JSON-only runtime imports keep the same boundary
// as tools/pages-preview/build.mjs.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
const require = createRequire(resolve(web, 'package.json'));
const ts = require('typescript');
let code = await readFile(resolve(web, 'lib/content.ts'), 'utf8');
const source = ts.createSourceFile('content.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const edits = [];
for (const node of source.statements) {
  if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
  const specifier = node.moduleSpecifier.text;
  if (!specifier.endsWith('.json') || !node.importClause?.name || node.importClause.namedBindings) throw new Error('Catalogue index allows only JSON runtime imports.');
  const path = specifier.startsWith('@/') ? resolve(web, specifier.slice(2)) : resolve(web, 'lib', specifier);
  if (!path.startsWith(web + sep)) throw new Error('Catalogue JSON import escaped web/.');
  const value = JSON.parse(await readFile(path, 'utf8'));
  edits.push([node.getStart(source), node.end, `const ${node.importClause.name.text}=${JSON.stringify(value)};`]);
}
for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + text + code.slice(end);
const compiled = ts.transpileModule(code, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {regions, trails} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
console.log(JSON.stringify({
  regions: regions.map(({id,name})=>({id,name})),
  routes: trails.map(trail=>({id:trail.id,title:trail.title,regionId:trail.regionId,sourceUrl:trail.sourceUrl,
    sourceUrls:[trail.sourceUrl,trail.officialEvidence?.url,...(trail.additionalSources||[]).map(source=>source.url)].filter(Boolean)})),
}));
