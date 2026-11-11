import assert from 'node:assert/strict';

/** Type printable Unicode through Chromium's native keyboard path. insertText
 * represents IME/emoji insertion, not a key press; it does not deliver keydown
 * or refresh the browser's keyboard recent-input boundary for layout shifts.
 * https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Input.pdl
 * Text belongs on keyDown only, so a character is inserted once. Do not invent
 * a physical key code for a character from an unspecified keyboard layout. */
export async function sendNativeText(cdp,text,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),delayMs=45}={}){
 assert.equal(typeof text,'string');assert.ok(!/[\u0000-\u001f\u007f]/u.test(text),'Native text must contain printable characters');
 assert.ok(Number.isFinite(delayMs)&&delayMs>=0);
 for(const character of text){
  let originalFailure;
  try{await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:character,text:character,unmodifiedText:character});}
  catch(error){originalFailure=error;throw error;}
  finally{
   // A rejected ACK may follow delivered input. Release the same key without
   // retrying its text and preserve the original failure if cleanup also fails.
   try{await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:character});}
   catch(error){if(originalFailure)originalFailure.keyReleaseError=String(error?.message||error);else throw error;}
  }
  await sleep(delayMs);
 }
}
