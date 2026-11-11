import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {terrainPresentationSources} from './terrain-presentation-sources.mjs';

const rootDefault=resolve(import.meta.dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
export function terrainUnmaskedSources(root=rootDefault){
 const source=terrainPresentationSources(root),bindings={...source.bindings};delete bindings.fixtureSHA256;delete bindings.testSHA256;
 const literal=(text,name)=>{
  const prefix='const '+name+'=`',start=text.indexOf(prefix);assert.ok(start>=0&&text.indexOf(prefix,start+1)<0,'Missing unique shader '+name);
  const end=text.indexOf('`;',start+prefix.length);assert.ok(end>start);const value=text.slice(start+prefix.length,end);assert.ok(!value.includes('${'),'Interpolated fixture shader');return value;
 };
 const shaders={...bindings.shaders};
 for(const [name,key]of [['GROUND_FRAGMENT','groundFragmentSHA256'],['BOUNDARY_FRAGMENT','boundaryFragmentSHA256']]){
  const current=literal(source.production,name),reference=literal(source.reference.toString('utf8'),name);assert.equal(current,reference,'The original unmasked shader changed');shaders[key]=sha(current);
 }
 return{production:source.production,reference:source.reference,bindings:{...bindings,shaders,
  fixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-unmasked-fixture.mjs'))),
  testSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-unmasked.browser.mjs'))),
  validatorSHA256:sha(readFileSync(join(root,'tools/pages-preview/terrain-unmasked-report.mjs'))),
 }};
}
