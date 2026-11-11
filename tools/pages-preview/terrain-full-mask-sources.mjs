import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';

const repoRoot=resolve(import.meta.dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
export function terrainFullMaskSources(root=repoRoot){
 const require=createRequire(join(root,'web/package.json')),ts=require('typescript'),production=readFileSync(join(root,'web/public/terrain/terrain-renderer.js'),'utf8');
 const ast=ts.createSourceFile('terrain-renderer.js',production,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const factories=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='terrainFragmentForMask');
 assert.equal(factories.length,1,'The only test baseline change must be the production mask shader factory');
 const body=factories[0].body;assert.ok(body);const start=body.getStart(ast),end=body.end,replacement='{return TERRAIN_FRAGMENT;}';
 const baseline=production.slice(0,start)+replacement+production.slice(end);
 const stringExpression=(value,depth)=>{
  assert.ok(depth<16,'Unexpected recursive shader constant');
  if(ts.isStringLiteral(value)||ts.isNoSubstitutionTemplateLiteral(value))return value.text;
  if(ts.isIdentifier(value))return constant(value.text,depth+1);
  assert.ok(ts.isBinaryExpression(value)&&value.operatorToken.kind===ts.SyntaxKind.PlusToken,'Unexpected shader source expression');
  return stringExpression(value.left,depth+1)+stringExpression(value.right,depth+1);
 };
 const constant=(name,depth=0)=>{
  const declarations=ast.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations]).filter(node=>ts.isIdentifier(node.name)&&node.name.text===name);
  assert.equal(declarations.length,1);return stringExpression(declarations[0].initializer,depth);
 };
 const fragment=constant('TERRAIN_FRAGMENT'),vertex=constant('TERRAIN_VERTEX'),discard=' if(texture(uDisplayMask,vUV).r<.5)discard;\n';
 assert.equal(fragment.split(discard).length,2,'The old shader must contain exactly one mask discard');
 return{production,baseline,bindings:{rendererSHA256:sha(production),baselineRendererSHA256:sha(baseline),
  baselineTransform:{function:'terrainFragmentForMask',replacedBodies:1,originalBodySHA256:sha(production.slice(start,end)),replacementBodySHA256:sha(replacement),replacement},
  fixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-full-mask-fixture.mjs'))),
  testSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-full-mask.browser.mjs'))),
  maskFixtureSHA256:sha(readFileSync(join(root,'tools/pages-preview/tests/terrain-mask-fixture.mjs'))),
  shaders:{vertexSHA256:sha(vertex),baselineFragmentSHA256:sha(fragment),fullFragmentSHA256:sha(fragment.replace(discard,''))},
 }};
}
