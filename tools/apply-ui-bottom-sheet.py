#!/usr/bin/env python3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def read(path):return (ROOT/path).read_text()
def write(path,text):(ROOT/path).write_text(text)
def replace_once(path,old,new,label):
    text=read(path);count=text.count(old)
    if count!=1:raise RuntimeError(f'{path}: expected one {label}, found {count}')
    write(path,text.replace(old,new,1))
def append_once(path,marker,addition):
    text=read(path)
    if marker not in text:write(path,text.rstrip()+'\n\n'+addition.strip()+'\n')

replace_once(
 'web/lib/map-framing.ts',
 """ const transition=(event:Event)=>{if(event.target===panel&&(event as TransitionEvent).propertyName==='height')refit.settled();};""",
 """ const transition=(event:Event)=>{const property=(event as TransitionEvent).propertyName;if(event.target===panel&&(property==='height'||property==='transform'))refit.settled();};""",
 'drawer transition signal',
)

# A class change no longer changes the Leaflet container size; avoid invalidating
# and repainting every tile. Geometry is re-fitted once by transitionend.
replace_once(
 'web/components/Atlas2D.tsx',
 """    if(panel){resize.observe(panel);panelChanges=new MutationObserver(queueResize);panelChanges.observe(panel,{attributes:true,attributeFilter:['class','style']});}""",
 """    if(panel){resize.observe(panel);panelChanges=new MutationObserver(()=>{frameRefit.current?.resized();scheduleDirectionLayout();});panelChanges.observe(panel,{attributes:true,attributeFilter:['class','style']});}""",
 'Leaflet panel mutation path',
)

append_once(
 'web/app/map-ui-release.css',
 'Compositor bottom sheet release 0.4.8',
 r'''
/* Compositor bottom sheet release 0.4.8. */
@media(max-width:700px){
  .explore-layout .explore-panel{
    height:clamp(315px,50dvh,545px)!important;
    min-height:315px!important;
    max-height:545px!important;
    transform:translate3d(0,0,0);
    transition:transform .24s cubic-bezier(.22,1,.36,1)!important;
    backface-visibility:hidden;
    will-change:transform;
    contain:layout paint style;
  }
  .explore-layout .explore-panel.collapsed{
    height:clamp(315px,50dvh,545px)!important;
    min-height:315px!important;
    transform:translate3d(0,calc(100% - 132px),0);
  }
  .explore-layout .sheet-handle{min-height:44px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
}
@media(prefers-reduced-motion:reduce){
  .explore-layout .explore-panel{transition:none!important}
}
''',
)

# Update the existing framing contract to accept both the legacy height signal
# and the compositor transform signal.
path='web/tests/map-framing.test.mjs';text=read(path)
old="""test('map input bindings stop automatic framing while only the drawer height transition flushes it',()=>{"""
new="""test('map input bindings stop automatic framing while only drawer geometry transitions flush it',()=>{"""
if old not in text:raise RuntimeError('map framing test title changed unexpectedly')
text=text.replace(old,new,1)
old_block=""" panel.events.get('transitionend')({target:{},propertyName:'height'});
 panel.events.get('transitionend')({target:panel,propertyName:'opacity'});
 assert.equal(env.frames.size,0);
 panel.events.get('transitionend')({target:panel,propertyName:'height'});env.flushFrames();
 assert.equal(env.count(),1);unbind();assert.equal(surface.events.size,0);assert.equal(panel.events.size,0);"""
new_block=""" panel.events.get('transitionend')({target:{},propertyName:'transform'});
 panel.events.get('transitionend')({target:panel,propertyName:'opacity'});
 assert.equal(env.frames.size,0);
 panel.events.get('transitionend')({target:panel,propertyName:'transform'});env.flushFrames();
 assert.equal(env.count(),1);
 env.refit.select('legacy-height');env.refit.resized();panel.events.get('transitionend')({target:panel,propertyName:'height'});env.flushFrames();
 assert.equal(env.count(),2);unbind();assert.equal(surface.events.size,0);assert.equal(panel.events.size,0);"""
if old_block not in text:raise RuntimeError('map framing transition assertions changed unexpectedly')
write(path,text.replace(old_block,new_block,1))

append_once(
 'web/tests/ui-performance.test.mjs',
 'mobile sheet uses compositor movement rather than layout animation',
 r'''
test('mobile sheet uses compositor movement rather than layout animation',()=>{
  const css=read('app/map-ui-release.css');
  const framing=read('lib/map-framing.ts');
  const canvas=read('components/Atlas2D.tsx');
  assert.match(css,/explore-panel\.collapsed[\s\S]*translate3d/);
  assert.match(css,/transition:transform/);
  assert.match(css,/sheet-handle\{min-height:44px/);
  assert.match(framing,/property==='height'\|\|property==='transform'/);
  assert.doesNotMatch(canvas,/panelChanges=new MutationObserver\(queueResize\)/);
});
''',
)

Path(__file__).unlink()
print('mobile bottom sheet moved to compositor path')
