/* SportsWitch 4.0.0 — minimal, tab-scoped fullscreen controller.
 * Uses CDP to try a visible player fullscreen control, then the native
 * Fullscreen API on the VIDEO if that control is inaccessible.
 * Absolutely no CSS/style/window-size changes; no audio processing touched.
 * Attach to the selected supported web tab only and detach in finally.
 */
'use strict';
const SportsWitchNativeFullscreen = (() => {
  const SUPPORTED_WEB = /^https?:\/\//i;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function evaluate(target, expression, userGesture=false, awaitPromise=false) {
    const result=await chrome.debugger.sendCommand(target,'Runtime.evaluate',{
      expression, userGesture, awaitPromise, returnByValue:true, silent:true
    });
    if(result.exceptionDetails){
      const details=result.exceptionDetails.exception?.description||
        result.exceptionDetails.text||'Fullscreen script error';
      throw new Error(details);
    }
    return result.result?.value;
  }
  async function stillEligible(tabId, shouldContinue) {
    if(!shouldContinue())return false;
    const tab=await chrome.tabs.get(tabId);
    if(!tab.active||!SUPPORTED_WEB.test(tab.url||''))return false;
    const state=await chrome.storage.local.get('sportsWitchSettings');
    return Boolean(state.sportsWitchSettings?.autoFullscreenOnSwitch);
  }

  // No page state changes. Streaming sites may move fullscreen controls between
  // elements / shadow DOM when the playback UI changes.
  const findFullscreenControl=`(() => {
    const visible=el=>{
      if(!el||typeof el.getBoundingClientRect!=='function')return false;
      const r=el.getBoundingClientRect();
      const css=getComputedStyle(el);
      return r.width>8&&r.height>8&&r.left>=0&&r.top>=0&&
        r.right<=innerWidth+2&&r.bottom<=innerHeight+2&&
        css.display!=='none'&&css.visibility!=='hidden'&&css.opacity!=='0';
    };
    const candidates=[];
    const visit=(root,depth)=>{
      if(!root||depth>4)return;
      for(const el of root.querySelectorAll('button,[role="button"],[aria-label],[title]')){
        const label=[el.getAttribute('aria-label'),el.getAttribute('title'),
          el.getAttribute('data-tooltip'),el.getAttribute('data-title')]
          .filter(Boolean).join(' ');
        if(/(?:full[\\s-]?screen)/i.test(label)&& !/(?:exit|leave)/i.test(label)
          && !el.disabled && visible(el)){
          const r=el.getBoundingClientRect();
          candidates.push({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
            label:label.slice(0,100)});
        }
        if(el.shadowRoot)visit(el.shadowRoot,depth+1);
      }
    };
    visit(document,0);
    return candidates.length ? candidates[0] : null;
  })()`;

  // Video-only native fullscreen never applies a layout override. If the
  // platform's own control is inaccessible, the Fullscreen API is the only
  // fallback; if rejected, we leave the normal player completely alone.
  const requestVideoFullscreen=`(async () => {
    const videos=[...document.querySelectorAll('video')];
    const best=videos.map(video=>{
      const r=video.getBoundingClientRect();
      const visible=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left)) *
        Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
      return {video,score:visible+(video.paused?0:30000)};
    }).filter(x=>x.video.videoWidth>0&&x.video.videoHeight>0&&x.score>20000)
      .sort((a,b)=>b.score-a.score)[0]?.video;
    if(!best)return {ok:false,reason:'No eligible playing video in page'};
    if(document.fullscreenElement)return {ok:true,method:'already-fullscreen'};
    try{
      await best.requestFullscreen({navigationUI:'hide'});
      return {ok:Boolean(document.fullscreenElement),method:'native-video'};
    }catch(err){
      return {ok:false,reason:String(err?.message||err).slice(0,180)};
    }
  })()`;

  async function attempt(tabId,shouldContinue=()=>true){
    // Sanity-check before using the broad debugger permission.
    if(!Number.isInteger(tabId)||!await stillEligible(tabId,shouldContinue))
      return {ok:false,reason:'Fullscreen unavailable or selected web tab not active'};
    if(!(await chrome.permissions.contains({permissions:['debugger']})))
      return {ok:false,reason:'Debugger permission unavailable'};
    const target={tabId};
    let attached=false;
    try{
      await chrome.debugger.attach(target,'1.3');
      attached=true;
      if(!await stillEligible(tabId,shouldContinue))
        return {ok:false,reason:'Selected game changed before fullscreen attempt'};
      if(await evaluate(target,'Boolean(document.fullscreenElement)'))
        return {ok:true,method:'already-fullscreen'};

      // Reveal the playback controls without clicking on any video.
      const viewport=await evaluate(target,'({w:innerWidth,h:innerHeight})');
      if(viewport?.w>120&&viewport?.h>100){
        await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{
          type:'mouseMoved',x:Math.max(30,viewport.w-40),y:Math.max(30,viewport.h-48),
          button:'none',buttons:0
        });
        await wait(170);
      }
      if(!await stillEligible(tabId,shouldContinue))
        return {ok:false,reason:'Selection changed while checking controls'};
      const control=await evaluate(target,findFullscreenControl);
      if(control && await stillEligible(tabId,shouldContinue)){
        // Genuine DevTools input events, not a JS HTMLElement.click() call.
        // Input coordinates come from the visible full-screen control.
        await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{
          type:'mouseMoved',x:control.x,y:control.y,button:'none',buttons:0
        });
        await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{
          type:'mousePressed',x:control.x,y:control.y,
          button:'left',buttons:1,clickCount:1
        });
        try{
          await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{
            type:'mouseReleased',x:control.x,y:control.y,
            button:'left',buttons:0,clickCount:1
          });
        }catch(err){console.warn('[SportsWitch] Mouse release:',err.message);}
        await wait(260);
        if(await evaluate(target,'Boolean(document.fullscreenElement)'))
          return {ok:true,method:'site-player-control'};
      }
      if(!await stillEligible(tabId,shouldContinue))
        return {ok:false,reason:'Game changed before native video fallback'};
      const native=await evaluate(target,requestVideoFullscreen,true,true);
      return native?.ok?native:{ok:false,reason:native?.reason||'Native fullscreen rejected'};
    }catch(err){
      return {ok:false,reason:String(err?.message||err)};
    }finally{
      if(attached){
        try{await chrome.debugger.detach(target);}catch(err){
          console.info('[SportsWitch] Debugger already detached:',err.message);
        }
      }
    }
  }
  return {attempt};
})();
