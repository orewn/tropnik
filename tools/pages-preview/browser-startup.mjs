import {spawn as spawnProcess} from 'node:child_process';

export const BROWSER_STARTUP_LIMITS=Object.freeze({readyMs:30000,probeMs:1000,pollMs:100,stderrBytes:32*1024,termMs:1500,killMs:1000});
const errorText=error=>(error?.stack||String(error)).slice(0,4096);
export function browserErrorDetails(error,depth=0){
 const result={name:String(error?.name||'Error').slice(0,128),message:String(error?.message??error).slice(0,4096),stack:errorText(error)};
 for(const key of ['code','errno','syscall','address','port','timeoutMs'])if(['string','number'].includes(typeof error?.[key]))result[key]=typeof error[key]==='string'?error[key].slice(0,1024):error[key];
 if(error?.cause!==undefined&&depth<3)result.cause=browserErrorDetails(error.cause,depth+1);
 return result;
}

/** One owned browser process: readiness retries never relaunch it or retry a profile.
 * POSIX detached children have their own process group, allowing cleanup to include
 * Chromium descendants after the parent exits. Only that positive spawn PID is used. */
export function launchBrowser(binary,args,{
 limits=BROWSER_STARTUP_LIMITS,spawn=spawnProcess,fetch=globalThis.fetch,
 clock=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,
 platform=process.platform,signalProcess=(pid,signal)=>process.kill(pid,signal),
}={}){
 const started=clock(),detached=platform!=='win32';
 const receipt={schemaVersion:1,binary,pid:null,detached,startedAtEpochMs:Date.now(),limits:{...limits},status:'starting',probes:0,exitCode:null,signalCode:null,spawnError:null,startupError:null,lastProbeError:null};
 let child,terminal,resolveTerminal,stderr=Buffer.alloc(0),stderrTotal=0,readyPromise,cleanupPromise,exited=false,lastProbeError;
 const terminated=new Promise(resolve=>{resolveTerminal=resolve;});
 const onError=error=>{
  receipt.spawnError=errorText(error);receipt.spawnErrorDetails=browserErrorDetails(error);
  terminal??=new Error(`Chromium process error: ${error.message||error}`,{cause:error});resolveTerminal(terminal);
 };
 const onExit=(code,signal)=>{
  exited=true;receipt.exitCode=code;receipt.signalCode=signal;
  terminal??=new Error(`Chromium exited before the operation completed (code ${code}, signal ${signal})`);resolveTerminal(terminal);
 };
 const onStderr=chunk=>{
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);stderrTotal+=bytes.length;
  if(bytes.length>=limits.stderrBytes)stderr=Buffer.from(bytes.subarray(bytes.length-limits.stderrBytes));
  else{const keep=Math.max(0,limits.stderrBytes-bytes.length);stderr=Buffer.concat([stderr.subarray(Math.max(0,stderr.length-keep)),bytes]);}
 };
 try{
  child=spawn(binary,args,{stdio:['ignore','ignore','pipe'],detached});receipt.pid=child.pid??null;
  child.on('error',onError);child.on('exit',onExit);child.stderr?.on('data',onStderr);
 }catch(error){onError(error);}
 function ensureAlive(){
  if(!terminal&&child&&(child.exitCode!==null||child.signalCode!==null))onExit(child.exitCode,child.signalCode);
  if(terminal)throw terminal;
 }
 async function pause(ms,watchProcess=false){
  let timer;
  try{
   const elapsed=new Promise(resolve=>{timer=schedule(resolve,ms);});
   if(watchProcess)await Promise.race([elapsed,terminated.then(error=>{throw error;})]);else await elapsed;
  }finally{if(timer!==undefined)cancel(timer);}
 }
 async function requestJSON(url,options={},timeout=limits.probeMs){
  ensureAlive();
  const controller=new AbortController();let timer;
  try{
   const request=Promise.resolve().then(()=>fetch(url,{...options,cache:'no-store',signal:controller.signal})).then(async response=>{
    if(!response.ok)throw new Error(`Chromium endpoint returned HTTP ${response.status}`);
    return response.json();
   });
   return await Promise.race([request,terminated.then(error=>{throw error;}),new Promise((_,reject)=>{
    timer=schedule(()=>{controller.abort();reject(Object.assign(new Error(`Chromium endpoint probe exceeded ${timeout} ms`),{code:'BROWSER_PROBE_TIMEOUT',timeoutMs:timeout}));},timeout);
   })]);
  }finally{if(timer!==undefined)cancel(timer);controller.abort();}
 }
 function waitUntilReady(url){
  readyPromise??=(async()=>{
   const deadline=started+limits.readyMs;
   try{
    while(clock()<deadline){
     ensureAlive();receipt.probes++;
     try{
      const version=await requestJSON(url,{},Math.min(limits.probeMs,deadline-clock()));
      if(typeof version.webSocketDebuggerUrl!=='string'||!version.webSocketDebuggerUrl.startsWith('ws://'))throw new Error('Chromium version endpoint lacks its CDP WebSocket URL');
      ensureAlive();if(clock()>=deadline)throw new Error('Chromium health response arrived after the readiness deadline');
      receipt.status='ready';receipt.readyAfterMs=clock()-started;
      receipt.version={browser:version.Browser??null,protocol:version['Protocol-Version']??null};return version;
     }catch(error){ensureAlive();lastProbeError=error;receipt.lastProbeError=errorText(error);receipt.lastProbeFailure=browserErrorDetails(error);}
     const left=deadline-clock();if(left>0)await pause(Math.min(limits.pollMs,left),true);
    }
    throw Object.assign(new Error(`Chromium readiness deadline exceeded ${limits.readyMs} ms`,{cause:lastProbeError}),{code:'BROWSER_STARTUP_TIMEOUT',timeoutMs:limits.readyMs});
   }catch(error){receipt.status='failed';receipt.startupError=errorText(error);receipt.startupFailure=browserErrorDetails(error);throw error;}
  })();
  return readyPromise;
 }
 function diagnostics(){
  return{...receipt,elapsedMs:clock()-started,exitCode:receipt.exitCode??child?.exitCode??null,signalCode:receipt.signalCode??child?.signalCode??null,
   stderrTail:stderr.toString('utf8'),stderrBytesCaptured:stderr.length,stderrBytesTotal:stderrTotal,stderrTruncated:stderrTotal>stderr.length};
 }
 function close(){
  cleanupPromise??=(async()=>{
   const cleanup={status:'stopping',signals:[],errors:[],elapsedMs:0},begin=clock();receipt.cleanup=cleanup;
   const addError=error=>{const text=errorText(error);if(cleanup.errors.length<8&&!cleanup.errors.includes(text))cleanup.errors.push(text);};
   const hasPid=Number.isInteger(receipt.pid)&&receipt.pid>0;
   function running(){
    if(!child||!hasPid)return false;
    if(!detached)return!exited&&child.exitCode===null&&child.signalCode===null;
    try{signalProcess(-receipt.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;addError(error);return true;}
   }
   function signal(value){
    cleanup.signals.push(value);
    try{if(detached)signalProcess(-receipt.pid,value);else child.kill(value);}catch(error){if(error.code!=='ESRCH')addError(error);}
   }
   async function waitStopped(duration){
    const deadline=clock()+duration;
    while(running()){const left=deadline-clock();if(left<=0)return false;await pause(Math.min(50,left));}
    return true;
   }
   try{
    if(running()){
     signal('SIGTERM');
     if(!await waitStopped(limits.termMs)){signal('SIGKILL');await waitStopped(limits.killMs);}
    }
    cleanup.status=running()?'timed-out':hasPid?'stopped':'not-started';
   }catch(error){addError(error);cleanup.status='error';}
   finally{
    cleanup.elapsedMs=clock()-begin;
    child?.stderr?.off('data',onStderr);child?.stderr?.destroy();child?.unref();
   }
   return cleanup;
  })();
  return cleanupPromise;
 }
 return{waitUntilReady,requestJSON,diagnostics,close};
}
