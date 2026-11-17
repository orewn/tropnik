import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMobileExperience,assertMobileTargets,MOBILE_EXPERIENCE_SOURCES} from '../browser-mobile-experience.mjs';
import {mobileExperienceFixture,mobileTargetsFixture,mobileBuildFixture} from './mobile-experience-fixture.mjs';

const build=mobileBuildFixture(),binding={sourceCommit:build.sourceCommit,buildId:build.buildId,sources:Object.fromEntries(build.inputs.map(input=>[input.path,input.sha256]))};

test('two native mobile scenarios preserve distinct route contexts and bind their evidence to the build inputs',()=>{
 const receipt=mobileExperienceFixture();assert.equal(assertMobileExperience(receipt,binding),receipt);
 assert.notEqual(receipt.scenarios[0].route.id,receipt.scenarios[1].route.id);
 for(const [name,change] of [
  ['different commit',value=>value.sourceCommit='b'.repeat(40)],
  ['different build',value=>value.buildId='e'.repeat(16)],
  ['different input bytes',value=>value.sources[MOBILE_EXPERIENCE_SOURCES[0]]='e'.repeat(64)],
  ['missing input',value=>delete value.sources[MOBILE_EXPERIENCE_SOURCES[1]]],
  ['missing scenario',value=>value.scenarios.pop()],
  ['emulation reported as physical device',value=>value.physicalDevice=true],
  ['same saved and map route',value=>value.scenarios[1].route.id=value.scenarios[0].route.id],
  ['programmatic typing',value=>value.scenarios[0].typing.method='setInputValue'],
  ['synthetic text input',value=>value.scenarios[0].typing.events[1].trusted=false],
  ['wrong typed text',value=>value.scenarios[0].typing.events.findLast(event=>event.type==='input').value='Байкал'],
  ['input not focused',value=>value.scenarios[0].focused.focus.search=false],
  ['search keyboard retained',value=>value.scenarios[0].submit.after.search=true],
  ['input obscured',value=>value.scenarios[0].focused.focus.unobscured=false],
  ['synthetic keyboard',value=>value.scenarios[0].filter.end.events[0].trusted=false],
  ['no native filter change',value=>value.scenarios[0].filter.end.events.splice(1,1)],
  ['Tab escapes filter dialog',value=>value.scenarios[0].filter.tabs[0].after.inDialog=false],
  ['unchanged difficulty',value=>value.scenarios[0].filter.selected.values.difficulty='all'],
  ['native scroll missing',value=>value.scenarios[0].scroll.commands=[]],
  ['route click untrusted',value=>value.scenarios[0].selected.events[0].trusted=false],
  ['save still pending',value=>value.scenarios[0].saved.save.busy='true'],
  ['save not applied',value=>value.scenarios[0].saved.save.pressed='false'],
  ['show map selected another route',value=>value.scenarios[0].onMap.route='different'],
  ['show map kept sheet open',value=>value.scenarios[0].onMap.sheet='open'],
  ['show map lacks completed paint',value=>value.scenarios[0].onMap.map.rendering.painted=false],
  ['show map hides camera delta',value=>value.scenarios[0].framing.cameraDelta.zoom=1],
  ['browser Back replaced by state mutation',value=>value.scenarios[0].back.method='history.replaceState'],
  ['history target differs from actual URL',value=>value.scenarios[0].back.target.url+='&wrong=1'],
  ['query lost on Back',value=>value.scenarios[0].restored.query=''],
  ['list position lost on Back',value=>value.scenarios[0].restored.scroll.top=0],
  ['filter lost on Back',value=>value.scenarios[0].restored.filters.summary='Фильтры'],
  ['map remounted',value=>value.scenarios[0].restored.canvasBackendNodeId++],
  ['second canvas',value=>value.scenarios[0].restored.canvasCount=2],
  ['camera lost',value=>value.scenarios[1].mapRestored.map.camera.longitude+=.1],
  ['manual movement not delivered',value=>value.scenarios[1].pan.input.events=[]],
  ['manual camera never moved',value=>value.scenarios[1].pan.after.map.camera=structuredClone(value.scenarios[1].pan.before.map.camera)],
  ['saved route replaced map context',value=>value.scenarios[1].mapRestored.route='route-b'],
  ['repeated current Map pushed history',value=>value.scenarios[1].mapRepeated.historyLength++],
  ['repeated current Saved moved scroll',value=>value.scenarios[1].saved.repeated.scroll.top+=80],
  ['Saved origin lost',value=>value.scenarios[1].saved.detail.origin='catalog'],
  ['Saved Back lost position',value=>value.scenarios[1].saved.restored.scroll.top+=50],
  ['More background not inert',value=>value.scenarios[1].more.open.mainInert=false],
  ['More Tab escaped',value=>value.scenarios[1].more.tabbed.focus.inMenu=false],
  ['More Escape lost focus',value=>value.scenarios[1].more.closed.focus.destination='map'],
  ['More Escape left background inert',value=>value.scenarios[1].more.closed.mainInert=true],
  ['restored hidden difficulty differs',value=>value.scenarios[1].filter.restored.values.difficulty='easy'],
  ['cleanup bypassed UI',value=>value.cleanup.confirm.events=[]],
  ['cleanup left fixture card',value=>value.cleanup.after.savedIds=['route-b']],
  ['missing target state',value=>value.targets.pop()],
 ]){
  const invalid=mobileExperienceFixture();change(invalid);assert.throws(()=>assertMobileExperience(invalid,binding),name);
 }
});

