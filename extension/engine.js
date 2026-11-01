/*
 * SportsWitch 4.2.0 decisions, free of Chrome APIs so they can be tested with a fake clock.
 *
 * The Android app's detection, applied to every captured tab:
 * - Readings arrive about every second per tab and update that tab's running ad-break probability
 *   (BreakTracker). An ad is confirmed once it reaches "Act on an ad at" and is over once it falls to
 *   "Back to the game below".
 * - Splices, learned ads and audio that aired before are strong evidence; "That's an ad" and "That's
 *   the game" pin the watched game's belief and lean on it for a minute.
 * - The engine decides what the personal model learns from: corrections, recognised ads and the middle
 *   of long undisputed stretches of game.
 *
 * Chrome's swap model is unchanged: every tab in the lineup is heard at once, so on a confirmed ad
 * Switch mode moves to the highest-ranked game that is live (else uncertain, else unheard), never to
 * one on an ad, and a higher-ranked game takes back over once it is clearly live again (with "Return
 * to higher-priority games" off, the game it moved to stays until its own ad or the viewer's pick).
 * A game left for an ad is presumed on its break until its own audio says it's back, or, when it
 * can't be heard, until the typical break has passed. Silence mode mutes the one game during ads.
 *
 * Every mutating call returns the side effects for the caller to perform.
 */
