import test from 'node:test';
import assert from 'node:assert/strict';
import {pagesPath, rewriteScript, rewriteHTML} from '../paths.mjs';

test('search and account actions stay inside the published project for links and imperative navigation',()=>{
  const base='/tropnik/';
  for(const path of ['/search','/search?q=Байкал','/account/action#token=test']) assert.equal(pagesPath(path,base),base+path.slice(1));
  const source='const a=<a href="/search">Поиск</a>; window.location.assign("/search"); const b=`/search?q=${query}`;';
  const transformed=rewriteScript(source,'Header.tsx',{base});
  assert.ok(transformed.includes('href="/tropnik/search"'));
  assert.ok(transformed.includes('assign("/tropnik/search")'));
  assert.ok(transformed.includes('`/tropnik/search?q=${query}`'));
  assert.equal(rewriteHTML('<a href="/search">Поиск</a>',base),'<a href="/tropnik/search">Поиск</a>');
  assert.equal(pagesPath('https://example.org/search',base),'https://example.org/search');
});
