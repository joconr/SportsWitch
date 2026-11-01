/* SportsWitch 4.2.0 audio engine.
 * Captured games are analyzed even when inaudible. Audio from all tabs stays connected to a silent
 * analysis tap that streams it to the analysis worker, which reads each tab about once a second.
 * Only the watched game is connected to the speakers at gain 1. Muting is gain-only, so detection
 * keeps hearing the ad and notices the game coming back. The ad-break radio also plays from here.
 */
'use strict';
const SAMPLE_RATE = 48000;
/** The ad under the radio when it isn't silenced: about what Android's "duck" leaves. */
const DUCK_GAIN = 0.2;
const captures = new Map();
let audioContext = null;
let whooshBufferPromise = null;
const WHOOSH_URL = chrome.runtime.getURL('assets/whoosh.wav');
async function loadWhoosh() {
  if (!audioContext) return null;
  if (!whooshBufferPromise) {
    whooshBufferPromise = (async () => {
      const response = await fetch(WHOOSH_URL);
      if (!response.ok) throw Error('Could not load whoosh sound');
      const bytes = await response.arrayBuffer();
      return await audioContext.decodeAudioData(bytes);
    })().catch(err => { whooshBufferPromise = null; throw err; });
  }
  return await whooshBufferPromise;
}
async function playSwitchSound() {
  if (!audioContext || audioContext.state === 'closed') return {played: false, reason: 'Audio not initialized'};
  await audioContext.resume();
  const buffer = await loadWhoosh();
  if (!buffer) return {played: false};
  const clip = audioContext.createBufferSource();
  const output = audioContext.createGain();
  output.gain.value = 0.55;
  clip.buffer = buffer;
  clip.connect(output); output.connect(audioContext.destination);
  clip.onended = () => { try { clip.disconnect(); output.disconnect(); } catch {} };
  clip.start();
  return {played: true};
}

let silence = null;
let selectedTabId = null;
let enabled = false;
let analysisMode = 'switch';
let muted = false;
let ducked = false;
let worker = null;
let workerReady = null;
const replies = new Map();
let nextReply = 1;
// On-demand stills taken from the existing tabCapture video track.
// No screenshot polling while the popup is closed.
const frameCache = new Map();
const MIN_FRAME_INTERVAL_MS = 1200;
const PREVIEW_WIDTH = 420;

