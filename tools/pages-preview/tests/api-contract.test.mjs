import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ts} from '../paths.mjs';

test('public API entry exports the identical canonical types without a runtime dependency', () => {
  const canonical = fileURLToPath(new URL('../../../web/lib/contract.ts', import.meta.url));
  const entry = fileURLToPath(new URL('../../../contracts/api.ts', import.meta.url));
  const options = {strict: true, noEmit: true, types: [], skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler};
  const program = ts.createProgram([canonical, entry], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  const checker = program.getTypeChecker();
  const exportsOf = file => checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)));
  const expected = new Map(exportsOf(canonical).map(symbol => [symbol.name, symbol]));
  const actual = exportsOf(entry);
  assert.ok(expected.has('Route') && expected.has('SafetyPassport') && expected.has('Envelope'));
  assert.deepEqual(actual.map(symbol => symbol.name).sort(), [...expected.keys()].sort());
  for (const symbol of actual) {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    assert.equal(resolved, expected.get(symbol.name), `Public type diverged: ${symbol.name}`);
  }
  const javascript = ts.transpileModule(readFileSync(entry, 'utf8'), {compilerOptions: options}).outputText;
  assert.match(javascript, /^export \{\};\s*$/);
});
