/** Embedded by build-landscape.mjs; all terrain data and scripts remain local. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- build-landscape appends this entry point's invocation to the standalone script.
function mountLandscape(grid,route){
 let canvas=document.getElementById('terrain');
 const status=document.getElementById('status'),feedback=document.getElementById('feedback'),retry=document.getElementById('retry');
 let renderer=null,controller=null,preparing=false,disposed=false,terminal=false,generation=0,active=true,observer=null,creditTimer=null,creditShown=false;
 document.documentElement.dataset.sceneState='loading';
 const available=()=>active&&!disposed&&!terminal&&document.visibilityState!=='hidden';
 function terminalFailure(message){
  if(disposed||terminal)return;
  terminal=true;++generation;controller?.abort();observer?.disconnect();observer=null;
  if(creditTimer!==null){clearTimeout(creditTimer);creditTimer=null;}
  renderer?.destroy();renderer=null;
  document.documentElement.dataset.sceneState='failed';
  status.textContent=message||'Не удалось подготовить ландшафт. Можно попробовать ещё раз.';
  feedback.hidden=false;retry.hidden=false;
 }
 retry.onclick=()=>{
  if(disposed||!terminal)return;
  // A canvas with a lost GPU context cannot become a fresh drawing surface.
  // destroy() above restores the original node if fallback replaced it.
  const replacement=canvas.cloneNode(false);canvas.replaceWith(replacement);canvas=replacement;
  terminal=false;retry.hidden=true;status.textContent='Готовим ландшафт заново…';
  document.documentElement.dataset.sceneState='loading';
  void prepare();
 };
 function fit(){
  if(!renderer)return;
  const width=canvas.getBoundingClientRect().width,notice=document.querySelector('.notice').getBoundingClientRect();
  renderer.setViewportInsets({top:width<600?176:112,right:width<600?72:96,bottom:Math.min(notice.height+40,innerHeight*.42),left:24});
 }
 async function prepare(){
  if(renderer||preparing||!available())return;
  preparing=true;const job=new AbortController(),attempt=++generation;controller=job;
  const current=()=>!disposed&&!terminal&&attempt===generation;
  try{
   const preparedModel=await createTerrainModelAsync(grid,{signal:job.signal});
   if(job.signal.aborted||!available()||!current())return;
   renderer=new TerrainRenderer(canvas,grid,{preparedModel,onRender:()=>{
    if(!current())return;
    document.documentElement.dataset.sceneState='ready';status.textContent='';feedback.hidden=true;
    const credit=document.querySelector('.source');
    if(credit&&!creditShown){creditShown=true;creditTimer=setTimeout(()=>{if(credit.contains?.(document.activeElement))return;credit.hidden=true;fit();},8000);}
   },onError:message=>{if(current()){status.textContent=message;feedback.hidden=false;}},onFatal:message=>{if(current())terminalFailure(message);}});
   renderer.setGeometry(route);fit();
   if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(fit);observer.observe(document.querySelector('.notice'));observer.observe(canvas);}
  }catch(error){if(error?.name!=='AbortError'&&available()&&current())terminalFailure('Не удалось подготовить ландшафт. Можно попробовать ещё раз.');}
  finally{
   preparing=false;if(controller===job)controller=null;
   if(job.signal.aborted&&available())void prepare();
  }
 }
 function pause(){controller?.abort();renderer?.setVisible(false);}
 function resume(){if(available()){if(renderer){renderer.setVisible(true);fit();}else void prepare();}}
 for(const[id,action]of[['zoom-in',()=>renderer?.zoomBy(1.2)],['zoom-out',()=>renderer?.zoomBy(1/1.2)],['rotate',()=>renderer?.rotate(.3)],['reset',()=>renderer?.reset()]])document.getElementById(id).onclick=action;
 const info=document.getElementById('info'),about=document.getElementById('about'),close=document.getElementById('close');
 function hide(){info.hidden=true;about.setAttribute('aria-expanded','false');about.focus();}
 about.onclick=()=>{info.hidden=false;about.setAttribute('aria-expanded','true');close.focus();};close.onclick=hide;
 info.onkeydown=event=>{if(event.key==='Escape')hide();if(event.key==='Tab'){event.preventDefault();close.focus();}};
 const visibility=()=>available()?resume():pause();
 const resize=()=>fit();
 const pagehide=event=>{
  active=false;pause();
  if(!event.persisted){disposed=true;if(creditTimer!==null)clearTimeout(creditTimer);observer?.disconnect();renderer?.destroy();renderer=null;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resize);}
 };
 window.addEventListener('pagehide',pagehide);
 window.addEventListener('pageshow',event=>{if(event.persisted&&!disposed){active=true;resume();}});
 document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);
 resume();
}
