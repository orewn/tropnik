import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLayerMenuAudit,assertOverviewCounts,assertExploreExperience,assertStyleCameraRoundtrip} from '../browser-report.mjs';
import {catalogueFixture,layerMenusFixture,overviewCountsFixture,savedReentryFixture,exploreExperienceFixture,styleCameraRoundtripFixture} from './experience-fixture.mjs';

function rejectsEach(make,validate,changes){
 for(const [name,change] of changes){const receipt=make();change(receipt);assert.throws(()=>validate(receipt),undefined,name);}
}
const checkLayers=receipt=>assertLayerMenuAudit(receipt,'compact-android');
const checkExplore=mobile=>receipt=>assertExploreExperience(receipt,mobile?'android-portrait':'desktop-webgl',mobile?'leaflet':'maplibre',mobile,catalogueFixture);
const checkStyle=receipt=>assertStyleCameraRoundtrip(receipt,'desktop-webgl');

test('portrait Layers validates closed and expanded geometry with real native scroll progress',()=>{
 const receipt=layerMenusFixture();assert.equal(checkLayers(receipt),receipt);
 assert.equal(receipt.states[0].scrolls.length,0);
 assert.equal(receipt.states[1].scrolls.length,1);
 assert.ok(receipt.states[1].frames[0].controls.some(control=>!control.inside));
 assert.ok(receipt.states[1].scrolls[0].events.length<receipt.states[1].scrolls[0].commands.length,'Coalesced trusted touch moves are valid');
});

test('Layers rejects clipping, incomplete reachability and unsupported pass flags',()=>{
 rejectsEach(layerMenusFixture,checkLayers,[
  ['old receipt',value=>value.schemaVersion=0],
  ['missing expanded state',value=>value.states.pop()],
  ['menu below exposed map',value=>{const frame=value.states[1].frames[0];frame.menu.bottom+=40;frame.menu.height+=40;}],
  ['button below exposed map',value=>{const button=value.states[1].frames[0].button;button.top+=300;button.bottom+=300;}],
  ['fake containment',value=>value.states[1].frames[0].controls.at(-1).inside=true],
  ['always obscured final link',value=>{for(const frame of value.states[1].frames)frame.controls.at(-1).unobscured=false;}],
  ['missing control',value=>value.states[0].frames[0].controls.pop()],
  ['changed control between frames',value=>value.states[1].frames[1].controls[0].label='Другой слой'],
  ['inconsistent rectangle',value=>value.states[0].frames[0].menu.width+=2],
  ['invented control point',value=>value.states[0].frames[0].controls[0].point.y+=4],
  ['untrusted open',value=>value.states[0].opened.events[2].trusted=false],
  ['click elsewhere',value=>value.states[0].closed.events[2].x+=5],
  ['another open control',value=>value.states[0].opened.selector='.sheet-handle'],
 ]);
});

test('Layers scrolling requires native delivery, unchanged layout and connected measured frames',()=>{
 rejectsEach(layerMenusFixture,checkLayers,[
  ['missing scroll',value=>value.states[1].scrolls=[]],
  ['no actual scrolling',value=>value.states[1].scrolls[0].after.scrollTop=0],
  ['unrelated frames',value=>value.states[1].scrolls[0].after.scrollTop=90],
  ['page scrolled',value=>value.states[1].scrolls[0].after.scrollY=3],
  ['sheet closed',value=>value.states[1].scrolls[0].after.sheet='closed'],
  ['rejected CDP command',value=>value.states[1].scrolls[0].commands[4].status='rejected'],
  ['missing native move',value=>value.states[1].scrolls[0].commands.splice(4,1)],
  ['untrusted scroll event',value=>value.states[1].scrolls[0].events[1].trusted=false],
  ['no delivered movement',value=>value.states[1].scrolls[0].events.splice(1,1)],
  ['gesture began elsewhere',value=>value.states[1].scrolls[0].events[0].x+=10],
  ['gesture ended elsewhere',value=>value.states[1].scrolls[0].events.at(-1).y+=10],
  ['layout moved',value=>{const menu=value.states[1].frames[1].menu;menu.top+=2;menu.bottom+=2;}],
  ['unbounded scrolling',value=>{value.states[1].frames=Array(10).fill(value.states[1].frames[0]);value.states[1].scrolls=Array(9).fill(value.states[1].scrolls[0]);}],
 ]);
});

test('Explore receipts accept native touch and mouse with actual browser Back and same-route note retention',()=>{
 for(const mobile of [true,false]){const receipt=exploreExperienceFixture(mobile);assert.equal(checkExplore(mobile)(receipt),receipt);}
});

