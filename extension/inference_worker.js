/* SportsWitch 4.2.0 analysis worker: a reading about every second for each captured tab.
 * One TabAnalyzer per tab, all sharing what this browser has learned: the remembered ads, the watched
 * game's recent audio history and the personal model. They are kept in IndexedDB (the extension's own
 * storage on this computer), saved every five minutes and when SportsWitch stops.
 */
'use strict';
importScripts('classifier.js', 'learning.js');
const L = self.SportsWitchLearning;
const DB_NAME = 'sportswitch-learning', STORE = 'blobs';
const SAVE_EVERY_MS = 5 * 60000;
let ready = null;
let assets = null, fingerprints = null, personal = null;
let sampleRate = 48000, selectedTabId = null, wantFeatures = false, lastSave = 0;
const tabs = new Map();

function post(message) { postMessage(message); }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readBlob(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function writeBlobs(entries) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      for (const [key, value] of entries) tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function load(what, read) {
  try {
    const buffer = await readBlob(what);
    if (buffer) read(buffer);
  } catch (err) {
    console.warn(`[SportsWitch] Ignoring unreadable ${what}:`, err.message);
  }
}

async function init(rate) {
  sampleRate = rate;
  const [forest, constants] = await Promise.all([
    fetch('model.json').then(r => { if (!r.ok) throw new Error('Model missing'); return r.json(); }),
    fetch('spectral_constants.json').then(r => { if (!r.ok) throw new Error('Spectral data missing'); return r.json(); }),
  ]);
  if (!Array.isArray(forest.trees) || forest.trees.length < 1 || forest.trees.length > 2000 || forest.n_features !== 46)
    throw new Error('Unexpected model dimensions');
  if (forest.treeWeights && (!Array.isArray(forest.treeWeights) || forest.treeWeights.length !== forest.trees.length ||
      forest.treeWeights.some(w => !Number.isFinite(w) || w <= 0))) throw new Error('Invalid model weights');
  assets = {forest, constants};
  fingerprints = new L.AdFingerprints();
  personal = new L.PersonalModel();
  await load('fingerprints', b => fingerprints.load(b));
  await load('history', b => fingerprints.loadHistory(b));
  await load('personal', b => personal.load(b));
  lastSave = Date.now();
  summary();
}

function summary() {
  post({type: 'summary', ads: fingerprints.entryCount, game: personal.gameExamples, ad: personal.adExamples, adapted: personal.isAdapted});
}

async function save(parts = ['fingerprints', 'history', 'personal']) {
  if (!fingerprints) return;
  const entries = [];
  if (parts.includes('fingerprints')) entries.push(['fingerprints', fingerprints.save()]);
  if (parts.includes('history')) entries.push(['history', fingerprints.saveHistory()]);
  if (parts.includes('personal')) entries.push(['personal', personal.save()]);
  try {
    await writeBlobs(entries);
  } catch (err) {
    console.warn('[SportsWitch] Could not save what was learned:', err.message);
  }
  summary();
}

function analyzer(tabId) {
  let a = tabs.get(tabId);
  if (!a) {
    a = new L.TabAnalyzer(tabId, sampleRate, {constants: assets.constants, forest: assets.forest, fingerprints, personal, clock: () => Date.now()});
    a.setSelected(tabId === selectedTabId);
    tabs.set(tabId, a);
  }
  return a;
}

function onAudio(tabId, pcm) {
  const a = analyzer(tabId);
  const r = a.accept(pcm);
  if (r) {
    post({type: 'reading', reading: {
      tabId, selected: a.selected, liveProbability: r.liveProbability, adjustedLive: r.adjustedLive, energy: r.energy,
      zeroFraction: r.zeroFraction, splice: r.splice, windowSeconds: r.windowSeconds, time: r.time,
      knownAd: r.knownAd ? {entryId: r.knownAd.entryId, bitErrorRate: r.knownAd.bitErrorRate} : null,
      repeat: r.repeat ? {lagSeconds: r.repeat.lagSeconds, bitErrorRate: r.repeat.bitErrorRate, earlier: r.repeat.earlier} : null,
      features: wantFeatures && a.selected ? r.features : null,
    }});
  }
  // What was learned survives a crash or a closed browser, not only a clean Disable.
  if (Date.now() - lastSave > SAVE_EVERY_MS) {
    lastSave = Date.now();
    void save();
  }
}

function select(tabId) {
  selectedTabId = tabId;
  for (const [id, a] of tabs) a.setSelected(id === tabId);
}

function learning(command) {
  switch (command.op) {
    case 'begin': fingerprints.beginLearning(command.secondsBack); break;
    case 'end': fingerprints.endLearning(command.trimSeconds); break;
    case 'forget': fingerprints.forgetRecent(); break;
    case 'label': personal.label(command.from, command.to, command.live, command.weight, !!command.onlyWhereForestAgrees); return;
    case 'currentLabel': fingerprints.currentLabel = command.value; return;
    case 'labelRecent': fingerprints.labelRecent(command.seconds, command.label); return;
    default: return;
  }
  void save(['fingerprints']);
}

self.onmessage = async event => {
  const m = event.data || {};
  try {
    if (m.type === 'init') {
      ready = init(m.sampleRate);
      await ready;
      post({type: 'ready', id: m.id});
      return;
    }
    await ready;
    switch (m.type) {
      case 'audio': onAudio(m.tabId, m.pcm); break;
      case 'select': select(m.tabId); break;
      case 'flush': tabs.get(m.tabId)?.flush(); break;
      case 'remove': tabs.delete(m.tabId); if (selectedTabId === m.tabId) selectedTabId = null; break;
      case 'options': wantFeatures = !!m.wantFeatures; break;
      case 'learning': for (const command of m.commands || []) learning(command); break;
      case 'reset':
        fingerprints.clearAll();
        personal.reset();
        await save();
        post({type: 'done', id: m.id});
        break;
      case 'save': await save(); post({type: 'done', id: m.id}); break;
      case 'stop':
        fingerprints.endLearning();
        personal.flush();
        await save();
        post({type: 'done', id: m.id});
        break;
    }
  } catch (err) {
    post({type: 'error', id: m.id, error: err && err.message || String(err)});
  }
};