function say(target, type, other = {}) {
  try { chrome.runtime.sendMessage({target, type, ...other}).catch(() => {}); } catch {}
}
/** Sends the worker a request and waits for its 'done' reply. */
function ask(message, timeoutMs = 5000) {
  if (!worker) return Promise.resolve(null);
  const id = nextReply++;
  return new Promise(resolve => {
    const timer = setTimeout(() => { replies.delete(id); resolve(null); }, timeoutMs);
    replies.set(id, value => { clearTimeout(timer); resolve(value); });
    worker.postMessage({...message, id});
  });
}
function startWorker() {
  if (worker) return;
  worker = new Worker('inference_worker.js');
  worker.onmessage = event => {
    const m = event.data || {};
    if (m.id && replies.has(m.id)) {
      const reply = replies.get(m.id);
      replies.delete(m.id);
      reply(m);
    }
    if (m.type === 'reading' && enabled) say('service_worker', 'READING', {reading: m.reading});
    else if (m.type === 'summary') say('service_worker', 'LEARNED_SUMMARY', {ads: m.ads, game: m.game, ad: m.ad, adapted: m.adapted});
    else if (m.type === 'error' && enabled) say('service_worker', 'AUDIO_ERROR', {error: m.error || 'Audio classification failed'});
  };
  worker.onerror = event => {
    say('service_worker', 'AUDIO_ERROR', {error: 'Analysis worker: ' + (event.message || 'unexpected error')});
  };
}
async function ensureAudio() {
  if (audioContext) return;
  // A fixed 48 kHz keeps the resampler to a single kernel; Chrome converts for the speakers.
  try { audioContext = new AudioContext({latencyHint: 'interactive', sampleRate: SAMPLE_RATE}); }
  catch { audioContext = new AudioContext({latencyHint: 'interactive'}); }
  silence = audioContext.createGain(); silence.gain.value = 0;
  silence.connect(audioContext.destination);
  startWorker();
  workerReady = ask({type: 'init', sampleRate: audioContext.sampleRate}, 30000);
  await audioContext.resume();
  void loadWhoosh().catch(err => console.info('[SportsWitch] Optional switch sound unavailable:', err.message));
}
function addSamples(tabId, event) {
  if (!enabled || !worker) return;
  // Silence mode evaluates only its single active game. All other captures
  // remain connected but do not consume analysis time.
  if (analysisMode === 'silence' && tabId !== selectedTabId) return;
  const pcm = Float32Array.from(event.inputBuffer.getChannelData(0));
  worker.postMessage({type: 'audio', tabId, pcm}, [pcm.buffer]);
}
function gainFor(id) {
  if (id !== selectedTabId) return 0;
  if (!muted) return 1;
  return ducked ? DUCK_GAIN : 0;
}
function applyGains(immediate = false) {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  for (const [id, rec] of captures) {
    const g = rec.gain.gain;
    g.cancelScheduledValues(now);
    // A short glide avoids a click without letting the ad be heard.
    if (immediate) g.setValueAtTime(gainFor(id), now);
    else g.setTargetAtTime(gainFor(id), now, 0.012);
  }
}
async function addCapture(tabId, streamId) {
  await ensureAudio();
  if (captures.has(tabId)) return {captured: true};
  // Capture audio and, when Chrome permits it, a low-resolution video track.
  // This lets the popup preview BACKGROUND games without activating them.
  // If combined capture fails, immediately fall back to the original audio-only
  // path so the classifier and audio switching retain priority.
  const audioConstraints = {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId}};
  let stream;
  let previewError = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId}}
    });
  } catch (err) {
    previewError = err.message || String(err);
    console.warn('[SportsWitch] Tab video unavailable; retrying audio only:', previewError);
    stream = await navigator.mediaDevices.getUserMedia({audio: audioConstraints, video: false});
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('Tab capture returned no audio (possibly protected playback)');
  }
  const source = audioContext.createMediaStreamSource(stream);
  const gain = audioContext.createGain(); gain.gain.value = 0;
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const rec = {stream, source, gain, processor, video: null, previewError};
  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length) {
    // Request a small preview feed if Chrome permits it. If these optional
    // constraints cannot be applied, leave video as-is; audio is unaffected.
    videoTracks[0].applyConstraints({frameRate: {ideal: 2, max: 3},
      width: {ideal: 640}, height: {ideal: 360}}).catch(() => {});
    // The captured MediaStream is an extension-owned source, not a
    // cross-origin <video> element from the site. It can be sampled to a
    // canvas where permitted; copyrighted/DRM video may still be blank.
    const video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream(videoTracks);
    video.style.display = 'none';
    document.body.append(video);
    rec.video = video;
    video.play().catch(err => { rec.previewError = err.message || String(err); });
    videoTracks.forEach(track => track.addEventListener('ended', () => {
      // Losing video must NOT interrupt analysis or audio output.
      rec.previewError = 'Chrome stopped video capture; audio monitoring continues.';
      if (rec.video) { rec.video.pause(); rec.video.srcObject = null; rec.video.remove(); rec.video = null; }
      frameCache.delete(tabId);
    }, {once: true}));
  }
  captures.set(tabId, rec);
  // Two separate graph branches: speakers and silent classification tap.
  source.connect(gain); gain.connect(audioContext.destination);
  source.connect(processor); processor.connect(silence);
  processor.onaudioprocess = event => addSamples(tabId, event);
  const end = () => {
    if (captures.get(tabId) !== rec) return;
    captures.delete(tabId);
    frameCache.delete(tabId);
    if (rec.video) { rec.video.pause(); rec.video.srcObject = null; rec.video.remove(); rec.video = null; }
    try { processor.onaudioprocess = null; source.disconnect(); gain.disconnect(); processor.disconnect(); } catch {}
    worker?.postMessage({type: 'remove', tabId});
    say('service_worker', 'CAPTURE_ENDED', {tabId});
  };
  stream.getAudioTracks().forEach(track => track.addEventListener('ended', end, {once: true}));
  if (!enabled && captures.size === 1) gain.gain.value = 1;
  return {captured: true, tabId, previewAvailable: !!rec.video, previewError};
}
/** Releases one tab's capture (the viewer removed it from the lineup); the others carry on. */
function removeCapture(tabId) {
  const rec = captures.get(tabId);
  if (!rec) return {removed: false};
  captures.delete(tabId);
  frameCache.delete(tabId);
  if (rec.video) { rec.video.pause(); rec.video.srcObject = null; rec.video.remove(); rec.video = null; }
  try { rec.processor.onaudioprocess = null; rec.source.disconnect(); rec.gain.disconnect(); rec.processor.disconnect(); } catch {}
  rec.stream.getTracks().forEach(track => track.stop());
  worker?.postMessage({type: 'remove', tabId});
  return {removed: true};
}
async function grabFrame(tabId) {
  const rec = captures.get(tabId);
  if (!rec) return {available: false, reason: 'Game capture not connected.'};
  if (!rec.video) return {available: false, reason: rec.previewError || 'Only audio is captured for this game.'};
  const video = rec.video;
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return {available: false, reason: 'Waiting for the video stream to produce frames.'};
  }
  const now = Date.now();
  const cached = frameCache.get(tabId);
  if (cached && now - cached.updatedAt < MIN_FRAME_INTERVAL_MS) return cached;
  const width = Math.min(PREVIEW_WIDTH, video.videoWidth);
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) return {available: false, reason: 'Could not create preview image.'};
  context.drawImage(video, 0, 0, width, height);
  // Avoid replacing a useful cached frame with fully black protected playback.
  // Sample only 12x7 spots, without a full readback every request.
  const pixels = context.getImageData(0, 0, width, height).data;
  let total = 0, bright = 0;
  for (let y = 1; y < 8; y++) for (let x = 1; x < 13; x++) {
    const index = (Math.floor(y * height / 9) * width + Math.floor(x * width / 14)) * 4;
    const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
    total += r + g + b;
    if (Math.max(r, g, b) > 35) bright++;
  }
  if (bright < 2 && total < 300) return {available: false, reason: 'Video is black or protected (DRM).'};
  const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: .64});
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  for (let i = 0; i < buffer.length; i += 8192) {
    chunks.push(String.fromCharCode(...buffer.subarray(i, i + 8192)));
  }
  const frame = {available: true, source: 'live', dataUrl: 'data:image/jpeg;base64,' + btoa(chunks.join('')),
    updatedAt: Date.now()};
  frameCache.set(tabId, frame);
  return frame;
}

