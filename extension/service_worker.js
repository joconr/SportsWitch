/* SportsWitch 4.2.0 background: the lineup, the decisions and everything around them.
 * Chrome's swap model from 4.1.x is kept: every added tab is captured and heard at once, Switch mode
 * moves between tabs by priority, Silence mode mutes one tab. The decisions come from engine.js, the
 * Android app's detection (break tracker, splices, learned ads, repeats, corrections) applied per tab.
 */
'use strict';
importScripts('native_fullscreen.js', 'title_extractor.js', 'engine.js', 'breaks_data.js', 'breaks.js', 'detection_log.js');
const BUILD_VERSION = '4.4.1';
const MIN_GAMES = 2;
const MAX_GAMES = 8;
const {SwitchEngine, Presenter, DEFAULT_SETTINGS, validateSettings, migrateSettings, centred, AUDIO_LABEL} = self.SportsWitchEngine;
const SETTINGS_KEY = 'sportsWitchSettings';
const OPERATING_MODE_KEY = 'sportsWitchOperatingMode';
const STATE_KEY = 'sportsSwitcherState';
const PREVIEW_KEY = 'sportsWitchPreviews';
const FLAGS_KEY = 'sportsWitchFlags';
const LEARNED_KEY = 'sportsWitchLearned';
/** Support SportsWitch: the Ko-fi page. Empty leaves every mention of supporting SportsWitch out. */
const SUPPORT_URL = '';
const SUPPORT_NOTE_AFTER_MS = 14 * 24 * 3600000;
const SUPPORT_NOTE_AFTER_BREAKS = 20;
const VIEWER_GAME_LABEL_MS = 30000;
const VIEWER_GAME_BACK_SECONDS = 10;
let previewBusy = false;
let titleBusy = false;
let lastTitleRefresh = 0;
let creatingOffscreen = null;

// ---- Settings and flags ---------------------------------------------------------------------------

async function readSettings() {
  return migrateSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}
/** Saves a change to the settings; it applies at once, as on the Android app. */
async function saveSettings(changes) {
  const current = await readSettings();
  const settings = validateSettings({...current, ...changes});
  await chrome.storage.local.set({[SETTINGS_KEY]: settings});
  if (current.autoFullscreenOnSwitch && !settings.autoFullscreenOnSwitch) await stopFullscreenAutomation();
  const e = await getEngine();
  const now = Date.now();
  await perform(e.updateSettings(settings), now);
  if (e.s.monitoring) {
    await toWorker({type: 'options', wantFeatures: settings.saveDetectionLog});
    if (settings.saveDetectionLog && !current.saveDetectionLog) void DetectionLog.open();
    if (!settings.saveDetectionLog && current.saveDetectionLog) void DetectionLog.close();
  }
  persist();
  await overlaySync();
  return settings;
}
/** Detection only: the display and log choices stay as they are. */
async function restoreRecommended() {
  const current = await readSettings();
  return await saveSettings({...DEFAULT_SETTINGS, showOverlay: current.showOverlay, saveDetectionLog: current.saveDetectionLog});
}

const DEFAULT_FLAGS = {onboarded: false, lighterMotion: null, firstUsedAt: 0, breaksHandled: 0, supportSeen: false, supportDonated: false, supportNoteShown: false};
let flagsCache = null;
async function readFlags() {
  if (!flagsCache) flagsCache = {...DEFAULT_FLAGS, ...((await chrome.storage.local.get(FLAGS_KEY))[FLAGS_KEY] || {})};
  return flagsCache;
}
async function writeFlags(changes) {
  flagsCache = {...(await readFlags()), ...changes};
  await chrome.storage.local.set({[FLAGS_KEY]: flagsCache});
  return flagsCache;
}
/** "Lighter animations" follows the computer unless chosen: on with 2 GB of memory or less. */
function lighterAuto() {
  try { return (navigator.deviceMemory || 8) <= 2; } catch { return false; }
}
async function lighterMotion() {
  const f = await readFlags();
  return f.lighterMotion === null || f.lighterMotion === undefined ? lighterAuto() : !!f.lighterMotion;
}
async function setFlags(changes) {
  const next = {};
  if ('onboarded' in changes) next.onboarded = !!changes.onboarded;
  // Choosing what the computer would pick anyway goes back to following it.
  if ('lighterMotion' in changes) next.lighterMotion = changes.lighterMotion === lighterAuto() ? null : !!changes.lighterMotion;
  for (const key of ['supportSeen', 'supportDonated', 'supportNoteShown']) if (key in changes) next[key] = !!changes[key];
  await writeFlags(next);
  await overlaySync(true);
  return {};
}
function supportNoteDue(f, now) {
  return !!SUPPORT_URL && !f.supportNoteShown && !f.supportSeen && !f.supportDonated && f.firstUsedAt > 0 &&
    now - f.firstUsedAt >= SUPPORT_NOTE_AFTER_MS && f.breaksHandled >= SUPPORT_NOTE_AFTER_BREAKS;
}
async function storeLearnedSummary(m) {
  const text = `${m.ads} ads remembered · ${m.game} game and ${m.ad} ad seconds learned` + (m.adapted ? ' · tuned to this computer' : '');
  await chrome.storage.local.set({[LEARNED_KEY]: text});
}

// ---- Updates --------------------------------------------------------------------------------------

/*
 * Two ways to stay up to date, by how SportsWitch was installed. Chrome updates the Chrome Web Store copy;
 * SportsWitch asks it once a day as well, and a downloaded update installs between games, never during a
 * session. A copy loaded from a folder looks at the newest GitHub release once a day. Where SportsWitch
 * Updater is set up on the computer (updater\, "Set up automatic updates"), that helper downloads the
 * release, checks its signature and copies it over the folder, and SportsWitch reloads between games;
 * otherwise SportsWitch says the version is out. The workshop copy, the folder releases are made in, never
 * updates itself. Settings, ad-break choices and what SportsWitch learned live in Chrome, not in the folder,
 * so updates keep them; an update that has to change one of them does it in UPDATE_STEPS.
 */
