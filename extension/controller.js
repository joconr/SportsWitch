/* SportsWitch 4.2.0 detached / Document PiP controller.
 * This file never touches the audio engine, video streams, or classifier. */
'use strict';
const root=document.getElementById('controllerRoot');
const $=id=>root.querySelector('#'+id);
let last=null;
let busy=false,dragged=null;
let previewTab=null,previewBusy=false;
let previewAnchor=null;
let previewHideTimer=null;
let renderedTabIds=new Set();
const reduceMotion=()=>last?.lighterMotion||root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
let lastRowSignature='';
let pipWindow=null;
let refreshBusy=false;
let scheduled=false;
let idleOpacity=35;
const detached = new URLSearchParams(location.search).get('detached') === '1';
if(detached)document.body.classList.add('detached-window');
let backdropTabId=null,backdropLastUpdate=0,backdropBusy=false;
const {Sheet,Pages,showBreakPreview}=globalThis.SportsWitchSheet;
const sheet=new Sheet($('sheetHost'),{onPreview:()=>showBreakPreview(root),onClose:()=>void refresh()});
function invoke(type,extra={}){
  return new Promise((resolve,reject)=>{
    chrome.runtime.sendMessage({type,...extra},response=>{
      if(chrome.runtime.lastError)reject(Error(chrome.runtime.lastError.message));
      else if(!response?.ok)reject(Error(response?.error||'Extension background request failed'));
      else resolve(response.data);
    });
  });
}
function error(message){$('errorBox').hidden=!message;$('errorBox').textContent=message||'';}
function pct(p){return Number.isFinite(p)?Math.round(100*Math.max(0,Math.min(1,p)))+'%':'—';}
function age(time){if(!time)return 'No sample';const elapsed=Math.max(0,Math.round((Date.now()-time)/1000));return elapsed<2?'Just updated':`${elapsed}s ago`;}
function make(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
async function command(type,args={}){
  if(busy)return null;
  busy=true;
  try{const reply=await invoke(type,args);error('');await refresh();return reply;}
  catch(e){error(e.message);return null;}
  finally{busy=false;}
}
const LABELS={Live:'Live',Commercial:'Ad',Uncertain:'Uncertain'};
function render(s){
  last=s;
  root.classList.toggle('sw-light',!!s.lighterMotion);
  if(detached || pipWindow)void refreshAmbientBackdrop(s);
  const connected=(s.mode==='on'||s.mode==='arming');
  const pill=$('statePill');
  const tone=s.chip?.tone||'';
  pill.className='status-pill'+(tone==='on'?' on':tone==='ad'||tone==='warn'?' muted':'');
  pill.textContent=s.chip?.text||'Disabled';
  const silence=s.operatingMode==='silence';
  $('modeSwitch').classList.toggle('active',!silence);$('modeSwitch').setAttribute('aria-pressed',String(!silence));
  $('modeSilence').classList.toggle('active',silence);$('modeSilence').setAttribute('aria-pressed',String(silence));
  $('holdButton').hidden=silence;
  $('holdButton').disabled=!s.enabled;
  $('holdButton').textContent=s.hold?'▶ Release Hold':'⏸ Hold';
  $('holdButton').classList.toggle('holding',!!s.hold);
  const returning=s.settings?.returnToPriority!==false;
  $('returnToggle').hidden=silence;
  $('returnToggle').setAttribute('aria-checked',String(returning));
  $('returnKnob').classList.toggle('on',returning);
  $('returnDetail').textContent=returning?'Goes back to a higher game once it is clearly live.':'Stays on the game it switched to until that game\'s ad, or until you pick another.';
  $('disableButton').disabled=s.mode==='off';
  for(const id of ['markAd','markGame']){
    $(id).classList.toggle('unavailable',!s.enabled);
    $(id).title=s.enabled?'':s.correctionsReason;
  }
  $('statusMessage').textContent=s.message||'Use the toolbar popup to add additional sports tabs.';
  $('lineupTitle').textContent=silence?'Captured games':'Priority lineup · drag to rank';
  $('lineupCount').textContent=(s.gameTabs?.length||0)+'/8';
  const p=s.enabled&&Number.isFinite(s.lastProbability)?s.lastProbability:null;
  $('liveScore').textContent=pct(p);$('adScore').textContent=pct(p===null?null:1-p);
  $('liveMeter').style.width=Number.isFinite(p)?pct(p):'0%';
  $('adMeter').style.width=Number.isFinite(p)?pct(1-p):'0%';
  $('readingAge').textContent=s.settling?'Settling in…':age(s.lastUpdatedAt);
  $('readingLine').textContent=s.readingText;
  $('readingLine').className='reading-line tone-'+(s.readingTone||'dim');
  $('breaksSummary').textContent=s.breaksSummary;
  if(dragged!==null)return;
  const signature=JSON.stringify([s.currentIndex,s.enabled,s.operatingMode,(s.gameTabs||[]).map(t=>[t.id,t.displayTitle,t.manualTitle,s.rows?.[String(t.id)]?.text])]);
  if(signature!==lastRowSignature && !root.querySelector('.inline-rename')){
    lastRowSignature=signature;
    if(previewTab!==null)updateVisibleRowReadings(s,connected);
    else renderRows(s,connected);
  }
}
function fillReading(reading,s,t){
  const r=s.gameReadings?.[String(t.id)],row=s.rows?.[String(t.id)];
  reading.replaceChildren();
  if(!row){reading.textContent=s.enabled?'Analyzing…':'Not monitoring';return;}
  if(s.enabled&&r?.classification&&!r.silent){
    const kind=r.knownAd?'Known ad':r.repeated?'Aired before':LABELS[r.classification];
    reading.append(make('span',r.classification.toLowerCase()==='commercial'?'ad':r.classification.toLowerCase(),kind));
  }
  const text=make('span','tone-'+row.tone,row.text);text.title=row.text;
  reading.append(text);
}
function updateVisibleRowReadings(s,connected){
  // Preserve hover and the clickable preview while probabilities change.
  for(let i=0;i<(s.gameTabs||[]).length;i++){
    const tab=s.gameTabs[i],row=[...$('lineup').querySelectorAll('.line-row')].find(el=>Number(el.dataset.id)===tab.id);
    if(!row)continue;
    row.classList.toggle('selected',connected&&s.currentIndex===i);
    const reading=row.querySelector('.line-reading');
    if(reading)fillReading(reading,s,tab);
  }
}
function renderRows(s,connected){
  // FLIP animations only move visual rows; the priority order is still owned by the worker.
  const oldRects=new Map(Array.from($('lineup').querySelectorAll('.line-row')).map(row=>[Number(row.dataset.id),row.getBoundingClientRect()]));
  const fragment=document.createDocumentFragment();
  const nextIds=new Set((s.gameTabs||[]).map(t=>t.id));
  if(!s.gameTabs?.length){fragment.append(make('div','bottom-note','No games captured. Open a stream and add it from the regular SportsWitch toolbar popup.'));}
  for(let i=0;i<(s.gameTabs||[]).length;i++){
    const t=s.gameTabs[i];
    const row=make('div','line-row'+(connected&&s.currentIndex===i?' selected':'')+(!renderedTabIds.has(t.id)?' is-new':''));row.dataset.id=String(t.id);
    const grip=make('button','grip','⠿');grip.type='button';grip.dataset.id=String(t.id);
    grip.draggable=connected&&s.operatingMode==='switch';grip.disabled=!grip.draggable;
    grip.title='Drag to change priority';grip.setAttribute('aria-label','Reorder '+(t.displayTitle||t.title||'stream'));
    row.append(grip);
    const watch=make('button','line-watch');watch.type='button';watch.disabled=!s.enabled;
    watch.title='Watch '+(t.displayTitle||t.title||'stream');watch.addEventListener('click',()=>void command('SELECT_GAME',{index:i}));
    const number=make('span','priority-no',String(i+1));
    const content=make('span','line-info');
    const meta=make('span','line-meta');meta.append(make('span','',t.site||'Web'),make('span','rank',i===0?'TOP PRIORITY':`PRIORITY ${i+1}`));
    const title=make('span','line-title',t.displayTitle||t.title||'Untitled stream');title.title=title.textContent;
    const reading=make('span','line-reading');
    fillReading(reading,s,t);
    content.append(meta,title,reading);watch.append(number,content);row.append(watch);
    const rename=make('button','rename-btn','✎');rename.type='button';rename.title='Rename stream';
    rename.addEventListener('click',()=>{
      if(row.querySelector('input'))return;
      const edit=make('input','inline-rename');edit.type='text';edit.value=t.manualTitle||t.displayTitle||t.title||'';
      edit.maxLength=110;edit.style.cssText='width:100%;min-width:80px;background:#171126;color:#fff;border:1px solid #b794e1;border-radius:4px;font-size:11px';
      title.replaceWith(edit);edit.focus();edit.select();
      let done=false;
      const save=async(commit)=>{
        if(done)return;done=true;
        const value=edit.value;edit.replaceWith(title);
        if(commit)await command('RENAME_GAME',{tabId:t.id,title:value});
      };
      edit.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void save(true);}if(e.key==='Escape'){e.preventDefault();void save(false);}});
      edit.addEventListener('blur',()=>void save(true));
    });
    row.append(rename);
    const remove=make('button','rename-btn remove-btn','✕');remove.type='button';
    remove.title='Remove from the lineup (the tab keeps playing, muted)';
    remove.addEventListener('click',()=>void command('REMOVE_GAME',{tabId:t.id}));
    row.append(remove);
    row.addEventListener('mouseenter',()=>startPreview(t.id,t.displayTitle||t.title||'Game preview',row));
    row.addEventListener('mouseleave',()=>scheduleStopPreview());
    fragment.append(row);
  }
  $('lineup').replaceChildren(fragment);
  // Animate actual coordinate changes after a drag/reorder, without rebuilding the audio engine.
  if(!reduceMotion()) for(const row of $('lineup').querySelectorAll('.line-row')){
    const previous=oldRects.get(Number(row.dataset.id));
    if(!previous)continue;
    const next=row.getBoundingClientRect();
    const delta=previous.top-next.top;
    if(Math.abs(delta)>2 && Math.abs(delta)<800)row.animate([
      {transform:`translateY(${delta}px)`},{transform:'translateY(0)'}
    ],{duration:260,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  renderedTabIds=nextIds;
}
let previewTimer=null;
async function pullPreview(tabId){
  if(previewBusy||previewTab!==tabId)return;previewBusy=true;
  try{
    const result=await invoke('GET_PREVIEW',{tabId});
    if(previewTab!==tabId)return;
    $('previewImage').hidden=!result?.dataUrl;
    $('previewFallback').hidden=!!result?.dataUrl;
    if(result?.dataUrl){
      if($('previewImage').src!==result.dataUrl)$('previewImage').src=result.dataUrl;
    }else $('previewFallback').textContent=result?.reason||'Protected or unavailable video';
    $('previewAge').textContent=result?.source==='live'?'Live':age(result?.updatedAt);
  }catch(e){
    if(previewTab===tabId){$('previewFallback').hidden=false;$('previewFallback').textContent='Preview unavailable: '+e.message;}
  }
  finally{previewBusy=false;}
}
function startPreview(tabId,title,anchor){
  clearTimeout(previewHideTimer);
  if(dragged!==null||!anchor)return;
  if(previewTab===tabId){previewAnchor=anchor;return;}
  stopPreview(false);
  previewTab=tabId;
  previewAnchor=anchor;
  const panel=$('preview');panel.hidden=false;
  $('previewTitle').textContent=title;
  $('previewAge').textContent='Loading…';
  $('previewImage').hidden=true;
  $('previewFallback').hidden=false;
  $('previewFallback').textContent='Loading preview…';
  $('previewWatch').onclick=()=>{
    const i=last?.gameTabs?.findIndex(t=>t.id===tabId)??-1;
    if(i>=0)void command('SELECT_GAME',{index:i});
  };
  void pullPreview(tabId);
  previewTimer=setInterval(()=>void pullPreview(tabId),1800);
}
function scheduleStopPreview(){
  clearTimeout(previewHideTimer);
  // Enough time to move from the row to the overlaid Watch button.
  previewHideTimer=setTimeout(()=>stopPreview(),250);
}
$('preview').addEventListener('mouseenter',()=>clearTimeout(previewHideTimer));
$('preview').addEventListener('mouseleave',scheduleStopPreview);
$('preview').addEventListener('keydown',e=>{if(e.key==='Escape')stopPreview();});
function stopPreview(refreshRows=true){
  clearTimeout(previewHideTimer);
  clearInterval(previewTimer);previewTimer=null;
  previewTab=null;previewAnchor=null;$('preview').hidden=true;
  if(refreshRows&&last){lastRowSignature='';render(last);}
}
async function refresh(){
  if(refreshBusy)return;
  refreshBusy=true;
  try{
    const s=await invoke('GET_STATUS',{windowId:null,activeTabId:null});
    if(s.buildVersion!=='4.4.1')throw Error('SportsWitch was updated, but Chrome is still running the version before. Open chrome://extensions and click the reload arrow on SportsWitch.');
    render(s);
  }catch(e){error(e.message);}
  finally{refreshBusy=false;}
}
function scheduleRefresh(){
  if(scheduled)return;
  scheduled=true;
  Promise.resolve().then(()=>{scheduled=false;void refresh();});
}
async function reorder(sourceId,targetId){
  const ids=last?.gameTabs?.map(t=>t.id)||[];
  if(!ids.includes(sourceId)||!ids.includes(targetId)||sourceId===targetId)return;
  ids.splice(ids.indexOf(targetId),0,ids.splice(ids.indexOf(sourceId),1)[0]);
  lastRowSignature='';
  await command('REORDER_GAMES',{ids});
}
$('lineup').addEventListener('dragstart',e=>{
  const grip=e.target.closest('.grip');if(!grip||grip.disabled){e.preventDefault();return;}
  dragged=Number(grip.dataset.id);e.dataTransfer.setData('text/plain',String(dragged));e.dataTransfer.effectAllowed='move';
  grip.closest('.line-row')?.classList.add('dragging');stopPreview(false);
});
$('lineup').addEventListener('dragover',e=>{
  const row=e.target.closest('.line-row');if(!row||dragged===null)return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  for(const el of $('lineup').querySelectorAll('.drag-over'))el.classList.remove('drag-over');
  row.classList.add('drag-over');
});
$('lineup').addEventListener('drop',e=>{
  const row=e.target.closest('.line-row');if(!row||dragged===null)return;
  e.preventDefault();const source=dragged;dragged=null;void reorder(source,Number(row.dataset.id));
});
$('lineup').addEventListener('dragend',()=>{dragged=null;lastRowSignature='';if(last)render(last);});
$('modeSwitch').addEventListener('click',()=>void command('SET_OPERATING_MODE',{operatingMode:'switch'}));
$('modeSilence').addEventListener('click',()=>void command('SET_OPERATING_MODE',{operatingMode:'silence'}));
$('holdButton').addEventListener('click',()=>void command('TOGGLE_HOLD'));
$('returnToggle').addEventListener('click',()=>void command('SAVE_SETTINGS',{settings:{returnToPriority:last?.settings?.returnToPriority===false}}));
$('disableButton').addEventListener('click',()=>void command('DISABLE'));
for(const [id,type] of [['markAd','MARK_AD'],['markGame','MARK_LIVE']]){
  $(id).addEventListener('click',()=>{
    if(!last?.enabled){error(last?.correctionsReason||'Add your games first.');return;}
    void command(type);
  });
}
$('controllerHelpButton').addEventListener('click',()=>{stopPreview(false);void Pages.setup(sheet);});
document.getElementById('launcherHelpButton').addEventListener('click',async()=>{
  try{await chrome.tabs.create({url:chrome.runtime.getURL('help.html')});}
  catch(e){error('Cannot open help: '+e.message);}
});
$('settingsButton').addEventListener('click',()=>{stopPreview(false);void Pages.settings(sheet);});
$('customizeBreaks').addEventListener('click',()=>{stopPreview(false);void Pages.adBreaks(sheet);});
$('previewBreak').addEventListener('click',()=>{stopPreview(false);showBreakPreview(root);});

// Show the most recent permitted captured frame behind semi-transparent cards.
// This is a visual approximation, NOT OS-level window transparency. It does
// not start additional captures or read any video content outside SportsWitch.
async function refreshAmbientBackdrop(state){
  const tabId=state?.gameTabs?.[state.currentIndex]?.id;
  if(!tabId||backdropBusy)return;
  const now=Date.now();
  if(tabId===backdropTabId && now-backdropLastUpdate<8500)return;
  backdropBusy=true; backdropLastUpdate=now; backdropTabId=tabId;
  try{
    const preview=await invoke('GET_PREVIEW',{tabId});
    if(state!==last && last?.gameTabs?.[last.currentIndex]?.id!==tabId)return;
    const dataUrl=preview?.dataUrl;
    if(typeof dataUrl==='string' && /^data:image\/(?:jpeg|png|webp);base64,/i.test(dataUrl)){
      root.style.setProperty('--ambient-image',`url("${dataUrl}")`);
      root.classList.add('has-ambient');
    }else{
      root.style.removeProperty('--ambient-image');
      root.classList.remove('has-ambient');
    }
  }catch{
    root.style.removeProperty('--ambient-image');
    root.classList.remove('has-ambient');
  }finally{backdropBusy=false;}
}
async function setOpacity(value){
  idleOpacity=Math.max(20,Math.min(100,Number(value)||35));
  root.style.setProperty('--idle-opacity',`${idleOpacity/100}`);
  $('fadeValue').textContent=idleOpacity+'%';$('fadeRange').value=String(idleOpacity);
  try{await chrome.storage.local.set({sportsWitchControllerIdleOpacity:idleOpacity});}catch{}
}
$('fadeRange').addEventListener('input',()=>void setOpacity($('fadeRange').value));

const floatButton=document.getElementById('floatButton');
floatButton.addEventListener('click',()=>{
  if(!window.documentPictureInPicture?.requestWindow){
    document.getElementById('floatMessage').textContent='Document Picture-in-Picture is unavailable. You can still use this detached controller window.';
    return;
  }
  // MUST be invoked directly inside this click handler to preserve user activation.
  const request=window.documentPictureInPicture.requestWindow({width:470,height:720,disallowReturnToOpener:true});
  floatButton.disabled=true;
  request.then(pip=>{
    pipWindow=pip;
    for(const file of ['controller.css','sheet.css']){
      const sheetLink=pip.document.createElement('link');sheetLink.rel='stylesheet';sheetLink.href=chrome.runtime.getURL(file);
      pip.document.head.append(sheetLink);
    }
    pip.document.title='SportsWitch · Floating Controller';
    pip.document.body.classList.add('floating');
    pip.document.body.append(root);
    stopPreview(false);
    document.getElementById('showController').hidden=false;
    document.getElementById('floatMessage').textContent='Always-on-top controller active. Keep this launcher window open; return to the game anytime.';
    pip.addEventListener('pagehide',()=>{
      pipWindow=null;
      stopPreview(false);
      document.body.append(root);
      document.getElementById('showController').hidden=true;
      floatButton.disabled=false;
      document.getElementById('floatMessage').textContent='Always-on-top closed. Your detached controller is still available.';
      void refresh();
    },{once:true});
    root.style.setProperty('--idle-opacity',`${idleOpacity/100}`);
  }).catch(e=>{
    floatButton.disabled=false;
    document.getElementById('floatMessage').textContent='Could not enable always-on-top: '+e.message+' — the detached controller remains usable.';
  });
});
document.getElementById('showController').addEventListener('click',()=>pipWindow?.close());

// State changes are emitted by the background via storage.session. This event
// also keeps the controller current when the launcher TAB is backgrounded and
// its timers are throttled. No second audio capture is ever created.
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session'&&changes.sportsSwitcherState&&!sheet.isOpen)scheduleRefresh();
});
(async()=>{
  try{
    const prefs=await chrome.storage.local.get('sportsWitchControllerIdleOpacity');
    const value=Number(prefs.sportsWitchControllerIdleOpacity);
    await setOpacity(Number.isFinite(value)&&value>=20&&value<=100?value:35);
  }catch{}
  await refresh();
  setInterval(()=>{if(!sheet.isOpen)void refresh();},2500);
})();