test('ShowMap records a completed automatic refit while returned manual context still stays exact',()=>{
 const receipt=mobileExperienceFixture(),search=receipt.scenarios[0];
 search.onMap.map.camera.zoom+=.3;search.onMap.map.camera.latitude+=.01;
 search.framing.cameraDelta=Object.fromEntries(['longitude','latitude','zoom'].map(key=>[key,search.onMap.map.camera[key]-search.saved.map.camera[key]]));
 assert.equal(assertMobileExperience(receipt,binding),receipt);
});

test('Saved-list Back preserves its list without imposing Map workspace camera on an independent Saved view',()=>{
 const receipt=mobileExperienceFixture();receipt.scenarios[1].saved.restored.map.camera.longitude+=.2;
 assert.equal(assertMobileExperience(receipt,binding),receipt);
 receipt.scenarios[1].mapRestored.map.camera.longitude+=.2;
 assert.throws(()=>assertMobileExperience(receipt,binding),'Returning to Map must still restore the original manual camera');
});

test('48px checks require real visible named targets and five unobscured hit samples',()=>{
 const valid=mobileTargetsFixture();assert.equal(assertMobileTargets(valid,'initial'),valid);
 for(const [name,change] of [
  ['missing primary destination',value=>value.targets.splice(1,1)],
  ['extra primary destination',value=>value.navigation.push({id:'trips',text:'Походы',active:false})],
  ['two active destinations',value=>value.navigation[1].active=true],
  ['mobile stories start expanded',value=>value.storyExpanded=true],
  ['old 44px target',value=>{value.targets[0].rect.width=44;value.targets[0].rect.right=value.targets[0].rect.left+44;}],
  ['short target',value=>{value.targets[0].rect.height=40;value.targets[0].rect.bottom=value.targets[0].rect.top+40;}],
  ['no accessible name',value=>value.targets[0].label=''],
  ['inert target',value=>value.targets[0].visible=false],
  ['disabled target',value=>value.targets[0].disabled=true],
  ['covered corner',value=>value.targets[0].samples[4].owned=false],
  ['missing hit tests',value=>value.targets[0].samples=[]],
  ['hit tested another position',value=>value.targets[0].samples[0].x+=20],
  ['target outside viewport',value=>{value.targets[0].rect.left=-20;value.targets[0].rect.right=28;}],
 ]){
  const invalid=mobileTargetsFixture();change(invalid);assert.throws(()=>assertMobileTargets(invalid,'initial'),name);
 }
});