const UPDATE_REPO = String(chrome.runtime.getManifest().homepage_url || '').replace('https://github.com/', '');
const UPDATE_HELPER = 'com.sportswitch.updater';
const UPDATE_ALARM = 'sportswitch-update-check';
const UPDATE_KEY = 'sportsWitchUpdate';
const UPDATE_EVERY_MINUTES = 24 * 60;
/** What an update changes in the viewer's choices, each run once when updating across its version. */
const UPDATE_STEPS = [
  {version: '4.3.0', run: () => Accounts.forgetSpotifySignIn()},
];
function newerVersion(a, b) {
  const x = String(a).split('.').map(Number), y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
async function readUpdate() {
  return {checkedAt: 0, available: null, pending: null, updatedFrom: null, result: null, error: null, helper: false, auto: true,
    ...((await chrome.storage.local.get(UPDATE_KEY))[UPDATE_KEY] || {})};
}
async function writeUpdate(changes) {
  const next = {...await readUpdate(), ...changes};
  await chrome.storage.local.set({[UPDATE_KEY]: next});
  return next;
}
/**
 * 'store' for the Chrome Web Store copy, 'folder' for one loaded with Load unpacked, 'workshop' for the folder
 * releases are made in (it has tools\publish_release.ps1).
 */
async function installKind() {
  try { if ((await chrome.management.getSelf()).installType === 'normal') return 'store'; } catch {}
  try { return (await fetch(chrome.runtime.getURL('tools/publish_release.ps1'))).ok ? 'workshop' : 'folder'; } catch { return 'folder'; }
}
/** One request to SportsWitch Updater; {ok: false, error} when it isn't set up on this computer, or fails. */
async function askHelper(message) {
  try {
    return (await chrome.runtime.sendNativeMessage(UPDATE_HELPER, message)) || {ok: false, error: 'SportsWitch Updater did not answer.'};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}
/** [install] also installs what it found, when automatic updates are on: the daily check does. */
async function checkForUpdates({install = false} = {}) {
  const kind = await installKind();
  if (kind === 'store') {
    const {status, version} = await chrome.runtime.requestUpdateCheck();
    return await writeUpdate({checkedAt: Date.now(), result: status === 'update_available'
      ? `SportsWitch ${version} is downloading. It installs when no game is playing.`
      : status === 'throttled' ? 'Chrome looked a moment ago and will look again soon.' : 'SportsWitch is up to date.'});
  }
  // The newest release; drafts and pre-releases don't count, so a version can be tried before it goes out.
  const release = JSON.parse(await fetchText(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {cache: 'no-store'}));
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const available = newerVersion(latest, BUILD_VERSION) ? latest : null;
  const helper = kind === 'folder' ? await askHelper({cmd: 'hello'}) : {ok: false};
  const {auto} = await readUpdate();
  const result = !available ? 'SportsWitch is up to date.'
    : kind === 'workshop' ? `SportsWitch ${available} is out. Get it from GitHub.`
    : !helper.ok ? `SportsWitch ${available} is out. Get it from GitHub, or set up automatic updates and it installs by itself.`
    : auto ? `SportsWitch ${available} is out. It installs by itself between games.` : `SportsWitch ${available} is out.`;
  const state = await writeUpdate({checkedAt: Date.now(), available, helper: !!helper.ok, error: null, result});
  if (!(install && available && helper.ok && auto)) return state;
  await writeUpdate({pending: available});
  return await installPendingUpdate();
}
function scheduleUpdateChecks() {
  void chrome.alarms.get(UPDATE_ALARM).then(alarm => {
    if (!alarm) void chrome.alarms.create(UPDATE_ALARM, {delayInMinutes: 2, periodInMinutes: UPDATE_EVERY_MINUTES});
  });
}
/**
 * The pending update installs as soon as no game is playing; disable() tries again after a session. The Web
 * Store copy only needs the reload; for a folder copy SportsWitch Updater copies the new version in first.
 */
async function installPendingUpdate() {
  const state = await readUpdate();
  if (!state.pending || (await getEngine()).s.monitoring) return state;
  if (await installKind() !== 'store') {
    const reply = await askHelper({cmd: 'install', version: state.pending});
    if (!reply.ok) return await writeUpdate({pending: null, error: `SportsWitch ${state.pending} didn't install: ${reply.error} SportsWitch tries again tomorrow.`});
  }
  await writeUpdate({pending: null});
  setTimeout(() => chrome.runtime.reload(), 500); // once this answer has reached the page that asked
  return {...state, pending: null, installing: state.pending};
}

// ---- The engine and its state ---------------------------------------------------------------------

let engine = null;
let engineLoading = null;
/** The tab whose audio is heard and learned from, as last told to the audio engine. */
let watchedTabId = null;
let viewerGameUntil = 0;
let sentLabel = -1;

async function readOperatingMode() {
  const stored = (await chrome.storage.local.get(OPERATING_MODE_KEY))[OPERATING_MODE_KEY];
  return stored === 'silence' ? 'silence' : 'switch';
}
function idleMessage(mode) {
  return mode === 'silence' ? 'Silence mode: add one tab to mute ads and unmute live action.' : 'Switch mode: add two tabs to begin automatic switching.';
}
async function freshEngine() {
  const mode = await readOperatingMode();
  const e = SwitchEngine.create(await readSettings(), mode);
  e.s.message = idleMessage(mode);
  return e;
}
function getEngine() {
  if (engine) return Promise.resolve(engine);
  if (!engineLoading) engineLoading = (async () => {
    const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
    const restored = stored && stored.version === 2 ? SwitchEngine.restore(stored.engine) : await freshEngine();
    engine = engine || restored;
    watchedTabId = engine.s.monitoring ? engine.s.currentId : null;
    if (engine.s.monitoring) ensureTicker();
    return engine;
  })().finally(() => { engineLoading = null; });
  return engineLoading;
}
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (engine) void chrome.storage.session.set({[STATE_KEY]: {version: 2, engine: engine.toJSON()}});
  }, 300);
}
async function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  if (engine) await chrome.storage.session.set({[STATE_KEY]: {version: 2, engine: engine.toJSON()}});
}
/** Engine commands run one after another: readings from eight tabs must not overwrite each other. */
let queueTail = Promise.resolve();
function serial(work) {
  const run = queueTail.catch(() => {}).then(work);
  queueTail = run.catch(() => {});
  return run;
}
let ticker = null;
function ensureTicker() {
  if (!ticker) ticker = setInterval(() => void serial(onTick).catch(err => console.warn('[SportsWitch] Tick:', err.message)), 1000);
}
function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}
let tickCount = 0;
async function onTick() {
  const e = await getEngine();
  if (!e.s.monitoring) return stopTicker();
  const now = Date.now();
  const actions = e.onTick(now);
  if (actions.length) {
    await perform(actions, now);
    persist();
  }
  if (++tickCount % 60 === 0) scheduleTitleRefresh(true);
  await overlaySync();
}

/** Carries out what the engine decided, in order. */
async function perform(actions, now) {
  for (const a of actions) {
    const e = engine;
    if (e.settings.saveDetectionLog && e.s.monitoring) DetectionLog.event(now, 'action:' + a.type, e);
    try {
      switch (a.type) {
        case 'select': await selectTab(a); break;
        case 'mute': await setMuted(a.muted); break;
        case 'adStarted': if (e.settings.learnAds) await toWorker({type: 'learning', commands: [{op: 'begin', secondsBack: a.onsetSeconds}]}); break;
        case 'adEnded': await toWorker({type: 'learning', commands: [{op: 'end', trimSeconds: a.trimSeconds}]}); break;
        case 'forgetRecentAds': await toWorker({type: 'learning', commands: [{op: 'forget'}]}); break;
        case 'learn':
          if (e.settings.learnAds) await toWorker({type: 'learning', commands: [{op: 'label', from: a.from, to: a.to, live: a.live,
            weight: a.weight, onlyWhereForestAgrees: a.source === 'auto'}]});
          break;
        case 'flush': await toWorker({type: 'flush', tabId: a.id}); break;
        case 'prompt': break; // the overlay and the controller show the engine's prompt
        case 'stopSession': await disable(e.s.message); return;
      }
    } catch (err) {
      console.warn('[SportsWitch] Could not', a.type + ':', err.message);
    }
  }
}

// ---- Web tabs -------------------------------------------------------------------------------------

// Monitor only ordinary web pages explicitly added by the user. Chrome-internal,
// extension, browser settings and restricted schemes are not capture targets.
function isGame(t) {
  try { const url = new URL(t?.url || ''); return ['http:', 'https:'].includes(url.protocol); }
  catch { return false; }
}
async function gameTabs(windowId) {
  const list = await chrome.tabs.query(windowId == null ? {} : {windowId});
  return list.filter(isGame).sort((a, b) => a.index - b.index);
}
function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = {'tv.youtube.com': 'YouTube TV', 'youtube.com': 'YouTube',
      'hulu.com': 'Hulu', 'peacocktv.com': 'Peacock', 'primevideo.com': 'Prime Video',
      'amazon.com': 'Prime Video / Amazon', 'espn.com': 'ESPN', 'foxsports.com': 'FOX Sports',
      'paramountplus.com': 'Paramount+', 'max.com': 'Max', 'twitch.tv': 'Twitch',
      'netflix.com': 'Netflix', 'disneyplus.com': 'Disney+', 'directv.com': 'DIRECTV'};
    return known[host] || host;
  } catch { return 'Web'; }
}
function tabSummary(t) {
  return {id: t.id, windowId: t.windowId, url: t.url, title: t.title || '', site: siteName(t.url)};
}
/** A tab "moved to another page" when its address changes beyond the query and hash (a new channel or game). */
function pageKey(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}
async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['USER_MEDIA'],
      justification: 'Capture, replay, and analyze user-selected sports tabs locally in Chrome.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}