async function select(tabId, run, mode = 'switch', mute = false) {
  if (!captures.has(tabId)) throw new Error('Selected tab is not audio-captured');
  await audioContext.resume();
  if (!['switch', 'silence'].includes(mode)) throw new Error('Invalid operating mode');
  analysisMode = mode;
  selectedTabId = tabId;
  enabled = run;
  // Speaker-only silence is available in both Silence mode and Switch mode's
  // all-games-on-ads fallback. Classification continues on a separate tap.
  muted = Boolean(mute);
  ducked = false;
  applyGains(true);
  // The watched game is the one learned from and checked for audio that aired before.
  worker?.postMessage({type: 'select', tabId});
  return {selectedTabId: tabId, enabled, analysisMode, muted};
}
async function setAudio(mute, duck) {
  if (!selectedTabId || !enabled)
    throw new Error('No selected game is actively monitoring audio');
  if (!captures.get(selectedTabId)) throw new Error('Selected game capture no longer exists');
  // Gain-only mute: NEVER tab.muted, pause the source, or mute its HTML video,
  // because any of those can stop the audio reaching our classifier.
  muted = Boolean(mute);
  ducked = muted && Boolean(duck);
  applyGains();
  return {muted, ducked};
}

// ---- Ad-break radio --------------------------------------------------------------------------------

