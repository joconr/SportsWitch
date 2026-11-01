'use strict';
const $=id=>document.getElementById(id);
const enableButton=$('enable'),disableButton=$('disable'),pill=$('statusPill');
const detail=$('details'),games=$('games'),errorBox=$('error');
const holdButton=$('holdButton'),switchMode=$('switchMode'),silenceMode=$('silenceMode'),returnToggle=$('returnToggle');
const markAdButton=$('markAd'),markGameButton=$('markGame');
let busy=false;
let lastStatus=null;
let currentWindowId=null;
let notice='';
let hoverTabId=null;
let hoverRequest=0;
let hoverTimer=null;
let hoverHideTimer=null;
let hoverBusy=false;
let previewTitle='';
let draggingTabId=null;
let reorderBusy=false;
let welcomed=false;
const POPUP_BUILD_VERSION='4.4.1';
let workerMatchesPopup=true;
const {Sheet,Pages,showBreakPreview}=globalThis.SportsWitchSheet;
const sheet=new Sheet($('sheetHost'),{onPreview:()=>showBreakPreview(document.body),onClose:()=>void status()});

async function contextTab(){
  const tabs=await chrome.tabs.query({active:true,currentWindow:true});
  return tabs[0]||null;
}
function invoke(type,extra={}){
  return new Promise((resolve,reject)=>{
    chrome.runtime.sendMessage({type,...extra},response=>{
      if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));
      else if(!response?.ok)reject(new Error(response?.error||'Unknown extension error'));
      else resolve(response.data);
    });
  });
}
function updateError(message){errorBox.hidden=!message;errorBox.textContent=message||'';}
function formatPct(value){return `${Math.round(value*100)}%`;}
function relativeTime(timestamp){
  if(!timestamp)return 'No sample yet';
  const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));
  return seconds<2?'Just updated':`${seconds}s ago`;
}
const LABELS={Live:'Live',Commercial:'Ad',Uncertain:'Uncertain'};
function paintStatus(s){
  lastStatus=s;
  document.body.classList.toggle('sw-light',!!s.lighterMotion);
  workerMatchesPopup=s.buildVersion===POPUP_BUILD_VERSION;
  if(!workerMatchesPopup){
    updateError('SportsWitch '+POPUP_BUILD_VERSION+' is installed, but Chrome is still running '+(s.buildVersion||'an older version')+
      '. Open chrome://extensions and click the reload arrow on SportsWitch.');
  }
  // A newer version for a folder copy, or what's new right after an update.
  const update=s.update||{};
  $('updateBadge').hidden=!update.available&&!update.updatedFrom;
  $('updateBadge').textContent=update.available?`SportsWitch ${update.available} is out ›`:update.updatedFrom?`Updated to ${POPUP_BUILD_VERSION} · what's new ›`:'';
  $('brandLine').hidden=!$('updateBadge').hidden;
  const activeAlreadyAdded=s.gameTabs.some(t=>t.id===s.activeGameTabId);
  const canAdd=Boolean(s.canAdd);
  const isSilence=s.operatingMode==='silence';
  switchMode.classList.toggle('selected',!isSilence);
  silenceMode.classList.toggle('selected',isSilence);
  switchMode.setAttribute('aria-pressed',String(!isSilence));
  silenceMode.setAttribute('aria-pressed',String(isSilence));
  switchMode.disabled=busy;silenceMode.disabled=busy;
  $('panelHeading').textContent=isSilence?'AD SILENCING':'AUTO SWITCHING';
  $('modeDescription').textContent=isSilence
    ?'Watch one game. Automatically mute commercials and restore audio when play is live.'
    :'Switch across websites; higher rows get first choice when they are confidently live.';
  holdButton.hidden=isSilence||!s.enabled;
  holdButton.disabled=busy;
  holdButton.classList.toggle('holding',Boolean(s.hold));
  holdButton.setAttribute('aria-pressed',String(Boolean(s.hold)));
  holdButton.textContent=s.hold?'▶ Release Hold':'⏸ Hold Switching';
  const returning=s.settings?.returnToPriority!==false;
  returnToggle.hidden=isSilence;
  returnToggle.disabled=busy;
  returnToggle.setAttribute('aria-checked',String(returning));
  $('returnKnob').classList.toggle('on',returning);
  $('returnDetail').textContent=returning?'Goes back to a higher game once it is clearly live.':'Stays on the game it switched to until that game\'s ad, or until you pick another.';
  // Corrections stay in place; before a session they say why they can't act yet.
  for(const button of [markAdButton,markGameButton]){
    button.classList.toggle('unavailable',!s.enabled);
    button.title=s.enabled?(button===markAdButton?'Mute this now and remember it as an ad':'Bring the sound back and learn this is the game'):s.correctionsReason;
  }
  $('modeStatus').hidden=!s.enabled||(!isSilence&&!s.silenced);
  $('modeStatus').textContent=isSilence
    ?s.silenced?(s.radioCoversAd?'🎵 Commercial detected · ad turned down under your radio':'🔇 Commercial detected · audio muted; listening for live sports'):'🔊 Game audio on · analyzing for ads'
    :s.silenced?'🔇 All other games are on ads · current game muted; still scanning for live action':'';
  $('mainNote').textContent=isSilence
    ?'Silence mode captures one game and mutes its speaker audio during confirmed ads. Switch back to Switch mode to add more games. If you already added multiple games, choose which one to watch manually.'
    :'Switch mode: add 2–8 web video tabs, then drag the grip to rank priority. '+(returning
      ?'The highest live game wins once it is clearly back.'
      :'On an ad it moves to the highest live game, and stays there until that game\'s ad.')+' Hover any row to preview and watch it. Hold and fallback mute still work.';
  const tone=s.chip?.tone||'';
  pill.className='pill'+(tone==='on'?' on':tone==='warn'||tone==='ad'?' warn':tone==='err'?' err':'');
  pill.textContent=s.chip?.text||'Disabled';
  enableButton.textContent=activeAlreadyAdded?'Tab Added':s.gameTabs.length>=8?'8 Tabs Max':isSilence&&s.gameTabs.length?'One Tab in Silence Mode':'Add This Tab';
  enableButton.disabled=busy||!canAdd;
  enableButton.title=canAdd
    ?`Add the current ${s.candidateSite||'web'} stream. Each tab needs its own click.`
    :(s.canAddReason||'This tab cannot be added right now.');
  disableButton.disabled=busy||s.mode==='off';
  if(!busy)detail.textContent=(!canAdd&&s.canAddReason&&!s.enabled)
    ?s.canAddReason
    :(s.message||'Open a stream on any website and click Add This Tab.');
  if(notice){updateError(notice);notice='';}

  const list=(s.mode==='on'||s.mode==='arming')?s.gameTabs:(s.availableGames||[]);
  const current=Math.min(Math.max(s.currentIndex||0,0),Math.max(list.length-1,0));
  const hasResult=s.enabled&&Number.isFinite(s.lastProbability);
  const live=hasResult?Math.max(0,Math.min(1,s.lastProbability)):null;
  const commercial=live===null?null:1-live;
  $('probTitle').textContent=`Game ${list.length?current+1:'—'} · Ad-break probability`;
  $('updated').textContent=hasResult?relativeTime(s.lastUpdatedAt):s.enabled?(s.settling?'Settling in…':'Collecting audio…'):'No active reading';
  $('livePct').textContent=live===null?'—':formatPct(live);
  $('commercialPct').textContent=commercial===null?'—':formatPct(commercial);
  $('liveBar').style.width=`${live===null?0:live*100}%`;
  $('commercialBar').style.width=`${commercial===null?0:commercial*100}%`;
  const readingLine=$('readingLine');
  readingLine.textContent=s.readingText;
  readingLine.className='reading-line tone-'+(s.readingTone||'dim');
  const thresholds=s.settings||{muteCertainty:90,releaseCertainty:50};
  $('confirm').textContent=`Acts at ${thresholds.muteCertainty}% sure · back below ${thresholds.releaseCertainty}%`;
  $('analysis').textContent=thresholds.learnAds?'Learning on this computer':'Learning off';
  $('breaksSummary').textContent=s.breaksSummary;
  $('gameHeading').textContent=s.mode==='off'?'Available web tabs':isSilence?'Connected tab':'Priority lineup · drag to rank';
  $('gameCount').textContent=s.mode==='off'
    ?`${s.availableGames?.length||0} open · ${isSilence?'add 1':'add 2–8'}`
    :`${s.gameTabs.length}/8 captured · ${isSilence?'1 audible':'2 minimum'}`;
  if(!draggingTabId&&!reorderBusy)renderGames(list,current,s);
  updatePreviewWatch(s);
  // Shown once on first use, however it is closed; Setup & help can show it again.
  if(!s.onboarded&&!welcomed&&!sheet.isOpen){
    welcomed=true;
    void invoke('SET_FLAGS',{flags:{onboarded:true}}).catch(()=>{});
    void Pages.welcome(sheet);
  }else if(s.supportNote&&!sheet.isOpen)void supportNote();
}
/** After a couple of weeks of use, once ever: a gentle word about Support SportsWitch. */
async function supportNote(){
  await invoke('SET_FLAGS',{flags:{supportNoteShown:true}});
  await Pages.settings(sheet);
  const show=await sheet.dialog('Enjoying SportsWitch?','SportsWitch is free. If it has made your games better, you can buy the developer a coffee on Ko-fi. This is the only time SportsWitch will ask.',{ok:'Show me',cancel:'No thanks'});
  if(show)await Pages.support(sheet);
  else sheet.closeAll();
}
let previouslyRenderedGameIds=new Set();
function renderGames(list,current,s){
  const fragment=document.createDocumentFragment();
  const oldRects=new Map(Array.from(games.querySelectorAll('.priority-row')).map(row=>[Number(row.dataset.tabId),row.getBoundingClientRect()]));
  const nextIds=new Set(list.map(tab=>tab.id));
  const connected=s.mode==='on'||s.mode==='arming';
  if(!list.length){
    const empty=document.createElement('div');empty.className='empty';
    empty.textContent='Open any ordinary web video tab (YouTube TV, Hulu, Peacock, Prime Video, etc.) and click Add This Tab. Add a second tab to start Switch mode.';
    fragment.append(empty);
  }
  for(let i=0;i<Math.min(8,list.length);i++){
    const tab=list[i];
    const row=document.createElement('div');
    row.className='game-slot priority-row'+(i===current&&connected?' is-current':'')+(!previouslyRenderedGameIds.has(tab.id)?' is-new':'');
    row.dataset.tabId=String(tab.id);
    const canRank=connected&&s.operatingMode==='switch';
    const handle=document.createElement('button');
    handle.className='drag-grip';handle.type='button';handle.textContent='⠿';
    handle.title=canRank?'Drag to change priority. Use Alt+Up/Down on this handle for keyboard ordering.':'Priority ordering is available in Switch mode.';
    handle.setAttribute('aria-label',`Reorder ${tab.displayTitle||tab.title||'tab'}; use Alt plus arrow up/down`);
    handle.disabled=!canRank||busy||!workerMatchesPopup;
    handle.draggable=canRank&&!busy&&workerMatchesPopup;
    handle.dataset.tabId=String(tab.id);
    row.append(handle);
    const button=document.createElement('button');
    button.className='game'+(i===current&&connected?' selected':'');
    button.disabled=busy||!s.enabled;
    button.title=`Watch ${tab.displayTitle||tab.title||'this tab'}`;
    button.dataset.gameId=String(tab.id);
    const number=document.createElement('span');number.className='game-num';number.textContent=String(i+1);
    const description=document.createElement('span');description.className='game-details';
    const first=document.createElement('span');first.className='game-firstline';
    const source=document.createElement('span');source.className='game-site';
    source.textContent=tab.site||'Web';
    const priority=document.createElement('span');priority.className='priority-label';
    priority.textContent=canRank?(i===0?'TOP PRIORITY':`PRIORITY ${i+1}`):`TAB ${i+1}`;
    first.append(source,priority);
    const matchup=document.createElement('span');matchup.className='game-match';
    matchup.textContent=tab.displayTitle||tab.title||`${tab.site||'Web'} stream`;
    matchup.title=matchup.textContent;
    const reading=s.gameReadings?.[String(tab.id)];
    const rowStatus=s.rows?.[String(tab.id)];
    const info=document.createElement('span');info.className='game-reading';
    if(connected&&rowStatus){
      if(s.enabled&&reading&&reading.classification&&!reading.silent){
        const classification=document.createElement('span');
        classification.className='classification '+reading.classification.toLowerCase();
        classification.textContent=reading.knownAd?'Known ad':reading.repeated?'Aired before':LABELS[reading.classification];
        info.append(classification);
      }
      const text=document.createElement('span');
      text.className='reading-values tone-'+rowStatus.tone;
      text.textContent=rowStatus.text;
      text.title=rowStatus.text;
      info.append(text);
      if(s.enabled&&reading?.updatedAt){
        const age=document.createElement('span');age.className='reading-age';
        age.textContent=relativeTime(reading.updatedAt);
        info.append(age);
      }
    }else{
      info.textContent=s.enabled?'Analyzing audio…':'Not monitoring';
    }
    description.append(first,matchup,info);
    button.append(number,description);
    button.addEventListener('click',()=>selectGameByTabId(tab.id));
    row.append(button);
    if(connected){
      const rename=document.createElement('button');
      rename.type='button';rename.className='rename-game';rename.textContent='✎';
      rename.title='Rename this stream (leave blank to restore detected title)';
      rename.setAttribute('aria-label','Rename '+(tab.displayTitle||tab.title||'stream'));
      rename.addEventListener('click',async()=>{
        const old=tab.manualTitle||tab.displayTitle||tab.title||'';
        const value=window.prompt('Name this stream (blank = automatic title):',old);
        if(value===null)return;
        try{await invoke('RENAME_GAME',{tabId:tab.id,title:value});await status();}
        catch(e){notice='Could not rename game: '+e.message;await status();}
      });
      row.append(rename);
      const remove=document.createElement('button');
      remove.type='button';remove.className='rename-game remove-game';remove.textContent='✕';
      remove.title='Remove from the lineup (the tab keeps playing, muted)';
      remove.setAttribute('aria-label','Remove '+(tab.displayTitle||tab.title||'stream')+' from the lineup');
      remove.addEventListener('click',async()=>{
        if(busy)return;
        busy=true;
        try{await invoke('REMOVE_GAME',{tabId:tab.id});}
        catch(e){notice='Could not remove game: '+e.message;}
        finally{busy=false;await status();}
      });
      row.append(remove);
    }
    fragment.append(row);
  }
  games.replaceChildren(fragment);
  if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches&&!s.lighterMotion){
    for(const row of games.querySelectorAll('.priority-row')){
      const before=oldRects.get(Number(row.dataset.tabId));
      if(!before)continue;
      const after=row.getBoundingClientRect();
      const dy=before.top-after.top;
      if(Math.abs(dy)>2&&Math.abs(dy)<600)row.animate([
        {transform:`translateY(${dy}px)`},{transform:'translateY(0)'}
      ],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
    }
  }
  previouslyRenderedGameIds=nextIds;
}
async function selectGameByTabId(tabId){
  const index=lastStatus?.gameTabs?.findIndex(t=>t.id===tabId)??-1;
  if(index<0){notice='This tab is no longer connected.';await status();return;}
  await selectGame(index);
}
async function commitReorder(sourceId,targetId){
  if(busy||reorderBusy||sourceId===targetId)return;
  if(!workerMatchesPopup){
    notice='Can\'t reorder yet: Chrome is still running an older SportsWitch. Open chrome://extensions and click the reload arrow on SportsWitch.';
    await status();return;
  }
  const ids=lastStatus?.gameTabs?.map(tab=>tab.id)||[];
  const from=ids.indexOf(sourceId),to=ids.indexOf(targetId);
  if(from<0||to<0)return;
  ids.splice(to,0,ids.splice(from,1)[0]);
  reorderBusy=true;
  try{
    await invoke('REORDER_GAMES',{ids});
  }catch(err){notice='Priority update failed: '+err.message;}
  finally{reorderBusy=false;await status();}
}
function clearDragUI(){
  games.querySelectorAll('.drag-over,.dragging').forEach(el=>el.classList.remove('drag-over','dragging'));
}
games.addEventListener('dragstart',e=>{
  const grip=e.target.closest('.drag-grip');
  if(!grip||grip.disabled){e.preventDefault();return;}
  draggingTabId=Number(grip.dataset.tabId);
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',String(draggingTabId));
  grip.closest('.priority-row')?.classList.add('dragging');
  hidePreview();
});
games.addEventListener('dragover',e=>{
  const row=e.target.closest('.priority-row');
  if(!row||draggingTabId===null)return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  games.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  row.classList.add('drag-over');
});
games.addEventListener('drop',async e=>{
  const row=e.target.closest('.priority-row');
  if(!row||draggingTabId===null)return;
  e.preventDefault();
  const source=draggingTabId,target=Number(row.dataset.tabId);
  draggingTabId=null;clearDragUI();
  await commitReorder(source,target);
});
games.addEventListener('dragend',()=>{draggingTabId=null;clearDragUI();});
games.addEventListener('keydown',async e=>{
  const grip=e.target.closest('.drag-grip');
  if(!grip||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();
  const ids=lastStatus?.gameTabs?.map(t=>t.id)||[];
  const src=Number(grip.dataset.tabId);
  const at=ids.indexOf(src),next=at+(e.key==='ArrowUp'?-1:1);
  if(next<0||next>=ids.length)return;
  await commitReorder(src,ids[next]);
  games.querySelector(`.drag-grip[data-tab-id="${src}"]`)?.focus();
});
function updatePreviewWatch(s=lastStatus){
  const watch=$('previewWatch');
  if(!watch)return;
  const index=s?.gameTabs?.findIndex(t=>t.id===hoverTabId)??-1;
  const connected=index>=0;
  const watching=connected&&s.currentIndex===index;
  watch.textContent=watching?'✓ Watching Now':'▶ Watch This Game';
  watch.disabled=busy||!s?.enabled||!connected||watching;
  watch.title=!connected?'Add this game first to watch it':watching?'Already watching this game':'Switch video and audio to this game';
  watch.setAttribute('aria-label',watch.title);
}
async function loadPreview(request,tabId){
  if(hoverBusy||hoverTabId!==tabId||request!==hoverRequest)return;
  hoverBusy=true;
  try{
    const preview=await invoke('GET_PREVIEW',{tabId});
    if(request!==hoverRequest||hoverTabId!==tabId)return;
    if(preview?.dataUrl){
      if($('previewImage').src!==preview.dataUrl)$('previewImage').src=preview.dataUrl;
      $('previewImage').hidden=false;
      $('previewFallback').hidden=true;
      const current=preview.source==='live';
      $('previewAge').textContent=current?'LIVE':relativeTime(preview.updatedAt);
      $('previewCaption').textContent=current
        ?'Fresh tab-capture frame · refreshes while hovering'
        :`Saved screenshot · ${relativeTime(preview.updatedAt)} · ${preview.reason||'Live capture unavailable'}`;
    }else{
      $('previewImage').hidden=true;
      $('previewFallback').hidden=false;
      $('previewFallback').textContent=preview?.reason||'Frame unavailable; video may be protected.';
      $('previewAge').textContent='Unavailable';
      $('previewCaption').textContent='Audio detection and switching still work.';
    }
  }catch(err){
    if(request===hoverRequest&&hoverTabId===tabId){
      $('previewFallback').hidden=false;
      $('previewFallback').textContent='Unable to load preview: '+err.message;
      $('previewAge').textContent='Unavailable';
    }
  }finally{hoverBusy=false;}
}
function showPreview(tabId,title){
  if(!Number.isInteger(tabId))return;
  clearTimeout(hoverHideTimer);
  if(tabId===hoverTabId&&!$('hoverPreview').hidden)return;
  clearInterval(hoverTimer);
  const request=++hoverRequest;
  hoverTabId=tabId;
  previewTitle=title||'Game preview';
  const pane=$('hoverPreview');
  pane.hidden=false;
  $('previewName').textContent=previewTitle;
  $('previewAge').textContent='Loading…';
  $('previewCaption').textContent='Checking for live video…';
  $('previewImage').hidden=true;
  $('previewFallback').hidden=true;
  updatePreviewWatch();
  void loadPreview(request,tabId);
  // Snapshot on hover and then a fresh frame roughly every 1.6 seconds;
  // do not poll snapshots when the popup is closed or preview hidden.
  hoverTimer=setInterval(()=>void loadPreview(request,tabId),1600);
}
function hidePreview(){
  clearInterval(hoverTimer);clearTimeout(hoverHideTimer);
  hoverRequest++;hoverTabId=null;hoverBusy=false;
  $('hoverPreview').hidden=true;
  $('previewImage').removeAttribute('src');
}
function scheduleHidePreview(){
  clearTimeout(hoverHideTimer);
  // A short grace period lets the pointer travel from a game card to the floating preview.
  hoverHideTimer=setTimeout(hidePreview,350);
}
games.addEventListener('mouseover',e=>{
  const button=e.target.closest('.game');
  if(!button||!games.contains(button))return;
  showPreview(Number(button.dataset.gameId),
    button.querySelector('.game-match')?.textContent||button.querySelector('.game-title')?.textContent||'Game');
});
games.addEventListener('mouseleave',scheduleHidePreview);
games.addEventListener('focusin',e=>{
  const button=e.target.closest('.game');
  if(button)showPreview(Number(button.dataset.gameId),button.querySelector('.game-match')?.textContent||'Game');
});
games.addEventListener('focusout',e=>{
  if(!games.contains(e.relatedTarget))scheduleHidePreview();
});
$('hoverPreview').addEventListener('mouseenter',()=>clearTimeout(hoverHideTimer));
$('hoverPreview').addEventListener('mouseleave',scheduleHidePreview);
$('previewWatch').addEventListener('click',async e=>{
  e.preventDefault();
  e.stopPropagation();
  const tabId=hoverTabId;
  // Find the tab again at click time; the list may have changed while hovering.
  const index=lastStatus?.gameTabs?.findIndex(t=>t.id===tabId)??-1;
  if(index<0||!lastStatus?.enabled){
    notice='This game is not connected. Add it before selecting it.';
    await status();
    return;
  }
  hidePreview();
  await selectGame(index); // Also activates the Chrome tab and selects its audio.
});
async function status(){
  if(busy||reorderBusy||draggingTabId!==null||sheet.isOpen)return;
  try{
    const tab=await contextTab();
    currentWindowId=tab?.windowId??currentWindowId;
    const s=await invoke('GET_STATUS',{windowId:currentWindowId,activeTabId:tab?.id});
    paintStatus(s);
  }catch(err){pill.textContent='Error';pill.className='pill err';updateError(err.message);}
}
async function onAddGame(){
  if(busy)return;
  busy=true;enableButton.disabled=true;disableButton.disabled=true;updateError('');
  try{
    const tab=await contextTab();
    if(tab)currentWindowId=tab.windowId;
    if(!tab)throw new Error('Open a web video tab first.');
    detail.textContent='Capturing audio from this game tab…';
    const plan=await invoke('PREPARE_CAPTURE',{tabId:tab.id});
    if(!plan.alreadyCaptured){
      // Chrome gives activeTab permission only for the page on which the user
      // invoked the extension. Do not attempt to capture any other open tab.
      // Best-effort screenshot while THIS game is the visible tab.
      try{await invoke('CAPTURE_PREVIEW',{tabId:tab.id});}catch{}
      const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
      await invoke('REGISTER_CAPTURE',{tabId:tab.id,streamId});
    }
  }catch(err){
    notice='Could not add game: '+err.message;
    try{await invoke('CAPTURE_FAILED',{error:err.message});}catch{}
  }finally{busy=false;await status();}
}
async function changeMode(operatingMode){
  if(busy||lastStatus?.operatingMode===operatingMode)return;
  busy=true;updateError('');
  try{await invoke('SET_OPERATING_MODE',{operatingMode});}
  catch(err){notice='Could not change mode: '+err.message;}
  finally{busy=false;await status();}
}
async function toggleHold(){
  if(busy)return;
  busy=true;
  try{await invoke('TOGGLE_HOLD');}
  catch(err){notice='Could not toggle Hold: '+err.message;}
  finally{busy=false;await status();}
}
async function toggleReturn(){
  if(busy||!lastStatus)return;
  busy=true;
  try{await invoke('SAVE_SETTINGS',{settings:{returnToPriority:lastStatus.settings?.returnToPriority===false}});}
  catch(err){notice='Could not change Return to higher-priority games: '+err.message;}
  finally{busy=false;await status();}
}
async function onDisable(){
  if(busy)return;
  busy=true;enableButton.disabled=true;disableButton.disabled=true;updateError('');
  try{detail.textContent='Stopping audio capture…';await invoke('DISABLE');}
  catch(err){notice='Disable failed: '+err.message;}
  finally{busy=false;await status();}
}
async function selectGame(index){
  if(busy)return;
  busy=true;
  try{await invoke('SELECT_GAME',{index,windowId:currentWindowId});}
  catch(err){notice='Unable to select game: '+err.message;}
  finally{busy=false;await status();}
}
/** "That's an ad" / "That's the game": fix the moment and teach SportsWitch. */
async function correct(type){
  if(!lastStatus?.enabled){updateError(lastStatus?.correctionsReason||'Add your games first.');return;}
  if(busy)return;
  busy=true;updateError('');
  try{const result=await invoke(type);detail.textContent=result.message;}
  catch(err){notice=err.message;}
  finally{busy=false;await status();}
}
$('helpButton').addEventListener('click',()=>{hidePreview();void Pages.setup(sheet);});
$('updateBadge').addEventListener('click',()=>{hidePreview();void Pages.updates(sheet);});
$('settingsButton').addEventListener('click',()=>{hidePreview();void Pages.settings(sheet);});
$('customizeBreaks').addEventListener('click',()=>{hidePreview();void Pages.adBreaks(sheet);});
$('previewBreak').addEventListener('click',()=>{hidePreview();showBreakPreview(document.body);});
markAdButton.addEventListener('click',()=>void correct('MARK_AD'));
markGameButton.addEventListener('click',()=>void correct('MARK_LIVE'));
switchMode.addEventListener('click',()=>changeMode('switch'));
silenceMode.addEventListener('click',()=>changeMode('silence'));
holdButton.addEventListener('click',toggleHold);
returnToggle.addEventListener('click',toggleReturn);
$('detachController').addEventListener('click',async()=>{
  try { await invoke('OPEN_CONTROLLER'); }
  catch(e){notice='Could not detach controller: '+e.message;await status();}
});
enableButton.addEventListener('click',onAddGame);
disableButton.addEventListener('click',onDisable);
(async()=>{
  try{currentWindowId=(await contextTab())?.windowId??null;}catch{}
  await status();
  setInterval(status,900);
})();