(function (root) {
  'use strict';
  const NEVER = -1e15;
  const SILENT_ENERGY = 0.0003;
  const MAX_GAMES = 8;
  const MAX_RECHECK_SECONDS = 300;

  // ---- Settings -----------------------------------------------------------------------------------

  /** The Android app's settings, plus Chrome's own fullscreen option. */
  const DEFAULT_SETTINGS = Object.freeze({
    muteCertainty: 90,          // act on an ad (mute or switch) once the ad-break probability reaches this
    releaseCertainty: 50,       // back to the game once it falls to this
    breakEstimateSeconds: 150,  // how long a game left for an ad is presumed on its break
    recheckSeconds: 45,         // wait before trying a game again that was still on its break
    settleSeconds: 8,           // a newly selected game's sound isn't acted on for this long
    autoMuteWhenNoGame: true,
    followBigMoments: false,    // switch to a lineup game in the red zone or a close finish
    returnToPriority: true,
    switchWhoosh: true,
    showOverlay: true,          // status pill over the game
    learnAds: true,             // fingerprints, repeats and the personal model
    saveDetectionLog: false,
    autoFullscreenOnSwitch: false,
  });
  const BOOLEAN_SETTINGS = ['autoMuteWhenNoGame', 'followBigMoments', 'returnToPriority', 'switchWhoosh', 'showOverlay',
    'learnAds', 'saveDetectionLog', 'autoFullscreenOnSwitch'];

  function validateSettings(value) {
    const s = {...DEFAULT_SETTINGS, ...(value || {})};
    const integer = (key, lo, hi, message) => {
      if (!Number.isInteger(s[key]) || s[key] < lo || s[key] > hi) throw new Error(message);
    };
    integer('muteCertainty', 60, 99, 'Ad certainty to act must be between 60% and 99%.');
    if (!Number.isInteger(s.releaseCertainty) || s.releaseCertainty < 10 || s.releaseCertainty > 90 || s.releaseCertainty >= s.muteCertainty)
      throw new Error('Ad certainty to return must be 10–90% and below the certainty to act.');
    integer('breakEstimateSeconds', 30, 600, 'Break estimate must be between 30 and 600 seconds.');
    integer('recheckSeconds', 15, 300, 'Recheck delay must be between 15 and 300 seconds.');
    integer('settleSeconds', 3, 20, 'Settle delay must be between 3 and 20 seconds.');
    for (const key of BOOLEAN_SETTINGS) if (typeof s[key] !== 'boolean') throw new Error(`Invalid ${key} setting.`);
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = s[key];
    return out;
  }

  /** 4.1.x settings carried what still applies: the fallback mute, whoosh and fullscreen choices. */
  function migrateSettings(stored) {
    if (!stored || typeof stored !== 'object') return {...DEFAULT_SETTINGS};
    if ('muteCertainty' in stored) {
      try { return validateSettings(stored); } catch { return {...DEFAULT_SETTINGS}; }
    }
    const carried = {...DEFAULT_SETTINGS};
    if (typeof stored.autoMuteWhenNoGame === 'boolean') carried.autoMuteWhenNoGame = stored.autoMuteWhenNoGame;
    if (typeof stored.switchWhooshEnabled === 'boolean') carried.switchWhoosh = stored.switchWhooshEnabled;
    if (typeof stored.autoFullscreenOnSwitch === 'boolean') carried.autoFullscreenOnSwitch = stored.autoFullscreenOnSwitch;
    return carried;
  }

  function classify(settings, adProbability) {
    if (adProbability + 1e-10 >= settings.muteCertainty / 100) return 'Commercial';
    if (adProbability <= settings.releaseCertainty / 100 + 1e-10) return 'Live';
    return 'Uncertain';
  }
  const LABELS = {Live: 'Live', Commercial: 'Ad', Uncertain: 'Uncertain'};

  /** Where a training label came from, and how much the personal model trusts it. */
  const LABEL_WEIGHT = {viewer: 1.0, recognised: 0.6, auto: 0.25};

  // ---- Break tracker ------------------------------------------------------------------------------

  /*
   * Running belief that an ad break is on: a two-state (game / break) forward filter over the
   * one-second readings, replacing "N ad readings in a row".
   *
   * Breaks are rare and last minutes, so one stray ad-like reading barely moves the belief, and weak
   * evidence (a reading near 50%) needs many seconds to add up. A splice makes a change of segment likely
   * for a moment, so the readings right after it decide quickly. A recognised ad or audio that aired
   * before is strong evidence on its own. After "That's an ad", game-like readings count for a quarter
   * for a minute unless a splice suggests the segment changed; "That's the game" works the other way.
   * Parameters were tuned by the Android app on real YouTube TV sessions while still acting within
   * about three seconds on clear evidence.
   */
  const START = 0.02, CEILING = 0.98;
  const BREAK_HAZARD = 1 / 600, GAME_HAZARD = 1 / 25, SPLICE_HAZARD = 0.2, SPLICE_WINDOW_MS = 2500;
  const MAX_READING_EVIDENCE = 3, KNOWN_AD_EVIDENCE = 6, REPEAT_EVIDENCE = 5;
  const VIEWER_DISCOUNT = 0.25, VIEWER_RELEASE_WINDOW_MS = 10000, VIEWER_HOLD_MS = 60000;
  const Tracker = {
    create() { return {p: START, lastSpliceAt: NEVER, viewerAdUntil: NEVER, viewerGameUntil: NEVER}; },
    reset(t) { t.p = START; t.lastSpliceAt = NEVER; t.viewerAdUntil = NEVER; t.viewerGameUntil = NEVER; },
    /** Folds in one reading; [live] is calibrated so 0.5 means no opinion. Returns the ad-break probability. */
    update(t, now, live, splice, knownAd = false, airedBefore = 0) {
      if (splice) t.lastSpliceAt = now;
      const nearSplice = now - t.lastSpliceAt <= SPLICE_WINDOW_MS;
      const viewerAd = now < t.viewerAdUntil;
      const viewerGame = now < t.viewerGameUntil;
      const toBreak = nearSplice ? SPLICE_HAZARD : viewerGame ? 0 : BREAK_HAZARD;
      const toGame = nearSplice ? SPLICE_HAZARD : viewerAd ? 0 : GAME_HAZARD;
      const prior = t.p * (1 - toGame) + (1 - t.p) * toBreak;
      const p = Math.min(1 - 1e-4, Math.max(1e-4, live));
      let liveEvidence = Math.min(MAX_READING_EVIDENCE, Math.max(-MAX_READING_EVIDENCE, Math.log(p / (1 - p))));
      // The viewer's word holds until a splice says the segment may have changed.
      const sinceSplice = now - t.lastSpliceAt <= VIEWER_RELEASE_WINDOW_MS;
      if (viewerAd && liveEvidence > 0 && !sinceSplice) liveEvidence *= VIEWER_DISCOUNT;
      if (viewerGame && liveEvidence < 0 && !sinceSplice) liveEvidence *= VIEWER_DISCOUNT;
      if (knownAd) liveEvidence -= KNOWN_AD_EVIDENCE;
      else liveEvidence -= REPEAT_EVIDENCE * Math.min(1, Math.max(0, airedBefore));
      const odds = prior / (1 - prior) * Math.exp(-liveEvidence);
      t.p = Math.min(CEILING, Math.max(1 - CEILING, odds / (1 + odds)));
      return t.p;
    },
    viewerSaysAd(t, now) { t.p = CEILING; t.viewerAdUntil = now + VIEWER_HOLD_MS; t.viewerGameUntil = NEVER; },
    viewerSaysGame(t, now) { t.p = 1 - CEILING; t.viewerGameUntil = now + VIEWER_HOLD_MS; t.viewerAdUntil = NEVER; },
    releaseViewerAd(t) { t.viewerAdUntil = NEVER; },
  };

  // ---- Engine -------------------------------------------------------------------------------------

  /** Readings and ticks are not aligned; avoids a mute blip right before a presumed break ends. */
  const BREAK_GRACE_MS = 2000;
  /** A game counts as clearly back from its break once its ad probability is this low. */
  const GAME_CONFIRMED = 0.1;
  /** The game was back a few seconds before the ad was declared over; don't learn that part. */
  const LIVE_TRIM_SECONDS = 5;
  const ONSET_SPLICE_MS = 8000, DEFAULT_ONSET_SECONDS = 2;
  const MARK_SPLICE_MS = 30000, SPLICE_SETTLE_MS = 2000, MARK_LEAD_MS = 3000;
  const VIEWER_GAME_BACK_MS = 10000, VIEWER_GAME_AHEAD_MS = 30000;
  const CALM_MAX_AD = 0.1, AUTO_MIN_STRETCH_MS = 240000, AUTO_EDGE_MS = 60000, AUTO_CHUNK_MS = 60000;
  /** Windows that are mostly exact zeros mean the capture is blocked, not quiet. */
  const BLOCKED_ZERO_FRACTION = 0.6;
  /** Dropouts in part of a window (a stall); normal audio and splices stay well under this. */
  const GLITCH_ZERO_FRACTION = 0.2;
  const MUTE_WATCHDOG_MS = 12000;
  /** No game made a sound for this long (tabs paused, computer asleep): end the session. */
  const IDLE_STOP_MS = 20 * 60000;
  /** A tab that navigated (a new channel or game) isn't acted on while it loads. */
  const NAVIGATION_SETTLE_MS = 4000;
  /** A reading older than this no longer says what a game is doing. */
  const FRESH_MS = 8000;
  /** A higher-ranked game must have been live this long before it takes back over. */
  const PRIORITY_RETURN_MS = 6000;
  const PROMPT_MS = 25000;

  function pct(x) { return Math.round(x * 100); }

  /** The forest's live probability recentred so its validated 41% cutoff is 0.5 (as the personal model does before learning). */
  function centred(forestLive) {
    const logit = p => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
    return 1 / (1 + Math.exp(-(logit(forestLive) - logit(0.41))));
  }
  /** What the watched game's history slots are labelled while SportsWitch hears them (AdFingerprints labels). */
  const AUDIO_LABEL = {UNKNOWN: 0, GAME: 1, AD: 2, VIEWER_GAME: 3};

  class SwitchEngine {
    constructor(state) { this.s = state; }

    static create(settings, mode) {
      return new SwitchEngine({
        settings: validateSettings(settings), mode: mode === 'silence' ? 'silence' : 'switch', phase: 'off',
        games: [], currentId: null, monitoring: false, hold: false, muted: false, adActive: false,
        status: {}, lastProbability: null, lastClassification: null, lastKnownAd: false, lastRepeatedAd: false,
        lastUpdatedAt: null, lastEnergy: null, message: '', prompt: null,
        settleUntil: NEVER, silentReadings: 0, blockedReadings: 0, lastAudibleAt: NEVER, anyAudibleAt: NEVER,
        lastSpliceAt: NEVER, adSince: NEVER, adRecognised: false, viewerAdFrom: NEVER, viewerGameAt: NEVER,
        calmSince: NEVER, autoLabelledTo: NEVER,
      });
    }
    static restore(state) { return new SwitchEngine(state); }
    toJSON() { return this.s; }

    get settings() { return this.s.settings; }
    get games() { return this.s.games; }
    currentIndex() { return this.s.games.findIndex(g => g.id === this.s.currentId); }
    statusOf(id) { return this.s.status[id] || null; }
    isSettling(now) { return this.s.monitoring && now < this.s.settleUntil; }
    nameAt(index) {
      const g = this.s.games[index];
      return g ? (g.displayTitle || g.title || `Game ${index + 1}`) : 'this game';
    }
    currentName() { const i = this.currentIndex(); return i >= 0 ? this.nameAt(i) : 'this game'; }
    tracker(id) { const st = this.s.status[id]; return st ? st.tracker : null; }
    /** Ad-break probability of the watched game. */
    adProbability() { const t = this.tracker(this.s.currentId); return t ? t.p : START; }

    /*
     * How far back the ad on screen began, for learning its fingerprint without the end of the game:
     * the splice before it if there was one, where the viewer said it began, or a little.
     */
    adOnsetSecondsAgo(now) {
      const s = this.s;
      let seconds;
      if (s.viewerAdFrom !== NEVER) seconds = (now - s.viewerAdFrom) / 1000;
      else if (now - s.lastSpliceAt <= ONSET_SPLICE_MS) seconds = (now - s.lastSpliceAt) / 1000;
      else seconds = DEFAULT_ONSET_SECONDS;
      return Math.max(0, seconds);
    }

    // Session

    /** Monitoring starts once enough tabs are captured; the top game is watched first. */
    start(now) {
      const s = this.s;
      s.monitoring = true;
      s.hold = false;
      s.muted = false;
      s.adActive = false;
      s.prompt = null;
      for (const g of s.games) s.status[g.id] = this.freshStatus();
      this.resetSelected();
      s.lastAudibleAt = now;
      s.anyAudibleAt = now;
      const keep = this.currentIndex();
      const index = keep >= 0 ? keep : 0;
      const actions = this.switchTo(index, now, s.mode === 'silence'
        ? 'Silence mode active. Ads on this game are muted; the sound comes back with the game.'
        : `Switch mode: watching ${this.nameAt(index)} with ${s.games.length} games by priority.`, false);
      // Silence mode listens to the game already playing; nothing to settle.
      if (s.mode === 'silence') s.settleUntil = NEVER;
      return actions;
    }

    stop(reason) {
      const s = this.s;
      const actions = [];
      if (s.muted) actions.push({type: 'mute', muted: false});
      actions.push(...this.finishAd(null, 0));
      s.monitoring = false;
      s.hold = false;
      s.muted = false;
      s.adActive = false;
      s.prompt = null;
      this.resetSelected();
      if (reason) s.message = reason;
      return actions;
    }

    freshStatus() {
      return {tracker: Tracker.create(), classification: null, liveProbability: null, updatedAt: null, silent: false,
        knownAd: false, repeated: false, breakUntil: null, breakCount: 0, liveSince: NEVER, energy: null};
    }

    /** A different game (or channel) is watched: forget what the last one's corrections and stretches were. */
    resetSelected() {
      const s = this.s;
      const st = this.s.status[s.currentId];
      s.lastProbability = st && st.liveProbability != null && !st.silent ? st.liveProbability : null;
      s.lastClassification = st && !st.silent ? st.classification : null;
      s.lastKnownAd = false;
      s.lastRepeatedAd = false;
      s.silentReadings = 0;
      s.blockedReadings = 0;
      s.settleUntil = NEVER;
      s.lastSpliceAt = NEVER;
      s.calmSince = NEVER;
      s.viewerGameAt = NEVER;
    }

    // Readings

    /** One tab's reading: {tabId, live (0.5 = no opinion), energy, zeroFraction, splice, knownAd, airedBefore}. */
    onReading(r, now) {
      const s = this.s;
      if (!s.monitoring) return [];
      const st = s.status[r.tabId];
      if (!st) return [];
      const selected = r.tabId === s.currentId;
      st.updatedAt = now;
      if (!(r.zeroFraction < BLOCKED_ZERO_FRACTION) || !Number.isFinite(r.energy) || r.energy < SILENT_ENERGY || !Number.isFinite(r.live)) {
        st.silent = true;
        st.energy = Number.isFinite(r.energy) ? r.energy : null;
        st.classification = null;
        st.liveProbability = null;
        st.liveSince = NEVER;
        return selected ? this.selectedWithoutEvidence(r) : [];
      }
      s.anyAudibleAt = now;
      // Dropouts in part of the window (the site stalling) can make the game sound like an ad;
      // such a window may still say "game", but not "ad".
      const live = r.zeroFraction >= GLITCH_ZERO_FRACTION ? Math.max(r.live, 0.5) : r.live;
      const pAd = Tracker.update(st.tracker, now, live, !!r.splice, !!r.knownAd, r.airedBefore || 0);
      const p = 1 - pAd;
      const classification = classify(s.settings, pAd);
      st.silent = false;
      st.energy = r.energy;
      st.classification = classification;
      st.liveProbability = p;
      st.knownAd = !!r.knownAd;
      st.repeated = (r.airedBefore || 0) > 0 && !r.knownAd;
      st.liveSince = classification === 'Live' ? (st.liveSince === NEVER ? now : st.liveSince) : NEVER;
      // Clearing a presumed break needs the game itself, not just the absence of an ad yet.
      if (pAd <= GAME_CONFIRMED && live > 0.5) { st.breakUntil = null; st.breakCount = 0; }
      if (!selected) return [];

      s.silentReadings = 0;
      s.blockedReadings = 0;
      s.lastAudibleAt = now;
      s.lastProbability = p;
      s.lastClassification = classification;
      s.lastKnownAd = !!r.knownAd;
      s.lastRepeatedAd = st.repeated;
      s.lastUpdatedAt = now;
      s.lastEnergy = r.energy;
      if (r.splice) s.lastSpliceAt = now;
      // Just switched: let the new game settle before acting on its sound.
      if (now < s.settleUntil) return [];
      const recognised = !!r.knownAd || (r.airedBefore || 0) > 0;
      if (s.adActive && recognised) s.adRecognised = true;
      const liveConfirmed = classification === 'Live';
      const adConfirmed = !s.adActive && classification === 'Commercial';
      s.message = `${this.currentName()}: ${LABELS[classification]} · Ad ${pct(pAd)}% sure` +
        (r.knownAd ? ' · recognised ad' : st.repeated ? ' · aired before' : '');

      const actions = [];
      if (adConfirmed) {
        s.adActive = true;
        s.adSince = now;
        s.adRecognised = recognised;
        actions.push({type: 'adStarted', onsetSeconds: this.adOnsetSecondsAgo(now)});
      } else if (s.adActive && liveConfirmed) {
        actions.push(...this.finishAd(now, LIVE_TRIM_SECONDS));
      }
      actions.push(...(s.mode === 'silence' ? this.silenceDecision(adConfirmed, liveConfirmed) : this.switchDecision(adConfirmed, liveConfirmed, now)));
      actions.push(...this.gameLabels(now, pAd));
      return actions;
    }

    selectedWithoutEvidence(r) {
      const s = this.s;
      s.lastProbability = null;
      s.lastClassification = null;
      s.lastKnownAd = false;
      s.lastRepeatedAd = false;
      s.lastEnergy = Number.isFinite(r.energy) ? r.energy : null;
      if (!(r.zeroFraction < BLOCKED_ZERO_FRACTION)) {
        if (++s.blockedReadings >= 3) s.message = `SportsWitch can't hear ${this.currentName()} right now. Make sure it is playing.`;
      } else {
        s.message = ++s.silentReadings >= 3
          ? `No sound from ${this.currentName()}. Make sure it is playing and not muted on the site.`
          : 'Waiting for audio…';
      }
      return [];
    }

    /*
     * The ad on screen is over or no longer watched: stop learning its fingerprint, and if the viewer
     * marked it or it was recognised, teach the personal model what it sounded like. [now] is null when
     * there is nothing to label (e.g. stopping).
     */
    finishAd(now, trimSeconds) {
      const s = this.s;
      if (!s.adActive) return [];
      s.adActive = false;
      const actions = [{type: 'adEnded', trimSeconds}];
      const source = s.viewerAdFrom !== NEVER ? 'viewer' : s.adRecognised ? 'recognised' : null;
      if (now !== null && source) {
        const from = s.viewerAdFrom !== NEVER ? s.viewerAdFrom : s.adSince;
        const to = now - trimSeconds * 1000;
        if (to > from) actions.push({type: 'learn', from, to, live: false, source, weight: LABEL_WEIGHT[source]});
      }
      s.adRecognised = false;
      s.viewerAdFrom = NEVER;
      const t = this.tracker(s.currentId);
      if (t) Tracker.releaseViewerAd(t);
      return actions;
    }

    /*
     * Game labels: the stretch around a "That's the game" press, and the middle of long calm stretches
     * (their edges are skipped, since a break may have started before it was noticed).
     */
    gameLabels(now, pAd) {
      const s = this.s;
      const actions = [];
      if (s.viewerGameAt !== NEVER && (s.adActive || now - s.viewerGameAt >= VIEWER_GAME_AHEAD_MS)) {
        const to = s.adActive ? s.adSince - LIVE_TRIM_SECONDS * 1000 : now;
        const from = s.viewerGameAt - VIEWER_GAME_BACK_MS;
        if (to > from) actions.push({type: 'learn', from, to, live: true, source: 'viewer', weight: LABEL_WEIGHT.viewer});
        s.viewerGameAt = NEVER;
      }
      if (s.adActive || pAd > CALM_MAX_AD) {
        s.calmSince = NEVER;
        return actions;
      }
      if (s.calmSince === NEVER) {
        s.calmSince = now;
        s.autoLabelledTo = now + AUTO_EDGE_MS;
      }
      const to = now - AUTO_EDGE_MS;
      if (now - s.calmSince >= AUTO_MIN_STRETCH_MS && to - s.autoLabelledTo >= AUTO_CHUNK_MS) {
        actions.push({type: 'learn', from: s.autoLabelledTo, to, live: true, source: 'auto', weight: LABEL_WEIGHT.auto});
        s.autoLabelledTo = to;
      }
      return actions;
    }

    silenceDecision(adConfirmed, liveConfirmed) {
      const s = this.s;
      if (adConfirmed && !s.muted) {
        s.muted = true;
        s.message = 'Commercial detected — sound muted. Still listening for the game.';
        return [{type: 'mute', muted: true}];
      }
      if (liveConfirmed && s.muted) {
        s.muted = false;
        s.message = 'Live sports detected — sound restored.';
        return [{type: 'mute', muted: false}];
      }
      return [];
    }

    switchDecision(adConfirmed, liveConfirmed, now) {
      const s = this.s;
      if (s.muted) {
        // Muted for an ad with nowhere to go: the watched game coming back live ends it.
        if (!liveConfirmed) return [];
        s.muted = false;
        s.prompt = null;
        s.message = `${this.currentName()} is live again — sound restored.`;
        return [{type: 'mute', muted: false}];
      }
      if (s.hold || !adConfirmed) return [];
      return this.onAdOnScreen(now);
    }

    onAdOnScreen(now) {
      const s = this.s;
      const st = s.status[s.currentId];
      if (st && (st.breakUntil == null || st.breakUntil <= now)) {
        st.breakUntil = now + this.breakWaitMillis(st.breakCount);
        st.breakCount++;
      }
      // A presumed break ending within the grace period counts as over, rather than muting for an instant.
      const next = this.chooseNext(now + BREAK_GRACE_MS);
      if (next) return this.switchTo(next.index, now, `Ad on ${this.currentName()}. Switching to ${this.nameAt(next.index)}.`);
      if (s.settings.autoMuteWhenNoGame && !s.muted) {
        s.muted = true;
        s.message = `Every other game is on an ad. ${this.currentName()} muted until live action returns.`;
        return [{type: 'mute', muted: true}];
      }
      s.message = `Ad on ${this.currentName()}, but every other game is on an ad too.`;
      return [];
    }

    /** The first break uses the estimate; each recheck that still finds ads waits longer, capped. */
    breakWaitMillis(breakCount) {
      const seconds = breakCount === 0 ? this.s.settings.breakEstimateSeconds
        : Math.min(this.s.settings.recheckSeconds * breakCount, MAX_RECHECK_SECONDS);
      return seconds * 1000;
    }

    fresh(st, now) { return !!st && !st.silent && st.updatedAt != null && now - st.updatedAt <= FRESH_MS && st.classification != null; }

    /*
     * Look-ahead, highest priority first: a game that is live, else one that is uncertain, else one
     * SportsWitch can't hear right now. Never one on an ad or presumed on its break.
     */
    chooseNext(now) {
      const s = this.s;
      let uncertain = null, unheard = null;
      for (let i = 0; i < s.games.length; i++) {
        const g = s.games[i];
        if (g.id === s.currentId) continue;
        const st = s.status[g.id];
        if (st && st.breakUntil != null && st.breakUntil > now) continue;
        const classification = this.fresh(st, now) ? st.classification : null;
        if (classification === 'Commercial') continue;
        if (classification === 'Live') return {index: i, heard: true};
        if (classification === 'Uncertain') { if (uncertain === null) uncertain = i; }
        else if (unheard === null) unheard = i;
      }
      const index = uncertain !== null ? uncertain : unheard;
      return index === null ? null : {index, heard: false};
    }

    // Time-based decisions

    /** Call about once per second while monitoring. */
    onTick(now) {
      const s = this.s;
      if (!s.monitoring) return [];
      if (now - s.anyAudibleAt >= IDLE_STOP_MS) {
        return [...this.stop(`Stopped after ${IDLE_STOP_MS / 60000} minutes without sound from your games. Add a game to start again.`),
          {type: 'stopSession'}];
      }
      if (s.prompt && now >= s.prompt.until) s.prompt = null;
      // Never leave the viewer muted while SportsWitch cannot hear anything.
      if (s.muted && now - s.lastAudibleAt >= MUTE_WATCHDOG_MS) {
        const actions = [{type: 'mute', muted: false}, ...this.finishAd(null, 0)];
        s.muted = false;
        const t = this.tracker(s.currentId);
        if (t) Tracker.reset(t);
        s.message = `SportsWitch can't hear ${this.currentName()}, so sound was restored.`;
        return actions;
      }
      if (s.mode !== 'switch' || s.hold || now < s.settleUntil) return [];
      if (s.adActive) {
        // On an ad with nowhere to go yet: leave as soon as another game is back.
        const next = this.chooseNext(now);
        if (!next) return [];
        return this.switchTo(next.index, now, next.heard ? `${this.nameAt(next.index)} is live. Switching from the ad.`
          : `${this.nameAt(next.index)} should be back from its break.`);
      }
      const current = this.currentIndex();
      // Turned off, the watched game stays until its own ad or the viewer picks another.
      if (!s.settings.returnToPriority || current <= 0) return [];
      // A higher-ranked game takes back over once it is clearly live again.
      for (let i = 0; i < current; i++) {
        const st = s.status[s.games[i].id];
        if (!this.fresh(st, now) || st.classification !== 'Live') continue;
        if (st.breakUntil != null && st.breakUntil > now) continue;
        if (1 - st.liveProbability > GAME_CONFIRMED || now - st.liveSince < PRIORITY_RETURN_MS) continue;
        return this.switchTo(i, now, `${this.nameAt(i)} is live again. Back to your higher-priority game.`);
      }
      return [];
    }

    switchTo(index, now, why, whoosh = true) {
      const s = this.s;
      const target = s.games[index];
      const actions = [...this.finishAd(now, 0)];
      const changed = target.id !== s.currentId;
      const st = s.status[target.id];
      if (st && !this.fresh(st, now)) {
        // Not heard lately: what SportsWitch last believed about it no longer applies.
        Tracker.reset(st.tracker);
        st.classification = null;
        st.liveProbability = null;
      }
      s.currentId = target.id;
      this.resetSelected();
      s.settleUntil = now + s.settings.settleSeconds * 1000;
      s.lastAudibleAt = now;
      s.prompt = null;
      s.message = why;
      if (s.muted) {
        s.muted = false;
        actions.push({type: 'mute', muted: false});
      }
      actions.push({type: 'select', id: target.id, whoosh: whoosh && changed && s.settings.switchWhoosh,
        fullscreen: changed && s.mode === 'switch' && s.settings.autoFullscreenOnSwitch});
      return actions;
    }

    // What a tab plays

    /** A tab navigated to another page (a channel or game change): listen to it afresh. */
    onTabNavigated(id, now) {
      const s = this.s;
      const st = s.status[id];
      if (!st) return [];
      Object.assign(st, this.freshStatus());
      const actions = [{type: 'flush', id}];
      if (!s.monitoring || id !== s.currentId) return actions;
      actions.push(...this.finishAd(now, 0));
      if (s.muted) actions.push({type: 'mute', muted: false});
      s.muted = false;
      s.prompt = null;
      this.resetSelected();
      s.settleUntil = now + NAVIGATION_SETTLE_MS;
      s.message = `Now watching ${this.currentName()}.`;
      return actions;
    }

    // Viewer corrections

    /*
     * "That's an ad": act now, keep treating it as an ad until the break is clearly over (game-like
     * readings count for less), and remember it.
     */
    markAd(now) {
      const s = this.s;
      if (!s.monitoring || !s.status[s.currentId]) throw new Error('SportsWitch isn\'t listening yet. Add your games first.');
      const actions = [];
      const began = now - s.lastSpliceAt <= MARK_SPLICE_MS ? s.lastSpliceAt + SPLICE_SETTLE_MS : now - MARK_LEAD_MS;
      if (!s.adActive) {
        s.adActive = true;
        s.adSince = now;
        actions.push({type: 'adStarted', onsetSeconds: 0});
      }
      if (s.viewerAdFrom === NEVER) s.viewerAdFrom = Math.min(began, s.adSince);
      if (actions.length) actions[0].onsetSeconds = this.adOnsetSecondsAgo(now);
      const t = this.tracker(s.currentId);
      Tracker.viewerSaysAd(t, now);
      s.viewerGameAt = NEVER;
      s.calmSince = NEVER;
      s.settleUntil = NEVER;
      s.lastProbability = 1 - t.p;
      s.lastClassification = 'Commercial';
      const st = s.status[s.currentId];
      st.classification = 'Commercial';
      st.liveProbability = 1 - t.p;
      if (s.mode === 'silence') {
        if (!s.muted) {
          s.muted = true;
          actions.push({type: 'mute', muted: true});
        }
        s.message = 'Marked as an ad — muted. SportsWitch will recognise it next time.';
      } else if (!s.hold && !s.muted) {
        actions.push(...this.onAdOnScreen(now));
      } else {
        s.message = 'Marked as an ad. SportsWitch will recognise it next time.';
      }
      return actions;
    }

    /*
     * "That's the game": undo a false ad and forget what caused it, then keep treating it as the game for
     * a while (ad-like readings count for less). Pressing it while nothing is wrong just teaches
     * SportsWitch what this game sounds like.
     */
    markLive(now) {
      const s = this.s;
      if (!s.monitoring || !s.status[s.currentId]) throw new Error('SportsWitch isn\'t listening yet. Add your games first.');
      const actions = [];
      if (s.adActive || s.muted || s.lastKnownAd || s.lastRepeatedAd) actions.push({type: 'forgetRecentAds'});
      s.adActive = false;
      s.adRecognised = false;
      s.viewerAdFrom = NEVER;
      const t = this.tracker(s.currentId);
      Tracker.viewerSaysGame(t, now);
      if (s.viewerGameAt === NEVER) s.viewerGameAt = now;
      s.lastProbability = 1 - t.p;
      s.lastClassification = 'Live';
      s.lastKnownAd = false;
      s.lastRepeatedAd = false;
      const st = s.status[s.currentId];
      Object.assign(st, {classification: 'Live', liveProbability: 1 - t.p, breakUntil: null, breakCount: 0, updatedAt: now,
        knownAd: false, repeated: false, liveSince: st.liveSince === NEVER ? now : st.liveSince});
      if (s.muted) {
        s.muted = false;
        actions.push({type: 'mute', muted: false});
      }
      s.prompt = null;
      s.message = 'Marked as the game. SportsWitch will learn from this.';
      return actions;
    }

    /*
     * Another lineup game needs attention (red zone, close finish). Switches to it with "Jump to big
     * moments", otherwise asks the viewer. Never interrupts while holding or settling.
     */
    alertGame(id, why, now) {
      const s = this.s;
      if (!s.monitoring || s.hold || now < s.settleUntil || id === s.currentId) return [];
      const index = s.games.findIndex(g => g.id === id);
      if (index < 0) return [];
      if (s.mode === 'switch' && s.settings.followBigMoments) return this.switchTo(index, now, `${this.nameAt(index)}: ${why}`);
      const text = `${why}. Switch to ${this.nameAt(index)}?`;
      s.prompt = {gameId: id, text, until: now + PROMPT_MS};
      return [{type: 'prompt', id, text}];
    }

    // User commands

    /** Watch a lineup game now. */
    select(index, now) {
      const s = this.s;
      if (index < 0 || index >= s.games.length) throw new Error('Select a connected row.');
      if (!s.monitoring) throw new Error('Add enough tabs to begin monitoring before selecting a game.');
      return this.switchTo(index, now, `Watching ${this.nameAt(index)}.`);
    }

    setMode(mode) {
      const s = this.s;
      if (mode === s.mode) return [];
      s.mode = mode;
      s.hold = false;
      s.prompt = null;
      const actions = [];
      if (s.muted) actions.push({type: 'mute', muted: false});
      actions.push(...this.finishAd(null, 0));
      s.muted = false;
      return actions;
    }

    toggleHold() {
      const s = this.s;
      if (s.mode !== 'switch') throw new Error('Hold is available in Switch mode.');
      s.hold = !s.hold;
      const actions = s.hold && s.muted ? [{type: 'mute', muted: false}] : [];
      if (s.hold) s.muted = false;
      s.message = s.hold ? 'Hold on. Automatic switching and muting are paused; this game stays audible.'
        : 'Hold released. Automatic switching resumed.';
      return actions;
    }

    updateSettings(settings) {
      const s = this.s;
      s.settings = validateSettings(settings);
      // Turning fallback mute off while it is muting must restore sound immediately.
      if (s.monitoring && s.muted && s.mode === 'switch' && !s.settings.autoMuteWhenNoGame) {
        s.muted = false;
        return [{type: 'mute', muted: false}];
      }
      return [];
    }

    // Lineup

    addGame(game) {
      const s = this.s;
      if (s.games.length >= MAX_GAMES) throw new Error('Eight games are already connected.');
      if (s.games.some(g => g.id === game.id)) return;
      s.games.push(game);
      s.status[game.id] = this.freshStatus();
      if (s.currentId == null) s.currentId = game.id;
    }

    removeGame(id, now) {
      const s = this.s;
      const index = s.games.findIndex(g => g.id === id);
      if (index < 0) return [];
      s.games.splice(index, 1);
      delete s.status[id];
      if (s.prompt && s.prompt.gameId === id) s.prompt = null;
      if (id !== s.currentId) return [];
      const actions = [...this.finishAd(null, 0)];
      if (s.muted) actions.push({type: 'mute', muted: false});
      s.muted = false;
      s.currentId = s.games.length ? s.games[0].id : null;
      if (s.monitoring && s.games.length) actions.push(...this.switchTo(0, now, `Game capture ended. Continuing with ${this.nameAt(0)}.`, false));
      return actions;
    }

    /** The list is the priority: first row = highest. The watched game stays put. */
    reorder(ids) {
      const s = this.s;
      const original = s.games.map(g => g.id);
      if (!Array.isArray(ids) || ids.length !== original.length || new Set(ids).size !== ids.length || ids.some(id => !original.includes(id)))
        throw new Error('The game list changed. Refresh SportsWitch and try again.');
      const lookup = new Map(s.games.map(g => [g.id, g]));
      s.games = ids.map(id => lookup.get(id));
      s.message = s.settings.returnToPriority ? 'Priority updated. The top game has first preference whenever it is live.'
        : 'Priority updated. The top game has first preference at the next switch.';
    }

    updateGame(id, changes) {
      const g = this.s.games.find(x => x.id === id);
      if (g) Object.assign(g, changes);
      return g;
    }
  }

  // ---- What the controller shows ------------------------------------------------------------------

  const Presenter = {
    pct,
    readingText(s) {
      const p = s.lastProbability;
      if (p == null) return s.monitoring ? 'Listening…' : 'Not monitoring';
      const known = s.lastKnownAd ? ' · recognised ad' : s.lastRepeatedAd ? ' · aired before' : '';
      return `${LABELS[s.lastClassification] || 'Uncertain'} · Game ${pct(p)}% · Ad ${pct(1 - p)}%${known}`;
    },
    /** 'live' | 'ad' | 'uncertain' | 'dim' */
    tone(classification) {
      return classification === 'Live' ? 'live' : classification === 'Commercial' ? 'ad' : classification === 'Uncertain' ? 'uncertain' : 'dim';
    },
    stateTone(s, now) {
      if (!s.monitoring) return 'dim';
      if (s.muted || s.adActive) return 'ad';
      if (now < s.settleUntil) return 'uncertain';
      return Presenter.tone(s.lastClassification);
    },
    clock(millis) {
      const seconds = Math.max(0, Math.floor(millis / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    },
    /** One lineup row's second line and its tone. */
    rowStatus(s, index, now) {
      const g = s.games[index];
      const st = s.status[g.id] || {};
      const watched = g.id === s.currentId && s.monitoring;
      if (s.prompt && s.prompt.gameId === g.id) return {text: 'Big moment · switch to this game?', tone: 'uncertain'};
      if (watched && now < s.settleUntil) return {text: 'Watching · settling in', tone: 'uncertain'};
      if (watched && s.muted) return {text: 'Watching · muted for ads', tone: 'ad'};
      const breakActive = st.breakUntil != null && st.breakUntil > now;
      const fresh = st.updatedAt != null && now - st.updatedAt <= FRESH_MS;
      if (fresh && st.silent) return {text: 'Audio silent · check playback', tone: 'dim'};
      if (fresh && st.liveProbability != null) {
        // The row's badge already says Live / Ad / Known ad.
        const extra = breakActive ? ` · break, back in ~${Presenter.clock(st.breakUntil - now)}` : '';
        return {text: `${watched ? 'Watching · ' : ''}Game ${pct(st.liveProbability)}% · Ad ${pct(1 - st.liveProbability)}%${extra}`,
          tone: Presenter.tone(st.classification)};
      }
      if (breakActive) return {text: `Ad break · back in ~${Presenter.clock(st.breakUntil - now)}`, tone: 'ad'};
      if (st.updatedAt != null) return {text: `Last heard ${Presenter.clock(now - st.updatedAt)} ago`, tone: 'dim'};
      return {text: s.monitoring ? 'Analyzing audio…' : 'Connected · awaiting another tab', tone: 'dim'};
    },
  };

  root.SportsWitchEngine = {
    SwitchEngine, Tracker, Presenter, DEFAULT_SETTINGS, validateSettings, migrateSettings, classify, centred, LABELS,
    AUDIO_LABEL, NEVER, SILENT_ENERGY, MAX_GAMES, FRESH_MS, GAME_CONFIRMED,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