test('fully clustered country receipts retain count evidence through native ordinary Altai reentry',()=>{
 for(const mobile of [true,false]){
  const receipt=exploreExperienceFixture(mobile);
  receipt.filterReset.overviewBefore=overviewCountsFixture(true);receipt.filterReset.overviewAfter=overviewCountsFixture(true);
  receipt.filterReset.reentryActions=savedReentryFixture(mobile,true);
  assert.equal(checkExplore(mobile)(receipt),receipt);
  assert.equal(receipt.filterReset.overviewAfter.markers[0].count,2,'A cluster counts directions, not its 21 routes');
  assert.equal(receipt.filterReset.reentryActions.at(-1).grid.surfaces.find(item=>item.kind==='count').text,'11');
 }
});

test('overview requires nonempty visible groups with unique known members and accurate badge semantics',()=>{
 const validate=receipt=>assertOverviewCounts(receipt,'country');
 assert.deepEqual(validate(overviewCountsFixture(true)),validate(overviewCountsFixture(false)));
 rejectsEach(()=>overviewCountsFixture(true),validate,[
  ['missing catalogue',value=>value.catalog=[]],
  ['missing all visible controls',value=>value.markers=[]],
  ['missing catalogue ID',value=>delete value.catalog[0].id],
  ['duplicate catalogue ID',value=>value.catalog[1].id='altai'],
  ['group badge mistaken for route sum',value=>value.markers[0].count=21],
  ['unknown group member',value=>value.markers[0].groupKey='altai|unknown'],
  ['duplicated group member',value=>value.markers[0].groupKey='altai|altai'],
  ['nonmember anchor',value=>value.markers[0].id='another'],
  ['missing membership',value=>delete value.markers[0].groupKey],
  ['group mislabeled ordinary',value=>value.markers[0].cluster=false],
  ['direction repeated across controls',value=>value.markers.push(overviewCountsFixture().markers[1])],
  ['all represented directions secretly empty',value=>{for(const item of value.catalog)item.count=0;}],
 ]);
 rejectsEach(overviewCountsFixture,validate,[
  ['ordinary count secretly filtered',value=>value.markers[0].count=0],
  ['ordinary name mapped to wrong ID',value=>value.markers[0].name='Байкал'],
 ]);
});

test('Saved reset always needs delivered native expansion and an ordinary Altai count of eleven',()=>{
 const make=()=>{const value=exploreExperienceFixture();value.filterReset.reentryActions=savedReentryFixture(true,true);return value;};
 rejectsEach(make,checkExplore(true),[
  ['old catalogue-only reentry',value=>delete value.filterReset.reentryActions],
  ['no native reentry',value=>value.filterReset.reentryActions=[]],
  ['unbounded reentry',value=>value.filterReset.reentryActions=Array(8).fill(value.filterReset.reentryActions[0])],
  ['group-only proof',value=>value.filterReset.reentryActions.pop()],
  ['synthetic expansion',value=>value.filterReset.reentryActions[0].events[2].trusted=false],
  ['expansion made no progress',value=>value.filterReset.reentryActions[0].after.zoom=2],
  ['cluster shows route sum',value=>value.filterReset.reentryActions[0].grid.surfaces.find(item=>item.kind==='count').text='21'],
  ['ordinary Altai remains filtered',value=>value.filterReset.reentryActions[1].grid.surfaces.find(item=>item.kind==='count').text='0'],
  ['ordinary Altai count hidden',value=>value.filterReset.reentryActions[1].grid.surfaces.find(item=>item.kind==='count').visible=false],
  ['ordinary input missing',value=>value.filterReset.reentryActions[1].events=[]],
  ['ordinary input used stale group',value=>value.filterReset.reentryActions[1].events[2].button.groupKey='altai|baikal'],
  ['ordinary input reached elsewhere',value=>value.filterReset.reentryActions[1].events[2].x+=10],
  ['wrong region selected',value=>value.filterReset.reentryActions[1].after.region='baikal'],
  ['count was not observed in overview',value=>value.filterReset.reentryActions[1].before.region='altai'],
  ['disconnected camera progression',value=>value.filterReset.reentryActions[1].before.zoom+=.2],
 ]);
});