function toOffscreen(type, more = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({target: 'offscreen', type, ...more}, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Audio engine error'));
      else resolve(response.data);
    });
  });
}
async function toWorker(message, wait = false) {
  if (await offscreenExists()) return await toOffscreen('WORKER', {message, wait});
  return null;
}
async function queryCaptured() {
  if (!(await offscreenExists())) return [];
  return (await toOffscreen('PING')).capturedIds;
}

// Layered provider-neutral title detection. 4.1.0 restored the proven 4.0.2 game-title
// selection method: Media Session and generic station labels can outrank true matchups on
// some providers, so those newer experimental probes are no longer used.
async function readProgramTitle(tabId) {
  try {
    const result = await chrome.scripting.executeScript({target: {tabId}, func: () => {
      const clean = x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 155);
      const values = [];
      const put = (value, score) => {
        const text = clean(value);
        if (text.length > 3 && !/^(home|sports|watch|live tv|video|account|library|play|pause)$/i.test(text))
          values.push({text, score});
      };
      for (const selector of ['[data-testid*="program-title"]', '[data-testid*="event-title"]',
        '[data-testid*="video-title"]', '[data-testid*="content-title"]',
        '[class*="program-title"]', '[class*="event-title"]',
        '[class*="player-title"]', '[class*="video-title"]',
        '[class*="content-title"]', '[data-title]']) {
        for (const element of [...document.querySelectorAll(selector)].slice(0, 12)) {
          if (!element.getClientRects().length) continue;
          put(element.getAttribute('data-title') || element.textContent, 9);
        }
      }
      put(document.querySelector('meta[property="og:title"]')?.content, 7);
      put(document.querySelector('meta[name="twitter:title"]')?.content, 6);
      for (const selector of ['main h1', '[role="main"] h1', 'h1', 'h2']) {
        for (const element of [...document.querySelectorAll(selector)].slice(0, 6)) {
          if (element.getClientRects().length) put(element.textContent, selector === 'h2' ? 3 : 5);
        }
      }
      put(document.title, 5);
      for (const c of values) {
        if (/\b(vs\.?|versus|at)\b|\s@\s/i.test(c.text)) c.score += 4;
        if (/^(youtube tv|hulu|peacock|prime video|home|watch live|live tv)$/i.test(c.text)) c.score -= 8;
        if (/sign in|subscribe|cookie preferences|your account/i.test(c.text)) c.score -= 8;
        if (c.text.length > 115) c.score -= 3;
      }
      values.sort((a, b) => b.score - a.score);
      return values.find(v => v.score > 0)?.text || null;
    }});
    return result?.[0]?.result || null;
  } catch { return null; }
}
async function refreshGameTitles() {
  if (titleBusy) return;
  titleBusy = true; lastTitleRefresh = Date.now();
  try {
    const e = await getEngine();
    if (!e.games.length) return;
    const updates = await Promise.all(e.games.map(async g => ({id: g.id, title: await readProgramTitle(g.id)})));
    let changed = false;
    for (const {id, title} of updates) {
      const g = e.games.find(x => x.id === id);
      if (!g || !title || g.detectedTitle === title) continue;
      e.updateGame(id, {detectedTitle: title, displayTitle: g.manualTitle || title});
      changed = true;
    }
    if (changed) persist();
  } finally { titleBusy = false; }
}
function scheduleTitleRefresh(force = false) {
  if (!titleBusy && (force || Date.now() - lastTitleRefresh > 30000))
    void refreshGameTitles().catch(e => console.warn('[SportsWitch] Titles:', e));
}
async function renameGame(tabId, title) {
  const e = await getEngine();
  const g = e.games.find(t => t.id === tabId);
  if (!Number.isInteger(tabId) || !g) throw new Error('This tab is no longer in your lineup.');
  const manualTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  e.updateGame(tabId, {manualTitle: manualTitle || null,
    displayTitle: manualTitle || g.detectedTitle || normalizeSportsTitle(g.title, g.url) || g.title || 'Stream'});
  persist();
  return {id: tabId, title: g.displayTitle, manual: !!manualTitle};
}

// ---- Previews (unchanged from 4.1.x) ---------------------------------------------------------------

async function getPreview(tabId) {
  const e = await getEngine();
  if (e.games.some(t => t.id === tabId) && await offscreenExists()) {
    try {
      const live = await toOffscreen('GRAB_FRAME', {tabId});
      if (live?.available && live.dataUrl) return live;
      const previews = (await chrome.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY] || {};
      const fallback = previews[String(tabId)];
      return fallback ? {...fallback, source: 'cached', reason: live?.reason || 'Live frame unavailable.'}
        : {source: 'unavailable', reason: live?.reason || 'Live preview unavailable.'};
    } catch (err) { console.info('[SportsWitch] Live preview:', err.message); }
  }
  const previews = (await chrome.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY] || {};
  const preview = previews[String(tabId)];
  return preview ? {...preview, source: 'cached', reason: 'Saved screenshot'}
    : {source: 'unavailable', reason: 'No screenshot available yet.'};
}
async function capturePreview(tabId) {
  if (previewBusy) return {captured: false, reason: 'Snapshot already underway'};
  const tab = await chrome.tabs.get(tabId);
  if (!isGame(tab)) throw new Error('Only ordinary web tabs can be previewed');
  const [active] = await chrome.tabs.query({active: true, windowId: tab.windowId});
  if (active?.id !== tabId) throw new Error('Background games cannot be screenshotted; showing their last preview.');
  previewBusy = true;
  try {
    // Query the player's visible VIDEO rectangle to crop the tab screenshot.
    // We do not try to draw cross-origin/DRM video to a webpage canvas.
    let position = null;
    try {
      const r = await chrome.scripting.executeScript({target: {tabId}, func: () => {
        const width = window.innerWidth, height = window.innerHeight;
        const vids = [...document.querySelectorAll('video')];
        let best = null;
        for (const v of vids) {
          const rect = v.getBoundingClientRect();
          const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
          const right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
          const area = Math.max(0, right - left) * Math.max(0, bottom - top);
          if (area > 6000 && (!best || area > best.area)) best = {area, left, top, width: right - left, height: bottom - top};
        }
        return best ? {...best, viewportWidth: width, viewportHeight: height} : null;
      }});
      position = r?.[0]?.result || null;
    } catch {}
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 58});
    const picture = await createImageBitmap(await (await fetch(raw)).blob());
    const scale = position ? picture.width / position.viewportWidth : 1;
    const crop = position ? {
      x: Math.max(0, Math.round(position.left * scale)),
      y: Math.max(0, Math.round(position.top * scale)),
      w: Math.min(picture.width, Math.round(position.width * scale)),
      h: Math.min(picture.height, Math.round(position.height * scale))
    } : {x: 0, y: 0, w: picture.width, h: picture.height};
    if (crop.x + crop.w > picture.width) crop.w = picture.width - crop.x;
    if (crop.y + crop.h > picture.height) crop.h = picture.height - crop.y;
    if (crop.w < 1 || crop.h < 1) throw new Error('Video rectangle not visible');
    const width = 400, height = Math.max(90, Math.min(270, Math.round(width * crop.h / crop.w)));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(picture, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
    picture.close();
    const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.7});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    const preview = {dataUrl: 'data:image/jpeg;base64,' + btoa(binary), updatedAt: Date.now()};
    const stored = (await chrome.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY] || {};
    stored[String(tabId)] = preview;
    await chrome.storage.session.set({[PREVIEW_KEY]: stored});
    return {captured: true};
  } finally { previewBusy = false; }
}
async function safeCapturePreview(tabId) {
  // Wait for the newly active tab to paint its first frame.
  await new Promise(resolve => setTimeout(resolve, 350));
  try { await capturePreview(tabId); } catch (e) { console.info('[SportsWitch] Preview unavailable:', e.message); }
}

