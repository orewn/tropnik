import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';

const repoRoot=resolve(import.meta.dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
export const TERRAIN_PRESENTATION_REFERENCE=Object.freeze({
 path:'tools/pages-preview/tests/fixtures/terrain-renderer-f36-reference.mjs',
 sourcePath:'web/public/terrain/terrain-renderer.js',
 sourceCommit:'dbcb2c53345b68ba2f44c6e861d38a9766810946',
 gitBlobSha:'1c2b9d746cd434f62e739f47ef246df70158795a',
 bytes:79132,sha256:'f36f3dbebc7b9acc1083fc9d39fc20821ef9d42872b9f5ec06245e695d5e1fed',
});
export function terrainPresentationSources(root=repoRoot){
 const require=createRequire(join(root,'web/package.json')),ts=require('typescript');
 const production=readFileSync(join(root,'web/public/terrain/terrain-renderer.js'),'utf8'),reference=readFileSync(join(root,TERRAIN_PRESENTATION_REFERENCE.path));
 assert.equal(reference.length,TERRAIN_PRESENTATION_REFERENCE.bytes,'The immutable direct renderer reference changed');
 assert.equal(sha(reference),TERRAIN_PRESENTATION_REFERENCE.sha256,'The immutable direct renderer reference changed');
 assert.notEqual(sha(production),sha(reference),'The new presentation cannot be its own old-path reference');
 const shaders=(source,withPresentation)=>{
  const ast=ts.createSourceFile('terrain-renderer.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const declarations=ast.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations]);
  const string=(node,depth=0)=>{
   assert.ok(depth<16,'Recursive shader source');
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
   if(ts.isIdentifier(node))return constant(node.text,depth+1);
   assert.ok(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken,'Unexpected shader source expression');
   return string(node.left,depth+1)+string(node.right,depth+1);
  };
  const constant=(name,depth=0)=>{const values=declarations.filter(node=>ts.isIdentifier(node.name)&&node.name.text===name);assert.equal(values.length,1);return string(values[0].initializer,depth);};
  const fragment=constant('TERRAIN_FRAGMENT'),discard=' if(texture(uDisplayMask,vUV).r<.5)discard;\n';assert.equal(fragment.split(discard).length,2);
  const result={vertexSHA256:sha(constant('TERRAIN_VERTEX')),mixedFragmentSHA256:sha(fragment),fullFragmentSHA256:sha(fragment.replace(discard,''))};
  if(withPresentation)result.presentationFragmentSHA256=sha(constant('PRESENT_FRAGMENT'));
  return result;
 };
 const currentShaders=shaders(production,true),referenceShaders=shaders(reference.toString('utf8'),false);
 for(const [key,value]of Object.entries(referenceShaders))assert.equal(currentShaders[key],value,'Presentation must retain the exact source height/material/mask shader: '+key);
 return{production,reference,bindings:{rendererSHA256:sha(production),reference:{...TERRAIN_PRESENTATION_REFERENCE},shaders:currentShaders,
  fixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-presentation-fixture.mjs'))),
  testSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-presentation.browser.mjs'))),
  dataFixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-full-mask-fixture.mjs'))),
  maskFixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-mask-fixture.mjs'))),
 }};
}
