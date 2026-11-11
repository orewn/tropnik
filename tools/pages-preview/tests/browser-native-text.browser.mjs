import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchBrowser,BROWSER_STARTUP_LIMITS} from '../browser-startup.mjs';
import {sendNativeText} from '../browser-native-text.mjs';

const binary=['google-chrome','google-chrome-stable','chromium','chromium-browser'].find(name=>spawnSync('which',[name],{stdio:'ignore'}).status===0);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// This is a small browser behavior fixture, not a product performance run. It
// proves that keyboard default actions, trusted events and recent-input CLS
// attribution come from Chromium rather than a mocked JS event dispatcher.
test('native keyboard typing supplies trusted key pairs, honors cancellation and refreshes recent-input CLS',{
 timeout:15000,
},async t=>{
 assert.ok(binary,'A Chromium binary is required for the native text browser gate');
 const directory=await mkdtemp(join(tmpdir(),'tropnik-native-text-'));
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const browser=launchBrowser(binary,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--disable-extensions','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${directory}`,'about:blank'],{limits:{...BROWSER_STARTUP_LIMITS,readyMs:8000}});
 let socket;
 t.after(async()=>{socket?.close();await browser.close();await rm(directory,{recursive:true,force:true});});
 await browser.waitUntilReady(`http://127.0.0.1:${port}/json/version`);
 const target=await browser.requestJSON(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'});
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let next=0;const pending=new Map();
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data),waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);});
 const cdp={call:(method,params={})=>new Promise((resolve,reject)=>{
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native text test CDP timeout: '+method));},5000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id,method,params}));
 })};
 const evaluate=async expression=>{const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(result.exceptionDetails,undefined);return result.result.value;};
 const html=`<!doctype html><style>body{margin:20px}input{width:300px;height:40px}#result{width:200px;height:100px;background:#456;margin-top:20px}</style><input id="query"><div id="result"></div><script>
  window.events=[];window.shifts=[];window.blockKey='';
  for(const type of ['keydown','keyup','beforeinput','input'])document.addEventListener(type,event=>events.push({type,trusted:event.isTrusted,key:event.key??null,value:query.value}));
  query.addEventListener('keydown',event=>{if(event.key===blockKey)event.preventDefault();});
  query.addEventListener('input',()=>{result.style.marginTop=query.value.length%2?'120px':'20px';});
  new PerformanceObserver(list=>shifts.push(...list.getEntries().map(entry=>({value:entry.value,hadRecentInput:entry.hadRecentInput})))).observe({type:'layout-shift'});
 </script>`;
 await cdp.call('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(html)});
 for(let attempt=0;attempt<40;attempt++){if(await evaluate("!!document.querySelector('#query')"))break;await sleep(25);}
 await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:60,y:40,button:'left',clickCount:1});
 await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:60,y:40,button:'left',clickCount:1});
 assert.equal(await evaluate("document.activeElement.id"),'query');
 await sleep(650);await evaluate('events=[];shifts=[];true');
 // The old IME-style insertion really lacks a qualifying keyboard interaction.
 await cdp.call('Input.insertText',{text:'x'});await sleep(100);
 const old=await evaluate('({events,shifts,value:query.value})');assert.equal(old.value,'x');assert.equal(old.events.some(event=>event.type==='keydown'),false);
 assert.ok(old.shifts.some(shift=>shift.value>0&&!shift.hadRecentInput),'The fixture must reproduce the original insertion/CLS mismatch');
 await evaluate('events=[];shifts=[];true');
 const text='Байкал 15 км';await sendNativeText(cdp,text);await sleep(100);
 const typed=await evaluate('({events,shifts,value:query.value})');assert.equal(typed.value,'x'+text);assert.ok(typed.events.every(event=>event.trusted));
 for(const type of ['keydown','keyup','input'])assert.equal(typed.events.filter(event=>event.type===type).length,[...text].length,type);
 assert.equal(typed.events.filter(event=>event.type==='keydown').map(event=>event.key).join(''),text);
 assert.equal(typed.events.filter(event=>event.type==='keyup').map(event=>event.key).join(''),text);
 assert.ok(typed.shifts.length>0);assert.ok(typed.shifts.every(shift=>shift.hadRecentInput),'Actual keyboard input must refresh Chromium recent-input attribution');
 await evaluate("events=[];blockKey='Ж';true");await sendNativeText(cdp,'Ж');
 const cancelled=await evaluate('({events,value:query.value})');assert.equal(cancelled.value,'x'+text);
 assert.deepEqual(cancelled.events.map(event=>event.type),['keydown','keyup']);assert.ok(cancelled.events.every(event=>event.trusted));
});