// ---- Native fullscreen (unchanged from 4.1.x) -------------------------------------------------------
/* Isolated, opt-in site-aware native player fullscreen. Does NOT touch CSS, player sizing,
 * browser window state, capture or gain. A failed debugger attempt must never throw into the
 * game-switching path. */
let fullscreenGeneration = 0;
async function stopFullscreenAutomation() {
  // Stop any pending (but not yet dispatched) attempt. Existing native
  // fullscreen is a normal page state the viewer may leave with Escape.
  fullscreenGeneration++;
}
async function doFullscreenOnSwitch(destinationTab, generation) {
  if (generation !== fullscreenGeneration) return;
  try {
    const settings = await readSettings();
    if (!settings.autoFullscreenOnSwitch || generation !== fullscreenGeneration) return;
    const result = await SportsWitchNativeFullscreen.attempt(destinationTab.id, () => generation === fullscreenGeneration);
    if (!result.ok) console.info('[SportsWitch] Native fullscreen unavailable (audio switching unaffected):', result.reason);
    else console.info('[SportsWitch] Native fullscreen:', result.method);
  } catch (e) {
    console.warn('[SportsWitch] Native fullscreen failed; normal viewing and audio continue:', e.message);
  }
}

// ---- Switching and muting ---------------------------------------------------------------------------

async function manualSelect(tabs, index) {
  await Promise.all(tabs.map(t => chrome.tabs.update(t.id, {muted: true})));
  await chrome.tabs.update(tabs[index].id, {muted: false, active: true});
}
async function selectTab({id, whoosh, fullscreen}) {
  const e = engine;
  const previous = watchedTabId;
  const destination = e.games.find(g => g.id === id);
  if (!destination) return;
  watchedTabId = id;
  sentLabel = -1;
  const switched = previous !== null && previous !== id;
  // Changing audio gain alone NEVER calls fullscreen helpers. Only switching
  // to a different game can activate optional fullscreen mode.
  const generation = switched ? ++fullscreenGeneration : fullscreenGeneration;
  await toOffscreen('SELECT', {tabId: id, enabled: e.s.monitoring, analysisMode: e.s.mode, muted: false});
  // Captured streams are audible via offscreen gain nodes; Chrome must not
  // independently tab-mute these sources or the model may receive silence.
  const tab = await chrome.tabs.update(id, {active: true});
  const before = e.games.find(g => g.id === previous);
  if (tab && tab.windowId !== destination.windowId) e.updateGame(id, {windowId: tab.windowId});
  if (switched && before && before.windowId !== (tab ? tab.windowId : destination.windowId)) {
    // Activating a tab in ANOTHER window alone does not foreground its window.
    try { await chrome.windows.update(tab ? tab.windowId : destination.windowId, {focused: true}); }
    catch (err) { console.warn('[SportsWitch] Could not focus destination window:', err.message); }
  }
  // Do not block detection while Chrome negotiates fullscreen permissions.
  if (fullscreen) void doFullscreenOnSwitch(destination, generation);
  // Play only for a completed change to a different game; a failure never blocks switching.
  if (whoosh) void toOffscreen('PLAY_SWITCH_SOUND').catch(err => console.info('[SportsWitch] Switch sound unavailable:', err.message));
  void safeCapturePreview(id);
  if (switched) void clearOverlay(previous);
}
/** Gain-only mute; the ad-break screen and music follow it. */
async function setMuted(muted) {
  await toOffscreen('SET_AUDIO', {muted, ducked: false});
  await breaks.onMuteChanged(muted);
  if (muted) await writeFlags({breaksHandled: (await readFlags()).breaksHandled + 1});
}

const breaks = new Breaks({
  lineup: () => ({games: engine ? engine.games.map(g => ({id: g.id, title: g.detectedTitle || g.manualTitle || g.displayTitle || g.title})) : [],
    onScreen: engine ? engine.s.currentId : null}),
  onGameAlert: (id, text) => void serial(async () => {
    const e = await getEngine();
    const now = Date.now();
    await perform(e.alertGame(id, text, now), now);
    persist();
    await overlaySync();
  }),
  onChanged: () => void overlaySync(),
  offscreen: async (type, data) => {
    if (!(await offscreenExists())) throw new Error('SportsWitch is not listening');
    return await toOffscreen(type, data);
  },
  // The radio started (turn the ad down under it) or stopped mid-break (silent again).
  duck: async on => {
    if (engine && engine.s.muted && await offscreenExists()) await toOffscreen('SET_AUDIO', {muted: true, ducked: on});
  },
});

// ---- Readings and corrections -----------------------------------------------------------------------

