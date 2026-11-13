import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/pages.yml');
const push = workflow.split(/^  push:\s*$/m)[1]?.split(/^  workflow_dispatch:\s*$/m)[0];
assert.ok(push, 'The Pages push and manual trigger must remain explicit.');
assert.match(push, /^    branches: \[main\]$/m);
assert.doesNotMatch(push, /^    paths-ignore:/m);
const paths = [...push.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
assert.ok(paths.length > 0, 'Pages must declare its build inputs.');

// This gate deliberately uses only exact paths and whole-directory globs. Reject
// new pattern syntax until its trigger semantics have been reviewed explicitly.
function included(path) {
  return paths.some(pattern => {
    assert.match(pattern, /^(?:[\w.-]+\/)*[\w.-]+(?:\/\*\*)?$/);
    return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
  });
}

test('Pages triggers cover every pinned shared-map compiler input', () => {
  const manifest = JSON.parse(read('web/public/custom-map/manifest.json'));
  assert.ok(manifest.sourceInputs.length > 0);
  for (const input of manifest.sourceInputs) {
    assert.ok(included(input.path), `Shared-map input would skip Pages: ${input.path}`);
  }
});

test('Pages retains the complete web, tooling and data dependency directories', () => {
  for (const path of [
    'web/app/page.tsx', 'web/pnpm-lock.yaml', 'web/scripts/prepare-editorial-geometry.py',
    'web/public/downloads/android-manifest.json', 'web/tests/backend-origin.test.mjs',
    'tools/pages-preview/build.mjs', 'tools/import-data/recover_route_coverage.py',
    'tools/import-data/telegram/importer.py', 'tools/map-package/requirements-territories.txt',
    'data/catalog/editorial-geometry-review.json', 'data/catalog/coverage-recovery/acquisition.json',
    'contracts/api.ts', 'contracts/openapi.yaml',
    'docs/verification/place-stories-2026-11-13.json',
    '.github/workflows/pages.yml', '.gitignore',
  ]) assert.ok(included(path), `Build dependency would skip Pages: ${path}`);
});

test('independent server and Kotlin changes do not enqueue a static publication', () => {
  for (const path of [
    'backend/internal/store/postgres.go', 'infra/compose.yaml',
    'android/app/src/main/java/ru/tropa/app/OnlineViewModel.kt',
    '.github/workflows/backend.yml', '.github/workflows/android.yml',
    'docs/project-memory.md', 'README.md',
  ]) assert.equal(included(path), false, `Unrelated input would republish Pages: ${path}`);
});
