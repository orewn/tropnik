import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {groupMapDirections,directionGroupsOverlap,directionMarkerContent,directionCountLabel,directionLabelWidth,mapLabelPlacement,mapLabelSafeRect,mapLabelShift,mapLabelAvoidObstacles,updateDirectionButtons} from '../lib/map-direction-layout.ts';
import {russiaCamera,russiaPadding,russiaLongitude} from '../public/maps/russia-viewport.js';

// Use the actual fifteen directions, not a separately maintained coordinate
// fixture. Only checked-in modules beneath web/ may be loaded by this test.
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(web,'package.json')),ts=require('typescript'),cache=new Map();
function load(path){
  assert.ok(path.startsWith(web+sep));
  if(cache.has(path))return cache.get(path);
  if(path.endsWith('.json'))return JSON.parse(readFileSync(path,'utf8'));
  const module={exports:{}};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',code)(id=>load((id.startsWith('@/')?resolve(web,id.slice(2)):resolve(dirname(path),id))+(id.endsWith('.json')?'':'.ts')),module,module.exports);
  cache.set(path,module.exports);return module.exports;
}
const {regions}=load(resolve(web,'lib/content.ts'));
const southIds=['adygea','karachay-cherkessia','kabardino-balkaria','krasnodar','krym'];
const project=(zoom,tileSize)=>([lng,lat])=>({
  x:russiaLongitude(lng)/360*tileSize*2**zoom,
  y:-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/(2*Math.PI)*tileSize*2**zoom,
});
const views=[{width:1100,height:780,covered:0},{width:390,height:772,covered:420},{width:320,height:640,covered:420}];

for(const view of views)for(const tileSize of [256,512])test(`real country markers do not collide: ${view.width}px, ${tileSize}px tiles`,()=>{
  assert.equal(regions.length,15);
  const camera=russiaCamera(view.width,view.height,russiaPadding(view.width,view.height,view.covered),tileSize);
  const groups=groupMapDirections(regions,project(camera.zoom,tileSize));
  assert.deepEqual(groups.flatMap(group=>group.members.map(item=>item.id)).sort(),regions.map(item=>item.id).sort(),'every direction remains reachable exactly once');
  assert.ok(groups.some(group=>southIds.every(id=>group.members.some(item=>item.id===id))),'all five overlapping southern labels share one control at country scale');
  for(let i=0;i<groups.length;i++){
    assert.ok(groups[i].members.includes(groups[i].anchor),'a marker stays on a real member centre');
    for(let j=i+1;j<groups.length;j++)assert.equal(directionGroupsOverlap(groups[i],groups[j]),false,'cluster labels and standalone 44px controls leave a gap');
  }
  assert.deepEqual(groupMapDirections([...regions].reverse(),project(camera.zoom,tileSize)),groups,'catalogue ordering does not move or rename groups');
});

test('zooming the actual southern centres apart reveals every individual direction',()=>{
  const south=regions.filter(item=>southIds.includes(item.id));
  const groups=groupMapDirections(south,project(8,512));
  assert.equal(groups.length,5);
  assert.ok(groups.every(group=>group.members.length===1));
  assert.deepEqual(groups.map(group=>group.anchor.id).sort(),southIds.toSorted());
});

test('cluster zoom bounds contain only real member centres and unwrap the dateline',()=>{
  const members=[{id:'east',name:'Восток',center:[-179,60]},{id:'west',name:'Запад',center:[178,61]}];
  const [group]=groupMapDirections(members,([lng,lat])=>({x:russiaLongitude(lng),y:lat}));
  assert.deepEqual(group.bounds,[178,60,181,61]);
  assert.ok(members.includes(group.anchor));
  assert.equal(group.members.length,2);
});

test('a cluster names directions instead of summing shared route counts',()=>{
  const south=regions.filter(item=>southIds.includes(item.id));
  const [group]=groupMapDirections(south,()=>({x:0,y:0}));
  const content=directionMarkerContent(group,999,true);
  assert.equal(content.label,'5 направлений');
  assert.equal(content.count,'');
  assert.ok(!content.ariaLabel.includes('999'));
  for(const item of south)assert.ok(content.ariaLabel.includes(item.name));
  assert.deepEqual([1,2,5,11,21,22].map(directionCountLabel),['1 направление','2 направления','5 направлений','11 направлений','21 направление','22 направления']);
});