async function onReading(r) {
  const e = await getEngine();
  if (!e.s.monitoring) return;
  const learn = e.settings.learnAds;
  // A repeat that first passed for game (a promo can sound like sport) is weaker evidence.
  const airedBefore = !learn || !r.repeat ? 0 : r.repeat.earlier === AUDIO_LABEL.GAME ? 0.5 : 1;
  const live = learn ? r.adjustedLive : centred(r.liveProbability);
  const actions = e.onReading({tabId: r.tabId, live, energy: r.energy, zeroFraction: r.zeroFraction, splice: r.splice,
    knownAd: !!r.knownAd, airedBefore}, r.time);
  await perform(actions, r.time);
  if (r.tabId === e.s.currentId && engine === e) {
    if (e.settings.saveDetectionLog) DetectionLog.reading(r.time, r, e);
    await updateAudioLabel();
  }
  persist();
  await overlaySync();
}
/** Tells the history what SportsWitch thinks it is hearing, so repeats know what aired before. */
async function updateAudioLabel() {
  const s = engine.s;
  const label = Date.now() < viewerGameUntil ? AUDIO_LABEL.VIEWER_GAME : s.adActive ? AUDIO_LABEL.AD
    : s.lastClassification === 'Live' ? AUDIO_LABEL.GAME : AUDIO_LABEL.UNKNOWN;
  if (label === sentLabel) return;
  sentLabel = label;
  await toWorker({type: 'learning', commands: [{op: 'currentLabel', value: label}]});
}
async function markAd() {
  const e = await getEngine();
  const now = Date.now();
  if (e.s.monitoring && e.settings.saveDetectionLog) DetectionLog.event(now, 'mark_ad', e);
  await perform(e.markAd(now), now);
  persist();
  await overlaySync();
  return {message: e.s.message};
}
async function markLive() {
  const e = await getEngine();
  const now = Date.now();
  if (e.s.monitoring && e.settings.saveDetectionLog) DetectionLog.event(now, 'mark_live', e);
  await perform(e.markLive(now), now);
  // The viewer's word: what is playing now (and just before) is never a repeat-ad.
  viewerGameUntil = now + VIEWER_GAME_LABEL_MS;
  await toWorker({type: 'learning', commands: [{op: 'labelRecent', seconds: VIEWER_GAME_BACK_SECONDS, label: AUDIO_LABEL.VIEWER_GAME}]});
  await updateAudioLabel();
  persist();
  await overlaySync();
  return {message: e.s.message};
}
async function resetLearning() {
  if (await offscreenExists()) await toOffscreen('WORKER', {message: {type: 'reset'}, wait: true});
  else await new Promise(resolve => {
    const request = indexedDB.deleteDatabase('sportswitch-learning');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  await chrome.storage.local.remove(LEARNED_KEY);
  return {};
}

// ---- The on-page status and ad-break screen ---------------------------------------------------------

let overlayTabId = null;
let overlayKey = '';
function pillModel(e, now) {
  const s = e.s;
  if (s.prompt) return {headline: s.prompt.text, detail: 'Choose Watch to switch.', tone: 'uncertain', prompting: true};
  const name = e.currentName();
  const p = s.lastProbability;
  const pct = Presenter.pct;
  let headline;
  if (e.isSettling(now)) headline = `Settling in · ${name}`;
  else if (s.muted) headline = breaks.radioCoversAd ? `Ad break · radio on · ${name}` : `Muted for ads · ${name}`;
  else if (p == null) headline = `Listening · ${name}`;
  else if (s.lastKnownAd) headline = `Ad (recognised) · ${name}`;
  else if (s.lastRepeatedAd) headline = `Ad (aired before) · ${name}`;
  else if (s.lastClassification === 'Commercial') headline = `Ad ${pct(1 - p)}% · ${name}`;
  else headline = `${self.SportsWitchEngine.LABELS[s.lastClassification] || 'Uncertain'} ${pct(p)}% · ${name}`;
  let detail = null;
  if (e.isSettling(now) || s.muted) detail = s.message;
  else if (s.hold) detail = 'Hold on: automatic switching paused';
  else if (s.mode === 'switch' && e.currentIndex() >= 0) detail = `Game ${e.currentIndex() + 1} of ${s.games.length}`;
  else if (s.mode === 'silence') detail = 'Silence mode';
  return {headline, detail, tone: Presenter.stateTone(s, now), prompting: false};
}
async function overlayModel(e, now) {
  const s = e.s;
  return {
    light: await lighterMotion(),
    pill: s.monitoring && (e.settings.showOverlay || s.prompt) ? pillModel(e, now) : null,
    screen: s.monitoring && s.muted && breaks.inBreak && breaks.showing ? breaks.screenModel(e.currentName(), now) : null,
    prompt: s.prompt ? {id: s.prompt.gameId, text: s.prompt.text} : null,
    watching: s.currentId,
  };
}
/** Keeps the watched tab's overlay current; sends only what changed. */
async function overlaySync(force = false) {
  const e = engine;
  if (!e) return;
  const tabId = e.s.monitoring ? e.s.currentId : null;
  if (overlayTabId !== null && overlayTabId !== tabId) {
    const old = overlayTabId;
    overlayTabId = null;
    overlayKey = '';
    void clearOverlay(old);
  }
  if (tabId === null) return;
  const model = await overlayModel(e, Date.now());
  const toasts = breaks.takeAlerts();
  const key = JSON.stringify(model);
  if (!force && key === overlayKey && overlayTabId === tabId && !toasts.length) return;
  overlayKey = key;
  overlayTabId = tabId;
  await sendOverlay(tabId, {...model, toasts});
}
async function sendOverlay(tabId, model) {
  const message = {target: 'sportswitch-overlay', model};
  try { await chrome.tabs.sendMessage(tabId, message, {frameId: 0}); return; } catch {}
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: ['overlay.js']});
    await chrome.tabs.sendMessage(tabId, message, {frameId: 0});
  } catch {
    // Some pages (the Chrome Web Store, PDF viewers) can't be drawn on; the controller still shows everything.
    overlayKey = '';
  }
}
async function clearOverlay(tabId) {
  try { await chrome.tabs.sendMessage(tabId, {target: 'sportswitch-overlay', model: null}, {frameId: 0}); } catch {}
}

// ---- Adding games and the session -------------------------------------------------------------------

/* Called from the popup on the ACTIVE game tab only. Chrome's activeTab grant
 * does not extend to other tabs, even if the extension knows their IDs. */
