import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(web, 'package.json'));
const ts = require('typescript');

function declaration(file, name) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const variable = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
    if (variable) return {source, statement, variable};
  }
  assert.fail(`Missing ${name} declaration in ${file}`);
}

test('every generated static section invokes its real page loader instead of the 404 fallback', async () => {
  const buildFile = resolve(web, '../tools/pages-preview/build.mjs');
  const info = declaration(buildFile, 'infoPages');
  assert.ok(ts.isObjectLiteralExpression(info.variable.initializer));
  const sections = info.variable.initializer.properties.map(property => property.name.text);
  const entry = resolve(web, 'pages-preview/src/main.tsx');
  const registry = declaration(entry, 'loaders');
  // Execute the actual lazy registry. Imports are resolved to checked-in page files,
  // without mounting React or replacing the routing decisions with a test fixture.
  const compiled = ts.transpileModule(`const build = {hasApk: true};\n${registry.statement.getText(registry.source)}`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const loaders = new Function('require', `${compiled}\nreturn loaders;`)(specifier => {
    const file = resolve(dirname(entry), specifier + '.tsx');
    assert.ok(existsSync(file), `Page loader points to a missing module: ${specifier}`);
    return {file};
  });
  for (const kind of sections) {
    assert.equal(typeof loaders[kind], 'function', `Generated section ${kind} must not fall back to the 404 loader`);
    const loaded = await loaders[kind]();
    assert.equal(loaded.file, resolve(web, 'app', kind, 'page.tsx'));
  }
});
