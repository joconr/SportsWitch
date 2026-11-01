/* SportsWitch 4.0.4 - best-effort program naming. Deliberately uses public
 * page metadata and visible UI only. Never accesses provider network APIs. */
'use strict';
function normalizeSportsTitle(raw,url){
  let name=String(raw||'').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
  // Remove branding suffixes without stripping meaningful matchups.
  name=name.replace(/\s+(?:\||·|—|–|-)\s+(?:YouTube TV|Hulu(?: \+ Live TV)?|Peacock(?: TV)?|Prime Video|Amazon Prime Video|ESPN|FOX Sports|Paramount\+|Twitch|DIRECTV|Watch Live TV)\s*$/i,'').trim();
  name=name.replace(/^(?:Watch|Stream)\s+(?=(?:[A-Z][a-z]+\s+){2,})/,'');
  if(name.length>145)name=name.slice(0,145).trim();
  if(name.length<3||/^(?:Sports|Home|Watch|Live TV|Your Account|TV|Video|Player|Explore|Prime Video|Amazon Prime Video|Hulu|Peacock|YouTube|YouTube TV|ESPN|Live|Stream|Loading|Browse|Sign In|Sign Up|Search|Select a profile)$/i.test(name))return '';
  return name;
}
// Executed directly in MAIN world; must not refer to globals defined in
// extension's service worker. Content scripts cannot always see page-set
// Media Session properties in their isolated world.
function sportsWitchMediaSessionProbe(){
  try{
    const meta=navigator.mediaSession?.metadata;
    const title=String(meta?.title||'').replace(/\s+/g,' ').trim();
    if(title && title.length>3)return {title:title.slice(0,150),score:100,source:'media-session'};
  }catch{}
  return null;
}
// Executed in ISOLATED world, once per accessible frame. Uses player-adjacent
// metadata before page headings, so a recommendation tile can't easily outrank
// the currently playing broadcast.
function sportsWitchDomTitleProbe(){
  const candidates=[];
  const clean=x=>String(x||'').replace(/\s+/g,' ').trim().slice(0,155);
  const reject=/^(home|sports|watch|live tv|watch live|video|player|browse|search|sign in|settings|library|account|prime video|amazon prime video|hulu|peacock|youtube tv|youtube|espn|live|loading)$/i;
  const push=(value,score,source)=>{
    const title=clean(value);
    if(title.length<4||reject.test(title)||/cookies?|privacy policy|sign in to|subscription required|subscribe now/i.test(title))return;
    if(/(?:\bvs\.?\b|\bversus\b|\s@\s|\sat\s)/i.test(title))score+=7;
    if(/\b(?:nfl|nba|mlb|nhl|premier league|formula 1|f1|ufc|ncaa|wnba|playoffs|football|basketball|baseball|hockey|soccer|tennis|golf)\b/i.test(title))score+=4;
    if(title.length>115)score-=4;
    candidates.push({title,score,source});
  };
  let playback=null;
  const videos=[...document.querySelectorAll('video')];
  for(const video of videos){
    const rect=video.getBoundingClientRect();
    const area=Math.max(0,rect.width)*Math.max(0,rect.height);
    const score=area+(video.paused?0:1000000)+(video.readyState>=2?100000:0);
    if(!playback||score>playback.score)playback={video,score};
  }
  const selectors=[
    '[data-testid*="now-playing" i] [data-testid*="title" i]',
    '[data-testid*="player" i] [data-testid*="title" i]',
    '[data-testid*="program-title" i]','[data-testid*="event-title" i]',
    '[data-testid*="video-title" i]','[data-testid*="content-title" i]',
    '[data-testid*="live" i] [data-testid*="title" i]',
    '[aria-label*="Now playing" i]','[class*="now-playing" i] [class*="title" i]',
    '[class*="player" i] [class*="title" i]',
    '[class*="program-title" i]','[class*="event-title" i]',
    '[class*="video-title" i]','[class*="content-title" i]',
    '[data-title]'
  ];
  for(let si=0;si<selectors.length;si++){
    let elements=[];
    try{elements=[...document.querySelectorAll(selectors[si])].slice(0,22);}catch{continue;}
    for(const el of elements){
      const rect=el.getBoundingClientRect();
      const visible=!!el.getClientRects().length && rect.width>0 && rect.height>0;
      if(!visible)continue;
      const raw=el.getAttribute('data-title')||el.getAttribute('aria-label')||el.textContent;
      // Scoring penalizes lengthy descriptions and hidden recommendations.
      let score=si<2?66:si<7?55:si<12?42:30;
      if(playback){
        const player=playback.video;
        const frame=player.closest('[data-testid*="player" i], [class*="player" i],main,article,section');
        if(frame&&frame.contains(el))score+=12;
        // Titles near video controls are more likely to refer to this stream.
        const vr=player.getBoundingClientRect();
        if(Math.abs(rect.top-vr.bottom)<220||Math.abs(rect.top-vr.top)<140)score+=5;
      }
      push(raw,score,'player-label');
    }
  }
  const ldScripts=[...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,10);
  function inspect(node,depth=0){
    if(!node||depth>5)return;
    if(Array.isArray(node)){for(const x of node.slice(0,18))inspect(x,depth+1);return;}
    if(typeof node!=='object')return;
    const types=String(node['@type']||'');
    if(/SportsEvent|BroadcastEvent|VideoObject|TVEpisode|LiveBlogPosting|Event|TVSeries/i.test(types)){
      push(node.name||node.headline||node.title, /SportsEvent|BroadcastEvent/i.test(types)?76:61,'structured-data');
    }
    if(node['@graph'])inspect(node['@graph'],depth+1);
    if(node.mainEntity)inspect(node.mainEntity,depth+1);
    if(node.video)inspect(node.video,depth+1);
  }
  for(const script of ldScripts){
    try{if(script.textContent.length<120000)inspect(JSON.parse(script.textContent));}catch{}
  }
  const metas=[
    ['meta[property="og:video:title"]',54],['meta[property="og:title"]',37],
    ['meta[name="twitter:title"]',35],['meta[name="title"]',31]
  ];
  for(const [selector,score] of metas)push(document.querySelector(selector)?.getAttribute('content'),score,'page-meta');
  for(const selector of ['main h1','[role="main"] h1','h1']){
    for(const el of [...document.querySelectorAll(selector)].slice(0,5)){
      if(el.getClientRects().length)push(el.textContent,30,'heading');
    }
  }
  push(document.title,24,'tab-title');
  candidates.sort((a,b)=>b.score-a.score||a.title.length-b.title.length);
  return candidates.slice(0,9);
}