async function prepareCapture(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('Select a web tab to add first.');
  const tab = await chrome.tabs.get(tabId);
  if (!isGame(tab)) throw new Error('Only ordinary http:// or https:// tabs can be added. Chrome system pages cannot be captured.');
  const e = await getEngine();
  if (e.games.some(t => t.id === tabId)) return {alreadyCaptured: true, count: e.games.length};
  if (e.s.mode === 'silence' && e.games.length >= 1) throw new Error('Silence mode monitors one game. Switch to Switch mode to add more.');
  if (e.games.length >= MAX_GAMES) throw new Error('Eight games are already connected. Disable to start a different set.');
  // The capture stream is tied to a TAB, not a browser WINDOW. Each tab still needs an explicit
  // invocation of this extension to grant activeTab/tabCapture access.
  await ensureOffscreen();
  if (e.s.phase === 'off' || e.s.phase === 'error') {
    // A fresh session, leaving the model and all controls in place.
    try { await toOffscreen('STOP'); } catch {}
    engine = await freshEngine();
    engine.s.phase = 'arming';
    engine.s.message = 'Ready to add your first game.';
    watchedTabId = null;
    await persistNow();
  }
  return {alreadyCaptured: false, tabId};
}
async function startMonitoring(now) {
  const e = engine;
  e.s.phase = 'on';
  const actions = e.start(now);
  await toWorker({type: 'options', wantFeatures: e.settings.saveDetectionLog});
  if (e.settings.saveDetectionLog) void DetectionLog.open();
  await perform(actions, now);
  await breaks.startSession();
  ensureTicker();
  const flags = await readFlags();
  if (!flags.firstUsedAt) await writeFlags({firstUsedAt: Date.now()});
}
/** Too few games for the mode: stop deciding, keep the captures. */
async function pauseMonitoring() {
  const e = engine;
  await perform(e.stop(), Date.now());
  await breaks.stopSession();
  stopTicker();
  void DetectionLog.close();
}
/* Commit precisely the tab whose popup was explicitly invoked. */
let registering = false;
async function registerCapture(tabId, streamId) {
  if (registering) throw new Error('A game is already being added. Try again.');
  registering = true;
  try {
    const e = await getEngine();
    const tab = await chrome.tabs.get(tabId);
    if (!isGame(tab)) throw new Error('That tab is not an ordinary web page.');
    if (e.games.some(t => t.id === tabId)) return e.s;
    if (e.s.mode === 'silence' && e.games.length >= 1) throw new Error('Silence mode can add one game. Select Switch mode to add more.');
    if (e.games.length >= MAX_GAMES) throw new Error('Maximum of eight games already connected.');
    // Multi-window sessions are supported. Chrome grants capture per tab,
    // regardless of which normal browser window contains the stream.
    await ensureOffscreen();
    await toOffscreen('ADD_CAPTURE', {tabId, streamId});
    const detected = await readProgramTitle(tabId);
    e.addGame({...tabSummary(tab), detectedTitle: detected, manualTitle: null,
      displayTitle: detected || normalizeSportsTitle(tab.title, tab.url) || tab.title || 'Stream'});
    const count = e.games.length;
    const minimum = e.s.mode === 'silence' ? 1 : MIN_GAMES;
    e.s.phase = count >= minimum ? 'on' : 'arming';
    e.s.message = count < minimum
      ? '1 tab connected. Open the second video tab and click Add This Tab to start switching.'
      : e.s.mode === 'silence'
        ? 'Silence mode active. This game mutes during ads and unmutes when live.'
        : `Connected ${count} games. Add up to ${MAX_GAMES} any time.`;
    scheduleTitleRefresh(true);
    try {
      // The browser's direct tab audio is suppressed by tabCapture. Route all captured audio
      // through the offscreen mixer and listen only to one gain. Never change the site's video.
      for (const t of e.games) await chrome.tabs.update(t.id, {muted: false});
      if (count >= minimum && !e.s.monitoring) await startMonitoring(Date.now());
      else if (e.s.monitoring) await chrome.tabs.update(e.s.currentId, {active: true}); // keep the watched game in front
    } catch (err) {
      await disable('Failed to start capture: ' + err.message);
      throw err;
    }
    persist();
    return e.s;
  } finally { registering = false; }
}
async function captureFailed(errorMessage) {
  const e = await getEngine();
  e.s.message = `Could not add that game: ${errorMessage}. Open that game tab and click the extension again.`;
  persist();
  return e.s;
}
async function disable(why) {
  const e = await getEngine();
  await stopFullscreenAutomation(); // Do not touch native fullscreen or player layout.
  const tabs = e.games.slice();
  const index = Math.max(0, e.currentIndex());
  if (e.s.monitoring) await perform(e.stop().filter(a => a.type !== 'stopSession'), Date.now());
  await breaks.stopSession();
  stopTicker();
  void DetectionLog.close();
  if (overlayTabId !== null) { const old = overlayTabId; overlayTabId = null; overlayKey = ''; void clearOverlay(old); }
  await Promise.all(tabs.map(async t => { try { await chrome.tabs.update(t.id, {muted: true}); } catch {} }));
  if (await offscreenExists()) {
    try { await toOffscreen('STOP'); } catch (err) { console.warn('[SportsWitch] STOP:', err); }
    try { await chrome.offscreen.closeDocument(); } catch (err) { console.warn('[SportsWitch] Close:', err); }
  }
  if (tabs.length) {
    try { await manualSelect(tabs, Math.min(index, tabs.length - 1)); } catch (err) { console.warn('[SportsWitch] Audio restore:', err); }
  }
  engine = await freshEngine();
  engine.s.phase = why ? 'error' : 'off';
  engine.s.message = why || 'Disabled. Open a web video tab and click Add This Tab to start again.';
  watchedTabId = null;
  sentLabel = -1;
  await persistNow();
  // Between games now: an update waiting for the session to end installs (after this answer reaches the popup).
  setTimeout(() => void installPendingUpdate().catch(err => console.info('[SportsWitch] Update:', err.message)), 3000);
  return engine.s;
}
/* A closed game should not force all remaining games to disconnect. */
async function captureEnded(tabId) {
  const e = await getEngine();
  if (!e.games.some(t => t.id === tabId)) return;
  try {
    const previews = (await chrome.storage.session.get(PREVIEW_KEY))[PREVIEW_KEY] || {};
    delete previews[String(tabId)];
    await chrome.storage.session.set({[PREVIEW_KEY]: previews});
  } catch {}
  const now = Date.now();
  const actions = e.removeGame(tabId, now);
  const minimum = e.s.mode === 'silence' ? 1 : MIN_GAMES;
  if (e.games.length >= minimum) {
    await perform(actions, now);
    e.s.message = `Game capture ended. Continuing with ${e.games.length} games.`;
  } else {
    await perform(actions.filter(a => a.type !== 'select'), now);
    if (e.s.monitoring) await pauseMonitoring();
    e.s.phase = e.games.length ? 'arming' : 'off';
    e.s.hold = false;
    e.s.message = e.games.length === 1 ? 'One tab remains. Add another tab to resume Switch mode.'
      : 'No captured tabs remain. Open a web tab and click Add This Tab.';
    watchedTabId = null;
    if (e.games.length) {
      try { await toOffscreen('SELECT', {tabId: e.games[0].id, enabled: false, analysisMode: e.s.mode, muted: false}); } catch {}
    }
  }
  persist();
  await overlaySync();
}
/** ✕ on a row: the game leaves the lineup; its tab keeps playing, muted, as it was while it was in the lineup. */
async function removeGame(tabId) {
  const e = await getEngine();
  const game = e.games.find(g => g.id === tabId);
  if (!game) throw new Error('This tab is no longer in your lineup.');
  if (await offscreenExists()) await toOffscreen('REMOVE_CAPTURE', {tabId});
  try { await chrome.tabs.update(tabId, {muted: true}); } catch {}
  await captureEnded(tabId);
  if (engine.games.length) engine.s.message = `Removed ${game.displayTitle || game.title || 'that game'} from the lineup. Its tab is muted.`;
  persist();
  return engine.s;
}
async function selectGame(index) {
  if (!Number.isInteger(index)) throw new Error('Invalid row number');
  const e = await getEngine();
  const now = Date.now();
  await perform(e.select(index, now), now);
  persist();
  await overlaySync();
  return e.s;
}
async function selectGameById(id) {
  const e = await getEngine();
  const index = e.games.findIndex(g => g.id === id);
  if (index < 0) throw new Error('This game is no longer in your lineup.');
  return await selectGame(index);
}
// The list itself is the priority system: first row = highest priority.
async function reorderGames(ids) {
  const e = await getEngine();
  if (e.s.mode !== 'switch') throw new Error('Priority ordering is available in Switch mode.');
  e.reorder(ids);
  persist();
  return e.s;
}
async function setOperatingMode(mode) {
  if (!['switch', 'silence'].includes(mode)) throw new Error('Choose Switch or Silence mode.');
  const e = await getEngine();
  if (e.s.mode === mode) return e.s;
  await chrome.storage.local.set({[OPERATING_MODE_KEY]: mode});
  const now = Date.now();
  await perform(e.setMode(mode), now);
  const count = e.games.length, minimum = mode === 'silence' ? 1 : MIN_GAMES;
  const run = count >= minimum && (e.s.phase === 'on' || e.s.phase === 'arming');
  if (run && !e.s.monitoring) await startMonitoring(now);
  else if (!run && e.s.monitoring) {
    await pauseMonitoring();
    // Too few games for Switch mode: keep the one audible, stop analyzing it.
    if (count) try { await toOffscreen('SELECT', {tabId: e.s.currentId ?? e.games[0].id, enabled: false, analysisMode: mode, muted: false}); } catch {}
  } else if (e.s.monitoring && await offscreenExists()) {
    await toOffscreen('SELECT', {tabId: e.s.currentId, enabled: true, analysisMode: mode, muted: false});
  }
  e.s.phase = count === 0 ? 'off' : run ? 'on' : 'arming';
  e.s.message = mode === 'silence'
    ? count ? 'Silence mode: only the selected game is audible. Ads mute it; live sports unmute it.' : 'Silence mode: add one game to start.'
    : count < MIN_GAMES ? 'Switch mode: add a second game to start switching.'
      : `Switch mode: monitoring ${count} games with ranked priority and ad look-ahead.`;
  persist();
  await overlaySync();
  return e.s;
}
async function toggleHold() {
  const e = await getEngine();
  await perform(e.toggleHold(), Date.now());
  persist();
  await overlaySync();
  return e.s;
}

// ---- What the popup, controller and settings show ---------------------------------------------------

