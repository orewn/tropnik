import {constrainRussiaCamera,russiaLongitude,type RussiaCamera} from '../public/maps/russia-viewport.js';

/** A covered viewport can require a camera centre just outside the geographic
 * rectangle even when every fitted feature is inside it. Permit only the
 * calculated frame's extra offset; the normal clamp returns within two zooms. */
export function constrainFramedCamera(lng:number,lat:number,zoom:number,overview:RussiaCamera,frame:RussiaCamera|null){
 const constrained=constrainRussiaCamera(lng,lat,zoom,overview);
 if(!frame||![...frame.center,frame.zoom].every(Number.isFinite))return constrained;
 const allowance=Math.max(0,Math.min(1,1-(zoom-frame.zoom)/2));
 if(!allowance)return constrained;
 const anchor=constrainRussiaCamera(...frame.center,zoom,overview);
 const permitted=frame.center.map((value,i)=>anchor.center[i]+(value-anchor.center[i])*allowance);
 const position=[russiaLongitude(lng),lat];
 return{...constrained,center:constrained.center.map((value,i)=>Math.max(Math.min(value,permitted[i]),Math.min(Math.max(value,permitted[i]),position[i]))) as [number,number]};
}

type FrameRefitOptions={
 allowed:()=>boolean;
 refit:()=>void;
 requestFrame?:(callback:()=>void)=>number;
 cancelFrame?:(id:number)=>void;
 defer?:(callback:()=>void)=>ReturnType<typeof setTimeout>;
 cancelDefer?:(id:ReturnType<typeof setTimeout>)=>void;
};

/** One settle timer and one frame at most. A gesture ends automatic framing
 * for this selection; subsequent layout changes must preserve the manual view. */
export class MapFrameRefit{
 private options:FrameRefitOptions;
 private selection:string|undefined;
 private enabled=false;
 private disposed=false;
 private revision=0;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private frame:number|undefined;
 constructor(options:FrameRefitOptions){this.options=options;}
 select(id:string|undefined){
  if(this.disposed||id===this.selection)return;
  this.clearPending();this.selection=id;this.enabled=!!id;
 }
 active(){return !this.disposed&&this.enabled&&this.options.allowed();}
 resized(){
  this.clearPending();if(!this.active())return;
  const revision=this.revision;
  const schedule=()=>{if(revision!==this.revision)return;this.timer=undefined;this.settled();};
  this.timer=this.options.defer?this.options.defer(schedule):setTimeout(schedule,96);
 }
 settled(){
  this.clearTimer();if(!this.active()||this.frame!==undefined)return;
  const revision=++this.revision;
  const paint=()=>{if(revision!==this.revision)return;this.frame=undefined;if(this.active())this.options.refit();};
  this.frame=this.options.requestFrame?this.options.requestFrame(paint):requestAnimationFrame(paint);
 }
 cancel(){this.enabled=false;this.clearPending();}
 dispose(){this.disposed=true;this.cancel();}
 private clearTimer(){
  if(this.timer!==undefined){if(this.options.cancelDefer)this.options.cancelDefer(this.timer);else clearTimeout(this.timer);this.timer=undefined;}
 }
 private clearPending(){
  this.revision++;
  this.clearTimer();
  if(this.frame!==undefined){if(this.options.cancelFrame)this.options.cancelFrame(this.frame);else cancelAnimationFrame(this.frame);this.frame=undefined;}
 }
}

/** DOM input signals distinguish user navigation from programmatic camera
 * movement, which also emits zoom/move events in both map libraries. */
export function bindMapFrameRefit(surface:HTMLElement,panel:Element|null,refit:MapFrameRefit){
 const stop=()=>refit.cancel();
 const keyboard=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','=','-','−','Home','End','PageUp','PageDown'].includes(event.key))stop();};
 const transition=(event:Event)=>{const property=(event as TransitionEvent).propertyName;if(event.target===panel&&(property==='transform'||property==='height'))refit.settled();};
 surface.addEventListener('pointerdown',stop,{passive:true});
 surface.addEventListener('touchstart',stop,{passive:true});
 surface.addEventListener('wheel',stop,{passive:true});
 surface.addEventListener('keydown',keyboard);
 panel?.addEventListener('transitionend',transition);
 return()=>{
  surface.removeEventListener('pointerdown',stop);surface.removeEventListener('touchstart',stop);
  surface.removeEventListener('wheel',stop);surface.removeEventListener('keydown',keyboard);
  panel?.removeEventListener('transitionend',transition);
 };
}
