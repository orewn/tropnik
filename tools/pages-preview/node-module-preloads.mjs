import assert from 'node:assert/strict';

/** Execute an emitted browser module's numeric work in Node. Vite registers
 * optional modulepreload links before its real dynamic import. These inert
 * hints are the only DOM operation accepted here; source requests still use
 * the caller's real file/HTTP transport and no response is substituted. */
export async function withNodeModulePreloads(base,run){
  assert.equal(globalThis.document,undefined,'Module-preload verification is Node-only');
  assert.equal(globalThis.window,undefined,'Module-preload verification is Node-only');
  const links=[];
  globalThis.document={
    getElementsByTagName(tag){assert.equal(tag,'link');return links;},
    querySelector(selector){assert.equal(selector,'meta[property=csp-nonce]');return null;},
    createElement(tag){assert.equal(tag,'link');return{};},
    head:{appendChild(link){
      assert.equal(link.rel,'modulepreload');assert.equal(link.as,'script');
      const url=new URL(link.href);assert.equal(url.protocol,'file:');assert.ok(url.pathname.startsWith(base+'assets/')&&url.pathname.endsWith('.js'),'Only emitted JavaScript preload hints are allowed');
      links.push(link);return link;
    }},
  };
  globalThis.window={dispatchEvent(event){return !event.defaultPrevented;}};
  try{return await run();}finally{delete globalThis.document;delete globalThis.window;}
}