function chipFor(e, now) {
  const s = e.s;
  if (s.phase === 'error') return {text: 'Attention', tone: 'err'};
  if (!s.monitoring) return s.phase === 'arming' ? {text: 'Adding games', tone: 'warn'} : {text: 'Disabled', tone: ''};
  if (s.prompt) return {text: 'Big moment', tone: 'warn'};
  if (s.hold) return {text: 'Hold', tone: 'warn'};
  if (s.muted) return {text: breaks.radioCoversAd ? 'Ad · radio' : 'Audio muted', tone: 'ad'};
  if (e.isSettling(now)) return {text: 'Settling in', tone: 'warn'};
  return {text: 'Listening', tone: 'on'};
}
async function getStatus(windowId, activeTabId) {
  let e = await getEngine();
  if (e.s.monitoring && !(await offscreenExists())) {
    await serial(() => disable('Audio engine stopped. Click Add This Tab to restart.'));
    e = engine;
  }
  const s = e.s;
  if (s.games.length) scheduleTitleRefresh();
  const available = await gameTabs(windowId);
  // Use the tab where the popup was INVOKED, not an inferred first-window match.
  let activeTab = null;
  if (Number.isInteger(activeTabId)) {
    try {
      const candidate = await chrome.tabs.get(activeTabId);
      if (candidate.active) activeTab = candidate;
    } catch {}
  }
  const addReason = !activeTab
    ? 'Open SportsWitch from the browser window containing the stream you want to add.'
    : !isGame(activeTab)
      ? 'This is not an ordinary http:// or https:// page. Open the actual streaming page rather than a Chrome or extension page.'
      : s.games.some(t => t.id === activeTab.id)
        ? 'This tab is already in your lineup. Use its row or Watch This Game to select it.'
        : s.games.length >= MAX_GAMES
          ? 'Eight streams are connected. Disable SportsWitch to create a new lineup.'
          : s.mode === 'silence' && s.games.length >= 1
            ? 'Silence Mode monitors one stream. Select Switch Mode to add more.'
            : null;
  const now = Date.now();
  const readings = {}, rows = {};
  s.games.forEach((g, i) => {
    const st = s.status[g.id] || {};
    readings[g.id] = {liveProbability: st.liveProbability, classification: st.classification, silent: st.silent, updatedAt: st.updatedAt,
      knownAd: st.knownAd, repeated: st.repeated, breakUntil: st.breakUntil};
    rows[g.id] = Presenter.rowStatus(s, i, now);
  });
  const [flags, update] = await Promise.all([readFlags(), readUpdate()]);
  return {
    buildVersion: BUILD_VERSION, now, update: {available: update.available, updatedFrom: update.updatedFrom},
    operatingMode: s.mode, mode: s.phase, enabled: s.monitoring, hold: s.hold, silenced: s.muted, adActive: s.adActive,
    settling: e.isSettling(now), message: s.prompt ? s.prompt.text : s.message, prompt: s.prompt,
    gameTabs: s.games, currentIndex: Math.max(0, e.currentIndex()), gameReadings: readings, rows,
    lastProbability: s.lastProbability, lastClassification: s.lastClassification, lastUpdatedAt: s.lastUpdatedAt,
    adProbability: e.adProbability(), readingText: Presenter.readingText(s), readingTone: Presenter.stateTone(s, now), chip: chipFor(e, now),
    correctionsReason: s.monitoring ? null : 'Add your games first. These fix a mistake while SportsWitch is listening.',
    settings: e.settings, breaksSummary: await breaks.summary(), breakShowing: breaks.showing, radioCoversAd: breaks.radioCoversAd,
    musicLine: breaks.musicLine,
    availableGames: available.slice(0, MAX_GAMES).map(tabSummary),
    activeGameTabId: activeTab && isGame(activeTab) ? activeTab.id : null,
    canAdd: addReason === null,
    canAddReason: addReason,
    candidateSite: activeTab && isGame(activeTab) ? siteName(activeTab.url) : null,
    onboarded: flags.onboarded, lighterMotion: await lighterMotion(), supportNote: supportNoteDue(flags, now),
  };
}
/** Everything the settings sheet needs. */
async function pageData() {
  const e = await getEngine();
  await breaks.load();
  const [accounts, flags, learned, espn, commands, userSettings, logs, spotify, update, kind] = await Promise.all([
    Accounts.get(), readFlags(), chrome.storage.local.get(LEARNED_KEY), Accounts.espnSession(),
    chrome.commands.getAll(), chrome.action.getUserSettings().catch(() => ({})), DetectionLog.list().catch(() => []),
    SpotifyTab.status().catch(() => ({state: 'none'})), readUpdate(), installKind(),
  ]);
  return {
    version: BUILD_VERSION, settings: e.settings, breaks: breaks.prefs, monitoring: e.s.monitoring, mode: e.s.mode, gameCount: e.games.length,
    learnedSummary: learned[LEARNED_KEY] || null, lighterMotion: await lighterMotion(), lighterAuto: lighterAuto(),
    onboarded: flags.onboarded, support: {url: SUPPORT_URL, seen: flags.supportSeen, donated: flags.supportDonated},
    accounts: {fantasyTeam: accounts.fantasyTeam, espnSignedIn: !!(espn && espn.signedIn)}, spotify,
    shortcuts: commands.filter(c => c.name === 'mark-ad' || c.name === 'mark-game').map(c => ({name: c.name, description: c.description, shortcut: c.shortcut})),
    pinned: userSettings.isOnToolbar === true, logs, updates: {...update, kind},
  };
}
async function radioStations(genre) {
  if (!BreakData.RADIO_GENRES.includes(genre)) throw new Error('Pick a style from the list.');
  return BreakData.RadioBrowser.parse(await fetchText(BreakData.RadioBrowser.searchUrl(genre))).slice(0, 25);
}

