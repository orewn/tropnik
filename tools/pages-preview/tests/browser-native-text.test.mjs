import test from 'node:test';
import assert from 'node:assert/strict';
import {sendNativeText} from '../browser-native-text.mjs';

test('native text sends one Unicode key pair per character with the existing cadence',async()=>{
 const commands=[],waits=[],text='Байкал 15 км ⛰';
 await sendNativeText({call:async(method,params)=>{commands.push({method,...params});}},text,{sleep:async ms=>waits.push(ms)});
 assert.equal(commands.length,[...text].length*2);assert.deepEqual(waits,[...text].map(()=>45));
 assert.equal(commands.filter(command=>command.type==='keyDown').map(command=>command.text).join(''),text);
 for(let index=0;index<commands.length;index+=2){
  const down=commands[index],up=commands[index+1];assert.equal(down.method,'Input.dispatchKeyEvent');assert.equal(up.method,down.method);
  assert.equal(down.type,'keyDown');assert.equal(up.type,'keyUp');assert.equal(down.key,up.key);assert.equal(down.text,down.unmodifiedText);assert.equal('text' in up,false);
 }
});

test('a failed native key ACK releases that key once, stops typing and retains its original failure',async()=>{
 const commands=[],failure=new Error('Key ACK lost');
 const cdp={call:async(method,params)=>{commands.push(params);if(params.type==='keyDown')throw failure;throw new Error('Release also failed');}};
 await assert.rejects(sendNativeText(cdp,'Байкал',{sleep:()=>assert.fail('Do not continue after a failed key')}),error=>error===failure);
 assert.deepEqual(commands.map(command=>[command.type,command.key]),[['keyDown','Б'],['keyUp','Б']]);assert.equal(failure.keyReleaseError,'Release also failed');
});

test('a failed key release cannot be accepted as completed typing and input controls are rejected',async()=>{
 const failure=new Error('Key release failed');let calls=0;
 await assert.rejects(sendNativeText({call:async()=>{if(++calls===2)throw failure;}},'ab',{sleep:()=>assert.fail('Do not type the next key')}),error=>error===failure);
 assert.equal(calls,2);
 for(const text of ['a\nb','a\tb','\u0000'])await assert.rejects(sendNativeText({call:()=>assert.fail('Invalid text must not dispatch input')},text));
});