test('regrouping transfers keyboard focus and restores a separate selected direction',()=>{
  const ownerDocument={activeElement:null},buttons=new Map();
  for(const id of ['a','b']){
    const classes=new Set(),attributes=new Map(),dot={textContent:''},label={textContent:''};
    buttons.set(id,{ownerDocument,hidden:false,title:'',classes,attributes,dot,label,
      classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)},
      querySelector:selector=>selector==='.region-marker-dot'?dot:label,
      setAttribute:(name,value)=>attributes.set(name,value),
      removeAttribute:name=>attributes.delete(name),
      focus:options=>{assert.equal(options.preventScroll,true);ownerDocument.activeElement=buttons.get(id);},
    });
  }
  const members=[{id:'a',name:'А',center:[40,44]},{id:'b',name:'Б',center:[41,44]}];
  ownerDocument.activeElement=buttons.get('b');
  const clustered=groupMapDirections(members,()=>({x:0,y:0}));
  updateDirectionButtons(buttons,clustered,new Map([['a',50],['b',60]]),true);
  assert.equal(buttons.get('b').hidden,true);
  assert.equal(ownerDocument.activeElement,buttons.get('a'));
  assert.equal(buttons.get('a').label.textContent,'2 направления');
  const expanded=groupMapDirections(members,([lng])=>({x:lng*200,y:0}));
  updateDirectionButtons(buttons,expanded,new Map([['a',7],['b',3]]),true,'b');
  assert.ok([...buttons.values()].every(button=>!button.hidden));
  assert.equal(buttons.get('b').label.textContent,'Б');
  assert.equal(buttons.get('b').dot.textContent,'3');
  assert.ok(buttons.get('b').classes.has('is-selected'));
  assert.ok(!buttons.get('a').classes.has('direction-cluster'));
  assert.equal(buttons.get('b').attributes.get('aria-label'),'Открыть Б, маршрутов в каталоге: 3');
});

test('safe-area rules keep labels inside all four map edges',()=>{
  const wide=mapLabelSafeRect({left:0,right:1000,top:0,bottom:800},false);
  assert.deepEqual(wide,{left:18,right:922,top:72,bottom:740});
  const compact=mapLabelSafeRect({left:0,right:390,top:0,bottom:772},true,410);
  assert.deepEqual(compact,{left:12,right:332,top:62,bottom:410});
  assert.deepEqual(mapLabelShift({left:-30,right:110,top:90,bottom:130},wide),{x:48,y:0});
  assert.deepEqual(mapLabelShift({left:900,right:1040,top:710,bottom:770},wide),{x:-118,y:-30});
  assert.equal(mapLabelPlacement('bottom',{left:100,right:132,top:700,bottom:732},40,wide),'top');
  assert.equal(mapLabelPlacement('top',{left:100,right:132,top:75,bottom:107},40,wide),'bottom');
  assert.ok(directionLabelWidth('Петропавловск-Камчатский')<=168);
  assert.ok(directionLabelWidth('Алтай')>=84);
});

test('labels avoid floating cards and controls without moving their map anchor',()=>{
  const safe={left:18,right:922,top:72,bottom:740};
  const label={left:720,right:880,top:110,bottom:150};
  const card={left:700,right:920,top:80,bottom:260};
  const result=mapLabelAvoidObstacles(label,safe,[card],8);
  const moved={left:label.left+result.x,right:label.right+result.x,top:label.top+result.y,bottom:label.bottom+result.y};
  assert.equal(result.hidden,false);
  assert.ok(moved.right<=card.left-8||moved.left>=card.right+8||moved.bottom<=card.top-8||moved.top>=card.bottom+8);
  assert.ok(moved.left>=safe.left&&moved.right<=safe.right&&moved.top>=safe.top&&moved.bottom<=safe.bottom);
});

test('labels hide rather than overlap when no legal rectangle exists',()=>{
  const safe={left:0,right:100,top:0,bottom:80};
  const label={left:10,right:90,top:20,bottom:60};
  const result=mapLabelAvoidObstacles(label,safe,[{left:0,right:100,top:0,bottom:80}],8);
  assert.equal(result.hidden,true);
});