async function incoming(msg, sender) {
  switch (msg.type) {
    case 'GET_STATUS': return await getStatus(msg.windowId, msg.activeTabId);
    case 'GET_PAGE_DATA': return await pageData();
    case 'RENAME_GAME': return await serial(() => renameGame(msg.tabId, msg.title));
    case 'OPEN_CONTROLLER': {
      // Create a real detached controller WINDOW immediately. Opening Document
      // PiP itself needs a second user activation, but that optional click can
      // now happen inside this window; the viewer's game tab is not changed.
      const url = chrome.runtime.getURL('controller.html?detached=1');
      const state = await chrome.storage.session.get('sportsWitchControllerWindowId');
      const previous = state.sportsWitchControllerWindowId;
      if (Number.isInteger(previous)) {
        try {
          const found = await chrome.windows.get(previous);
          if (found?.id === previous) {
            await chrome.windows.update(previous, {focused: true});
            return {windowId: previous, reused: true};
          }
        } catch {}
      }
      const win = await chrome.windows.create({url, type: 'popup', width: 720, height: 760, focused: true});
      if (!Number.isInteger(win?.id)) throw new Error('Chrome did not open the detached controller window.');
      await chrome.storage.session.set({sportsWitchControllerWindowId: win.id});
      return {windowId: win.id, reused: false};
    }
    case 'OPEN_PAGE': {
      if (!['help.html', 'settings.html'].includes(String(msg.page).split('#')[0])) throw new Error('Unknown page');
      await chrome.tabs.create({url: chrome.runtime.getURL(msg.page)});
      return {};
    }
    case 'GET_SETTINGS': return await readSettings();
    case 'SAVE_SETTINGS': return await serial(() => saveSettings(msg.settings));
    case 'RESET_SETTINGS': return await serial(restoreRecommended);
    case 'SET_OPERATING_MODE': return await serial(() => setOperatingMode(msg.operatingMode));
    case 'TOGGLE_HOLD': return await serial(toggleHold);
    case 'REORDER_GAMES': return await serial(() => reorderGames(msg.ids));
    case 'CAPTURE_PREVIEW': return await capturePreview(msg.tabId);
    case 'GET_PREVIEW': return await getPreview(msg.tabId);
    case 'PREPARE_CAPTURE': return await serial(() => prepareCapture(msg.tabId));
    case 'REGISTER_CAPTURE': return await serial(() => registerCapture(msg.tabId, msg.streamId));
    case 'CAPTURE_FAILED': return await serial(() => captureFailed(msg.error));
    case 'DISABLE': return await serial(() => disable());
    case 'SELECT_GAME': return await serial(() => selectGame(msg.index));
    case 'REMOVE_GAME': return await serial(() => removeGame(msg.tabId));
    case 'MARK_AD': return await serial(markAd);
    case 'MARK_LIVE': return await serial(markLive);
    case 'READING': await serial(() => onReading(msg.reading)); return {received: true};
    case 'LEARNED_SUMMARY': await storeLearnedSummary(msg); return {};
    case 'AUDIO_ERROR':
      console.info('[SportsWitch] Audio analysis:', msg.error);
      await serial(() => disable('SportsWitch stopped listening because its sound analysis ran into a problem. Add your games again to start over.'));
      return {received: true};
    case 'CAPTURE_ENDED': await serial(() => captureEnded(msg.tabId)); return {received: true};
    case 'RADIO_EVENT': await breaks.onRadioEvent(msg); return {};
    case 'RESET_LEARNING': return await resetLearning();
    case 'SET_FLAGS': return await setFlags(msg.flags || {});
    // Updates
    case 'CHECK_UPDATES': return await checkForUpdates();
    case 'INSTALL_UPDATE': {
      const u = await readUpdate();
      if (!u.available) return u;
      await writeUpdate({pending: u.available});
      return await installPendingUpdate();
    }
    case 'SET_AUTO_UPDATE': return await writeUpdate({auto: !!msg.on});
    case 'UPDATE_SEEN': return await writeUpdate({updatedFrom: null});
    case 'OPEN_UPDATE_PAGE': {
      const page = {changes: 'blob/main/CHANGELOG.md', privacy: 'blob/main/PRIVACY.md', release: 'releases/latest'}[msg.what] || 'releases/latest';
      await chrome.tabs.create({url: `https://github.com/${UPDATE_REPO}/${page}`});
      return {};
    }
    // Customize your ad break
    case 'SAVE_BREAKS': {
      const prefs = await breaks.updatePrefs(msg.changes || {});
      if (msg.changes && msg.changes.radioStation && msg.changes.radioStation.id) {
        void fetchText(BreakData.RadioBrowser.clickUrl(msg.changes.radioStation.id)).catch(() => {});
      }
      return prefs;
    }
    case 'PREVIEW_BREAK': await breaks.preview(25); return {};
    case 'GET_BREAK_VIEW': {
      await breaks.load();
      const e = await getEngine();
      return {showing: breaks.showing, light: await lighterMotion(), model: breaks.screenModel(e.s.games.length ? e.currentName() : 'Your game')};
    }
    case 'HIDE_BREAK_SCREEN': breaks.hideScreen(); return {};
    case 'OVERLAY_WATCH': return await serial(() => selectGameById(msg.gameId));
    case 'RADIO_STATIONS': return await radioStations(msg.genre);
    case 'ESPN_OPEN_SIGN_IN': await chrome.tabs.create({url: 'https://www.espn.com/login'}); return {};
    case 'ESPN_LEAGUES': return await Accounts.espnLeagues();
    case 'ESPN_LEAGUE_TEAMS': return await Accounts.espnLeagueTeams(msg.leagueId);
    case 'ESPN_CHOOSE_TEAM': {
      const t = msg.team || {};
      await Accounts.set({fantasyTeam: {leagueId: String(t.leagueId), teamId: Number(t.teamId), leagueName: String(t.leagueName || ''), teamName: String(t.teamName || '')}});
      await breaks.updatePrefs({fantasyCard: true});
      void breaks.fetchFantasy();
      return {};
    }
    case 'ESPN_FORGET':
      await Accounts.set({fantasyTeam: null});
      breaks.fantasy = null;
      breaks.fantasyNote = null;
      return {};
    case 'SPOTIFY_SHOW': return await SpotifyTab.show();
    case 'SPOTIFY_TRY': await breaks.load(); return await breaks.trySpotify();
    // Detection logs
    case 'LOGS_LIST': return await DetectionLog.list();
    case 'LOGS_CSV': return await DetectionLog.csv(msg.id);
    case 'LOGS_CLEAR': await DetectionLog.clear(); return {};
    default: throw new Error('Unknown request: ' + msg.type);
  }
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target === 'offscreen' || msg.target === 'sportswitch-overlay') return false;
  if (msg.target === 'service_worker' || !msg.target) {
    incoming(msg, sender).then(data => respond({ok: true, data}), error => {
      console.error('[SportsWitch]', msg.type, error);
      respond({ok: false, error: error.message});
    });
    return true;
  }
  return false;
});
// "That's an ad" / "That's the game" from the keyboard (chrome://extensions/shortcuts).
chrome.commands.onCommand.addListener(command => {
  const work = command === 'mark-ad' ? markAd : command === 'mark-game' ? markLive : null;
  if (work) void serial(work).catch(err => console.info('[SportsWitch] Shortcut:', err.message));
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId === overlayTabId && info.status === 'loading') overlayKey = ''; // the page reloaded: draw the overlay again
  if (!info.url || !engine) return;
  const g = engine.games.find(x => x.id === tabId);
  if (!g) return;
  void serial(async () => {
    const before = pageKey(g.url);
    engine.updateGame(tabId, {url: info.url, site: siteName(info.url), title: tab.title || g.title});
    if (before === pageKey(info.url)) return persist();
    // A different channel or game in the same tab: listen to it afresh.
    const now = Date.now();
    await perform(engine.onTabNavigated(tabId, now), now);
    scheduleTitleRefresh(true);
    persist();
    await overlaySync(true);
  });
});
chrome.runtime.onInstalled.addListener(details => void (async () => {
  await chrome.storage.session.remove(STATE_KEY);
  engine = null;
  // Carry 4.1.x choices into the 4.2 settings.
  await chrome.storage.local.set({[SETTINGS_KEY]: migrateSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY])});
  if (details.reason === 'update') {
    for (const step of UPDATE_STEPS) if (newerVersion(step.version, details.previousVersion)) await step.run();
    if (newerVersion(BUILD_VERSION, details.previousVersion)) await writeUpdate({updatedFrom: details.previousVersion, available: null, pending: null, error: null});
  }
  const flags = await readFlags();
  if (!flags.firstUsedAt) await writeFlags({firstUsedAt: Date.now()});
  scheduleUpdateChecks();
})());
chrome.runtime.onStartup.addListener(() => {
  void chrome.storage.session.remove(STATE_KEY);
  scheduleUpdateChecks();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === UPDATE_ALARM) void checkForUpdates({install: true}).catch(err => console.info('[SportsWitch] Update check:', err.message));
});
// Chrome downloaded a Web Store update: install it now, or when the session ends.
chrome.runtime.onUpdateAvailable.addListener(details => void (async () => {
  await writeUpdate({pending: String(details.version)});
  await installPendingUpdate();
})().catch(err => console.info('[SportsWitch] Update:', err.message)));
scheduleUpdateChecks();