test('hidden Saved filters cannot pass when overview counts or reentered controls disagree',()=>{
 rejectsEach(exploreExperienceFixture,checkExplore(true),[
  ['Saved did not activate',value=>value.filterReset.filtered.pressed='false'],
  ['filtered catalogue was not empty',value=>value.filterReset.filtered.count=11],
  ['Saved stayed active',value=>value.filterReset.restored.pressed='true'],
  ['filter panel stayed expanded',value=>value.filterReset.restored.expanded='true'],
  ['restored catalogue empty',value=>value.filterReset.restored.empty=true],
  ['restored count changed',value=>value.filterReset.restored.count=10],
  ['country count secretly filtered',value=>value.filterReset.overviewAfter.mapTotal=0],
  ['flag secretly filtered',value=>value.filterReset.overviewAfter.markers[0].count=0],
  ['catalogue secretly filtered',value=>{value.filterReset.overviewAfter.catalog[0].count=0;value.filterReset.overviewAfter.markers[0].count=0;}],
  ['all flags empty',value=>{value.filterReset.overviewAfter.markers=[{id:'empty',name:'Другое',count:0,groupKey:'empty',cluster:false,ariaLabel:'Открыть Другое'}];value.filterReset.overviewAfter.catalog.push({id:'empty',name:'Другое',count:0});}],
  ['unrelated marker',value=>value.filterReset.overviewAfter.markers[0].name='Другой регион'],
  ['no native toggle',value=>value.filterReset.enabled.events=[]],
  ['reentry did not use count',value=>value.filterReset.reentryActions[0].kind='label'],
 ]);
});

test('sibling selection must reach named overview and browser Back must restore the actual sibling entry',()=>{
 rejectsEach(exploreExperienceFixture,checkExplore(true),[
  ['parent returned to previous region',value=>{value.siblingParent.overview.region='baikal';value.siblingParent.overview.history.level=1;}],
  ['same region again',value=>value.siblingParent.sibling.region='baikal'],
  ['polygon point names another region',value=>value.siblingParent.selected.point.id='altai'],
  ['no native polygon input',value=>value.siblingParent.selected.events[2].trusted=false],
  ['programmatic history mutation',value=>value.siblingParent.back.method='history.replaceState'],
  ['same browser history entry',value=>value.siblingParent.back.target.id=value.siblingParent.back.from.id],
  ['wrong actual history URL',value=>value.siblingParent.back.url+='&route=another'],
  ['wrong target selection',value=>{const back=value.siblingParent.back;back.url=back.target.url=back.target.url.replace('buryatia','altai');}],
  ['wrong source URL',value=>value.siblingParent.back.from.url+='&region=baikal'],
  ['different base path',value=>{const back=value.siblingParent.back;back.url=back.target.url=back.target.url.replace('/tropnik/','/wrong/');}],
  ['popstate did not restore selection',value=>value.siblingParent.back.after.region='baikal'],
  ['wrong history level',value=>value.siblingParent.back.after.history.level=0],
 ]);
});

test('request ownership rejects stale dialogs, lost same-route drafts and copied state on route B',()=>{
 rejectsEach(exploreExperienceFixture,checkExplore(true),[
  ['initial wrong route',value=>value.requestOwnership.first.routeTitle='Маршрут Б'],
  ['untrusted text edit',value=>value.requestOwnership.edit.events[0].trusted=false],
  ['text edit on another control',value=>value.requestOwnership.edit.events[0].tag='INPUT'],
  ['text was not delivered',value=>value.requestOwnership.edit.events[0].value=''],
  ['same-route note lost',value=>value.requestOwnership.same.note=''],
  ['dialog survived browser Back',value=>value.requestOwnership.afterBack.open=true],
  ['history targeted another region',value=>{const back=value.requestOwnership.back;back.target.url=back.url=back.url.replace('altai','baikal');}],
  ['route B is A',value=>value.requestOwnership.next.selection.route=value.requestOwnership.route.id],
  ['route B already has a dialog',value=>value.requestOwnership.next.before.open=true],
  ['route B copied note',value=>value.requestOwnership.next.dialog.note=value.requestOwnership.edit.note],
  ['route B copied date',value=>value.requestOwnership.next.dialog.date='2027-01-02'],
  ['route B copied error',value=>value.requestOwnership.next.dialog.error=true],
  ['route B copied success',value=>value.requestOwnership.next.dialog.success=true],
  ['an actual request was submitted',value=>value.requestOwnership.next.dialog.submitted=1],
  ['request button clicked elsewhere',value=>value.requestOwnership.opened.events[1].y+=20],
  ['native close missing',value=>value.requestOwnership.next.closed.events.pop()],
 ]);
});

test('desktop request ownership requires measured layout evidence while mobile keeps its viewport behavior',()=>{
 rejectsEach(()=>exploreExperienceFixture(false),checkExplore(false),[
  ['missing layout proof',value=>delete value.requestOwnership.mapLayout],
  ['observers still attached',value=>value.requestOwnership.mapLayout.active=true],
  ['transient map expansion',value=>{const layout=value.requestOwnership.mapLayout,expanded=structuredClone(layout.samples[0]);expanded.time=150;expanded.reason='resize';expanded.canvas.width+=15;layout.samples.splice(1,0,expanded);}],
 ]);
 const mobile=exploreExperienceFixture(true);assert.equal(mobile.requestOwnership.mapLayout,undefined);assert.equal(checkExplore(true)(mobile),mobile);
});

