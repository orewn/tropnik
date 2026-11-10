import test from 'node:test';
import assert from 'node:assert/strict';
import {androidDownloadTarget} from '../lib/android-download.ts';

test('Worker download selects the exact versioned universal or ARM64 release asset', () => {
  assert.equal(androidDownloadTarget({version:'0.4.23-preview',architecture:'universal'},'tropnik-preview.apk'),
    'https://github.com/orewn/tropnik/releases/download/v0.4.23-preview/tropnik-preview.apk');
  assert.equal(androidDownloadTarget({version:'0.4.18-preview',architecture:'arm64-v8a'},'tropnik-arm64-preview.apk'),
    'https://github.com/orewn/tropnik/releases/download/v0.4.18-preview/tropnik-arm64-preview.apk');
});

test('Worker download cannot redirect a different filename or arbitrary URL', () => {
  const manifest={version:'0.4.23-preview',architecture:'universal'};
  for (const name of ['tropnik-arm64-preview.apk','android-manifest.json','../tropnik-preview.apk','https://example.com/','tropnik-preview.apk?next=x','']) {
    assert.equal(androidDownloadTarget(manifest,name),null);
  }
});

test('Worker download fails closed for unsupported release metadata', () => {
  for (const version of ['latest','0.4.23','../0.4.23-preview','0.4.23-preview?x=y']) {
    assert.equal(androidDownloadTarget({version,architecture:'universal'},'tropnik-preview.apk'),null);
  }
  assert.equal(androidDownloadTarget({version:'0.4.23-preview',architecture:'x86_64'},'tropnik-preview.apk'),null);
});