/** Each 10% step of the music volume is 3 dB: from 100% (full) down to 10% (-27 dB). */
function radioGain(percent) { return Math.pow(10, (Math.min(100, Math.max(0, percent)) - 100) * 0.3 / 20); }
const FADE_MS = 1500, FADE_STEPS = 15;
let radio = null;
function radioEvent(event, more = {}) { say('service_worker', 'RADIO_EVENT', {event, ...more}); }
function fadeTo(level, then) {
  const r = radio;
  if (!r) return;
  clearInterval(r.fade);
  const start = r.audio.volume;
  let step = 0;
  r.fade = setInterval(() => {
    step++;
    r.audio.volume = Math.min(1, Math.max(0, start + (level - start) * step / FADE_STEPS));
    if (step >= FADE_STEPS) { clearInterval(r.fade); r.fade = null; if (then) then(); }
  }, FADE_MS / FADE_STEPS);
}
function radioRelease() {
  const r = radio;
  if (!r) return;
  radio = null;
  clearInterval(r.fade);
  try { r.audio.pause(); r.audio.removeAttribute('src'); r.audio.load(); } catch {}
}
function radioFailed(audio) {
  if (!radio || radio.audio !== audio) return;
  const station = radio.station;
  radioRelease();
  radioEvent('failed', {stationId: station.id, line: `Couldn't play ${station.name}`});
}
/** Plays [station] faded in to the music volume; says when it is actually playing, or that it failed. */
function radioPlay(station, volume) {
  if (radio && radio.station.url === station.url) {
    radio.stopping = false;
    radio.target = radioGain(volume);
    if (radio.playing) fadeTo(radio.target);
    return {playing: radio.playing};
  }
  radioRelease();
  const audio = new Audio();
  audio.preload = 'none';
  audio.volume = 0;
  radio = {audio, station, target: radioGain(volume), fade: null, stopping: false, playing: false};
  radioEvent('state', {line: `Tuning in ${station.name}…`});
  audio.addEventListener('playing', () => {
    if (!radio || radio.audio !== audio || radio.playing) return;
    radio.playing = true;
    fadeTo(radio.target);
    radioEvent('playing', {stationId: station.id, line: `♪ ${station.name}`});
  });
  for (const type of ['error', 'ended']) audio.addEventListener(type, () => radioFailed(audio));
  audio.src = station.url;
  audio.play().catch(() => radioFailed(audio));
  return {playing: false};
}
/** Fades out, then releases the stream. */
function radioStop() {
  if (!radio) return {stopped: true};
  const r = radio;
  r.stopping = true;
  if (!r.playing) { radioRelease(); radioEvent('state', {line: null}); return {stopped: true}; }
  fadeTo(0, () => { if (radio === r) { radioRelease(); radioEvent('state', {line: null}); } });
  return {stopped: true};
}
function radioVolume(volume) {
  if (!radio) return {};
  radio.target = radioGain(volume);
  if (radio.playing && !radio.stopping) fadeTo(radio.target);
  return {};
}

async function stop() {
  // Save what was learned before the worker goes.
  if (worker) await ask({type: 'stop'}, 5000);
  enabled = false; selectedTabId = null; analysisMode = 'switch'; muted = false; ducked = false;
  radioRelease();
  for (const rec of captures.values()) {
    if (rec.video) { rec.video.pause(); rec.video.srcObject = null; rec.video.remove(); rec.video = null; }
    try { rec.processor.onaudioprocess = null; rec.source.disconnect(); rec.gain.disconnect(); rec.processor.disconnect(); } catch {}
    rec.stream.getTracks().forEach(track => track.stop());
  }
  captures.clear(); frameCache.clear();
  if (silence) { try { silence.disconnect(); } catch {} }
  if (audioContext) { try { await audioContext.close(); } catch {} }
  if (worker) { worker.terminate(); worker = null; }
  audioContext = null; silence = null; whooshBufferPromise = null; workerReady = null;
  return {stopped: true};
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'PING': return {alive: true, capturedIds: [...captures.keys()], enabled, selectedTabId, analysisMode, muted};
      case 'ADD_CAPTURE': return await addCapture(msg.tabId, msg.streamId);
      case 'REMOVE_CAPTURE': return removeCapture(msg.tabId);
      case 'GRAB_FRAME': return await grabFrame(msg.tabId);
      case 'SELECT': return await select(msg.tabId, Boolean(msg.enabled), msg.analysisMode, msg.muted);
      case 'SET_AUDIO': return await setAudio(msg.muted, msg.ducked);
      case 'PLAY_SWITCH_SOUND': return await playSwitchSound();
      case 'WORKER':
        if (workerReady) await workerReady;
        if (msg.wait) return await ask(msg.message, 15000);
        worker?.postMessage(msg.message);
        return {};
      case 'RADIO_PLAY': return radioPlay(msg.station, msg.volume);
      case 'RADIO_STOP': return radioStop();
      case 'RADIO_VOLUME': return radioVolume(msg.volume);
      case 'STOP': return await stop();
      default: throw new Error('Unknown offscreen request ' + msg.type);
    }
  })().then(data => respond({ok: true, data}), err => respond({ok: false, error: err.message}));
  return true;
});