test('Explore catalogue scrolling validates each touch and mouse gesture without page or sheet movement',()=>{
 for(const mobile of [true,false])rejectsEach(()=>exploreExperienceFixture(mobile),checkExplore(mobile),[
  ['no scroll evidence',value=>delete value.requestOwnership.returnScrolls],
  ['unbounded scroll loop',value=>value.requestOwnership.returnScrolls=Array(13).fill(value.requestOwnership.returnScrolls[0])],
  ['wrong scroll target',value=>value.requestOwnership.scrolls[0].selector='body'],
  ['no delivered progress',value=>value.requestOwnership.scrolls[0].after.scrollTop=0],
  ['page moved',value=>value.requestOwnership.next.scrolls[0].after.scrollY=2],
  ['sheet moved',value=>value.requestOwnership.next.actionScrolls[0].after.sheet='closed'],
  ['input was synthetic',value=>value.requestOwnership.returnScrolls[0].events[0].trusted=false],
 ]);
});

test('style roundtrip accepts native restored-line hits for multipart routes and synchronous same-ID assignments',()=>{
 for(const edgeCount of [0,2]){
  const receipt=styleCameraRoundtripFixture('route',{edgeCount});assert.equal(checkStyle(receipt),receipt);
  assert.ok(receipt.transitions.every(transition=>transition.restored.mutations[0].old===receipt.routeId));
 }
 const receipt=styleCameraRoundtripFixture();receipt.transitions[0].frame.camera.longitude+=.000009;receipt.transitions[0].lineFrame.camera.zoom+=.009;
 assert.equal(checkStyle(receipt),receipt,'Sub-pixel settled-camera tolerances stay valid');
});

test('style roundtrip requires a genuine native zoom and manually changed camera before either base switch',()=>{
 rejectsEach(styleCameraRoundtripFixture,checkStyle,[
  ['no zoom command',value=>value.zoom.events=[]],
  ['wrong zoom amount',value=>value.zoomed.camera.zoom+=.1],
  ['pan made no camera change',value=>{value.manual.camera=structuredClone(value.zoomed.camera);value.pan.after.camera=structuredClone(value.zoomed.camera);}],
  ['pan changed zoom',value=>{value.manual.camera.zoom+=.5;value.pan.after.camera.zoom+=.5;}],
  ['pan pointer mismatch',value=>value.pan.events[1].pointerId=42],
  ['pan native command missing',value=>value.pan.commands.splice(5,1)],
  ['pan path differs',value=>value.pan.commands[5].x+=10],
  ['pan stationary hold missing',value=>value.pan.commands.at(-1).sentOffsetMs=value.pan.commands.at(-2).ackOffsetMs+10],
  ['pan result disconnected',value=>value.pan.after.camera.longitude+=.001],
  ['wrong selected route',value=>value.selection.route='another'],
 ]);
});

test('each style must preserve camera and selection and prove restored interactive route geometry',()=>{
 rejectsEach(styleCameraRoundtripFixture,checkStyle,[
  ['missing second base switch',value=>value.transitions.pop()],
  ['wrong native style label',value=>value.transitions[0].selected.point.label='Спутник'],
  ['untrusted style selection',value=>value.transitions[0].selected.events[2].trusted=false],
  ['camera refitted on style load',value=>value.transitions[0].frame.camera.longitude+=.001],
  ['native line selection refitted camera',value=>value.transitions[0].lineFrame.camera.latitude+=.001],
  ['zoom changed on style load',value=>value.transitions[1].frame.camera.zoom+=.02],
  ['selection lost',value=>value.transitions[0].selection.region='baikal'],
  ['another rendered route',value=>value.transitions[0].frame.route='another'],
  ['map did not settle',value=>value.transitions[0].lineFrame.moving=true],
  ['no post-switch route assignment',value=>value.transitions[0].restored.mutations=[]],
  ['wrong style checked',value=>value.transitions[0].restored.selected=false],
  ['missing restored line',value=>delete value.transitions[0].line],
  ['line belongs to another route',value=>value.transitions[0].line.route='another'],
  ['line click did not occur',value=>value.transitions[0].line.clicked=false],
  ['no native line input',value=>value.transitions[0].line.events=[]],
  ['line input was synthetic',value=>value.transitions[0].line.events[2].trusted=false],
  ['line was clicked elsewhere',value=>value.transitions[0].line.events[0].x+=10],
  ['multipart gained artificial edges',value=>value.transitions[0].restored.edges.after=2],
 ]);
 rejectsEach(()=>styleCameraRoundtripFixture('route',{edgeCount:2}),checkStyle,[
  ['existing source ends retained',value=>value.transitions[0].restored.edges.replaced=0],
  ['source end removed',value=>value.transitions[0].restored.edges.after=1],
 ]);
});
