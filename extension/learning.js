/*
 * SportsWitch 4.2.0: what the Android app does around the 4.1.4 model, ported to Chrome tabs.
 *
 * - SpliceDetector finds the short near-silences where breaks start and end.
 * - AdFingerprints remembers ads SportsWitch confirmed, so their next airing is recognised from two
 *   seconds of audio, and keeps a history of everything the watched game played in the last ~2 h 20 min:
 *   live play never airs twice, ads and promos do.
 * - PersonalModel is a small model refit in this browser from the viewer's corrections, recognised
 *   ads and long calm stretches of game. Until it has learned enough it equals the forest.
 * - TabAnalyzer turns one tab's capture into a reading every second.
 *
 * Runs in the analysis worker. Nothing here leaves the computer.
 */
(function (root) {
  'use strict';
  const C = root.FootballClassifier;
  /** "Never happened": far in the past, yet safe to subtract from. */
  const NEVER = -1e15;

  // ---- Splices ------------------------------------------------------------------------------------

  /*
   * A gap of 150 ms - 2.5 s that falls far below the recent programme level (40 dB down, or below
   * -70 dBFS), after at least a second of sound, reports a splice when audio resumes. Live football
   * almost never drops that far, so a splice is good evidence that what follows is a new segment.
   */
  const SILENCE_FLOOR_DB = -70, DROP_DB = 40, MIN_GAP_MS = 150, MAX_GAP_MS = 2500;
  const MIN_SOUND_FRAMES = 100, BASELINE_ALPHA = 0.01;
  class SpliceDetector {
    constructor(sampleRate) {
      this.frameSamples = Math.floor(sampleRate / 100); // 10 ms frames
      this.reset();
    }
    reset() {
      this.energy = 0; this.samples = 0; this.baselineDb = NaN;
      this.quietFrames = 0; this.soundFrames = 0; this.position = 0;
      /** Sample number (since the last reset) where audio resumed after the latest splice, or -1. */
      this.lastSpliceAt = -1;
    }
    /** Returns true when a splice ended inside these samples. */
    accept(chunk, offset = 0, count = chunk.length - offset) {
      let found = false;
      for (let i = offset; i < offset + count; i++) {
        const s = chunk[i];
        this.energy += s * s;
        this.position++;
        if (++this.samples === this.frameSamples) {
          if (this.onFrame(10 * Math.log10(this.energy / this.samples + 1e-12))) {
            found = true;
            this.lastSpliceAt = this.position - this.frameSamples;
          }
          this.energy = 0;
          this.samples = 0;
        }
      }
      return found;
    }
    onFrame(db) {
      const threshold = Number.isNaN(this.baselineDb) ? SILENCE_FLOOR_DB : Math.max(SILENCE_FLOOR_DB, this.baselineDb - DROP_DB);
      if (db < threshold) {
        this.quietFrames++;
        return false;
      }
      const gapMs = this.quietFrames * 10;
      const splice = gapMs >= MIN_GAP_MS && gapMs <= MAX_GAP_MS && this.soundFrames >= MIN_SOUND_FRAMES;
      // Brief pauses between words don't count against the programme that came before.
      if (gapMs >= MIN_GAP_MS) this.soundFrames = 0;
      this.quietFrames = 0;
      this.soundFrames++;
      this.baselineDb = Number.isNaN(this.baselineDb) ? db : this.baselineDb + BASELINE_ALPHA * (db - this.baselineDb);
      return splice;
    }
  }

  // ---- Fingerprints -------------------------------------------------------------------------------

  const FP_RATE = 16000, FP_FRAME = 2048, FP_HOP = 256, FRAMES_PER_SECOND = FP_RATE / FP_HOP;
  const BANDS = 33, LOW_HZ = 300, HIGH_HZ = 3000, SILENT_BAND_ENERGY = 1e-6;
  const QUERY_FRAMES = 125;          // two seconds
  const LEARN_CHUNK_FRAMES = 500;    // eight seconds per stored segment
  const MIN_LEARN_FRAMES = 190;      // three seconds
  const MIN_VOTES = 3, MIN_OVERLAP = 0.8, MAX_BIT_ERROR_RATE = 0.30;
  const MAGIC = 0x53574650;          // "SWFP"
  const HISTORY_MAGIC = 0x53574848;  // "SWHH"
  const MAX_ID = 0xFFF;
  /** 2^19 frames of 16 ms: about 2 hours 20 minutes. */
  const HISTORY_FRAMES = 1 << 19, HISTORY_MASK = HISTORY_FRAMES - 1;
  const SLOT_BITS = 6;               // 64 frames, about a second
  const HASH_BITS = 20, MAX_CHAIN = 64;
  /** Frames are stored as frame + 1 in the hash chains. */
  const MAX_FRAME = 2147483647 - 2;
  /** A repeat must be at least five minutes later: nearer is a rewind or the same break. */
  const MIN_REPEAT_LAG_FRAMES = Math.floor(5 * 60 * FP_RATE / FP_HOP);
  const MAX_REPEAT_BIT_ERROR_RATE = 0.25, LAG_TOLERANCE = 3;
  const MIN_REPEAT_SECONDS = 2.9, MAX_REPEAT_SECONDS = 180;
  const LABEL_UNKNOWN = 0, LABEL_GAME = 1, LABEL_AD = 2, LABEL_VIEWER_GAME = 3;
  const BAND_EDGES = Int32Array.from({length: BANDS + 1}, (_, i) =>
    Math.trunc(LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BANDS) * FP_FRAME / FP_RATE));

  function bucketOf(print) { return Math.imul(print, -0x61c88647) >>> (32 - HASH_BITS); }
  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
  }

  /*
   * Each 16 ms frame of 16 kHz audio becomes a 32-bit sub-fingerprint (Haitsma & Kalker): the signs of
   * energy differences between 33 log-spaced bands, across frequency and time. That is insensitive to
   * volume and mild EQ but changes completely for different audio. One per tab.
   */
  class PrintMaker {
    constructor() { this.prev = null; this.spare = new Float64Array(BANDS); }
    reset() { this.prev = null; }
    next(power) {
      const bands = this.spare;
      let total = 0;
      for (let b = 0; b < BANDS; b++) {
        let e = 0;
        const hi = Math.max(BAND_EDGES[b] + 1, BAND_EDGES[b + 1]);
        for (let k = BAND_EDGES[b]; k < hi; k++) e += power[k];
        bands[b] = e;
        total += e;
      }
      const prev = this.prev;
      let print = 0;
      if (prev && total > SILENT_BAND_ENERGY) {
        for (let m = 0; m < 32; m++) {
          const diff = (bands[m] - bands[m + 1]) - (prev[m] - prev[m + 1]);
          if (diff > 0) print |= (1 << m);
        }
      }
      this.spare = prev || new Float64Array(BANDS);
      this.prev = bands;
      return print;
    }
  }

  /*
   * Self-learning memory of what aired, used two ways:
   * 1. Learned ads. Once SportsWitch has confirmed an ad on the watched game it stores its
   *    fingerprint, so the next airing, on any tab, is recognised within about two seconds.
   * 2. Repeats. The watched game's audio of the last two hours or so is kept, across sessions. Audio
   *    that matches something heard minutes or hours earlier is almost certainly not the game, even
   *    when it sounds like sport. Repeats are reported with what SportsWitch thought the earlier airing
   *    was, and audio the viewer said was the game is never reported.
   * Queries of two seconds are located through exact sub-fingerprint lookups (a sorted index for
   * learned ads, a hash chain for the history), then verified by bit error rate over the aligned block.
   */
  class AdFingerprints {
    constructor(maxEntries = 600, clock = () => Date.now()) {
      this.maxEntries = maxEntries;
      this.clock = clock;
      this.history = new Int32Array(HISTORY_FRAMES);
      /** What SportsWitch thought each ~1 s slot of the history was (LABEL_*). */
      this.slotLabels = new Int8Array(HISTORY_FRAMES >>> SLOT_BITS);
      /** Hash bucket → latest frame + 1 with that bucket; chain links to the previous one. */
      this.heads = new Int32Array(1 << HASH_BITS);
      this.chain = new Int32Array(HISTORY_FRAMES);
      /** Frames recorded so far, ever (persisted with the history). */
      this.frameCount = 0;
      /** First frame of the current continuous stream; queries never straddle a change of game. */
      this.streamStart = 0;
      /** What SportsWitch currently thinks it is hearing on the watched game. */
      this.currentLabel = LABEL_UNKNOWN;
      this.entries = new Map();
      this.nextId = 1;
      /** Sorted (print << 32 | entryId << 20 | frame) for binary-search lookups. */
      this.index = new BigUint64Array(0);
      this.learningFrom = -1;
      this.learningEndedAt = NEVER;
      this.learnedThisSession = [];
      this.recentMatches = [];
      this.repeatLag = -1;
      this.repeatSince = 0;
      this.ignoredLag = -1;
    }
    get entryCount() { return this.entries.size; }
    get isLearning() { return this.learningFrom >= 0; }

    /** The watched game changed: queries restart; the history is kept. */
    resetStream() {
      this.streamStart = this.frameCount;
      this.learningFrom = -1;
      this.recentMatches.length = 0;
      this.repeatLag = -1;
      this.ignoredLag = -1;
    }
    /** The watched game's next sub-fingerprint. */
    pushPrint(print) {
      if (this.frameCount >= MAX_FRAME) this.clearHistory();
      this.record(this.frameCount, print);
      this.frameCount++;
      if (this.isLearning && this.frameCount - this.learningFrom >= LEARN_CHUNK_FRAMES) {
        this.learn(this.learningFrom, this.learningFrom + LEARN_CHUNK_FRAMES);
        this.learningFrom += LEARN_CHUNK_FRAMES;
      }
    }
    record(frame, print) {
      const at = frame & HISTORY_MASK;
      this.history[at] = print;
      this.slotLabels[at >>> SLOT_BITS] = this.currentLabel;
      if (print === 0 || print === -1) {
        this.chain[at] = 0;
        return;
      }
      const bucket = bucketOf(print);
      this.chain[at] = this.heads[bucket];
      this.heads[bucket] = frame + 1;
    }
    printAt(frame) { return this.history[frame & HISTORY_MASK]; }
    inHistory(frame) { return frame >= 0 && frame > this.frameCount - HISTORY_FRAMES && frame < this.frameCount; }

    /** Marks the last [seconds] of history as [label], e.g. after the viewer says it was the game. */
    labelRecent(seconds, label) {
      const from = Math.max(this.frameCount - Math.trunc(seconds * FRAMES_PER_SECOND), this.frameCount - HISTORY_FRAMES + 1, 0);
      for (let f = from; f < this.frameCount; f += 1 << SLOT_BITS) this.slotLabels[(f & HISTORY_MASK) >>> SLOT_BITS] = label;
    }

    // Learned ads

    /** Does the watched game's last two seconds match a learned ad? */
    matchRecent() {
      if (this.frameCount - this.streamStart < QUERY_FRAMES || this.index.length === 0) return null;
      const start = this.frameCount - QUERY_FRAMES;
      const query = new Int32Array(QUERY_FRAMES);
      for (let i = 0; i < QUERY_FRAMES; i++) query[i] = this.printAt(start + i);
      // Audio being learned right now would otherwise match its own new entry.
      const match = this.match(query, this.isLearning ? new Set(this.learnedThisSession) : null);
      if (!match) return null;
      const entry = this.entries.get(match.entryId);
      if (entry) { entry.hits++; entry.lastSeen = this.clock(); }
      this.recentMatches.push([this.frameCount, match.entryId]);
      while (this.recentMatches.length > 64) this.recentMatches.shift();
      return match;
    }
    /** Another tab's last two seconds: recognised, but never learned or forgotten from. */
    matchPrints(query) {
      if (this.index.length === 0) return null;
      const match = this.match(query, null);
      if (match) {
        const entry = this.entries.get(match.entryId);
        if (entry) { entry.hits++; entry.lastSeen = this.clock(); }
      }
      return match;
    }
    match(query, excluding) {
      const votes = new Map();
      for (let q = 0; q < query.length; q++) {
        const print = query[q];
        if (print === 0 || print === -1) continue;
        const key = BigInt(print >>> 0);
        let i = this.lowerBound(key << 32n);
        while (i < this.index.length && (this.index[i] >> 32n) === key) {
          const packed = Number(this.index[i] & 0xFFFFFFFFn);
          const entryId = packed >>> 20;
          const offset = (packed & 0xFFFFF) - q;
          if (!excluding || !excluding.has(entryId)) {
            const vote = entryId * 4194304 + offset + 1024;
            votes.set(vote, (votes.get(vote) || 0) + 1);
          }
          i++;
        }
      }
      let best = null;
      for (const [vote, count] of votes) {
        if (count < MIN_VOTES) continue;
        const entryId = Math.floor(vote / 4194304);
        const offset = vote % 4194304 - 1024;
        const entry = this.entries.get(entryId);
        if (!entry) continue;
        const prints = entry.prints;
        let errors = 0, overlap = 0;
        for (let q = 0; q < query.length; q++) {
          const f = offset + q;
          if (f < 0 || f >= prints.length || query[q] === 0) continue;
          errors += popcount(query[q] ^ prints[f]);
          overlap++;
        }
        if (overlap < query.length * MIN_OVERLAP) continue;
        const ber = errors / (32 * overlap);
        if (ber <= MAX_BIT_ERROR_RATE && (!best || ber < best.bitErrorRate)) best = {entryId, bitErrorRate: ber, hits: entry.hits};
      }
      return best;
    }
    lowerBound(key) {
      let lo = 0, hi = this.index.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.index[mid] < key) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    // Repeats

    /*
     * Did the last two seconds air before, at least five minutes ago? Reported once the same alignment
     * holds for about three seconds. A match that keeps going for minutes is a rewind or a replayed
     * programme, not an ad, and is dropped.
     */
    matchRepeat() {
      const queryStart = this.frameCount - QUERY_FRAMES;
      if (queryStart < this.streamStart) return this.noRepeat();
      const votes = new Map();
      for (let q = 0; q < QUERY_FRAMES; q++) {
        const frame = queryStart + q;
        const print = this.printAt(frame);
        if (print === 0 || print === -1) continue;
        let candidate = this.heads[bucketOf(print)] - 1;
        let steps = 0;
        while (candidate >= 0 && this.inHistory(candidate) && steps++ < MAX_CHAIN) {
          const lag = frame - candidate;
          if (lag >= MIN_REPEAT_LAG_FRAMES && this.printAt(candidate) === print) votes.set(lag, (votes.get(lag) || 0) + 1);
          const previous = this.chain[candidate & HISTORY_MASK] - 1;
          if (previous >= candidate) break; // overwritten link
          candidate = previous;
        }
      }
      let bestLag = -1, bestBer = 1;
      for (const [lag, count] of votes) {
        if (count + (votes.get(lag - 1) || 0) + (votes.get(lag + 1) || 0) < MIN_VOTES) continue;
        const ber = this.repeatBitErrorRate(queryStart, lag);
        if (ber < bestBer) { bestBer = ber; bestLag = lag; }
      }
      if (bestLag < 0 || bestBer > MAX_REPEAT_BIT_ERROR_RATE) return this.noRepeat();
      if (this.repeatLag < 0 || Math.abs(bestLag - this.repeatLag) > LAG_TOLERANCE) this.repeatSince = queryStart;
      this.repeatLag = bestLag;
      const seconds = (this.frameCount - this.repeatSince) / FRAMES_PER_SECOND;
      if (Math.abs(bestLag - this.ignoredLag) <= LAG_TOLERANCE) return null;
      if (seconds > MAX_REPEAT_SECONDS) {
        this.ignoredLag = bestLag;
        return null;
      }
      if (seconds < MIN_REPEAT_SECONDS) return null;
      const earlier = this.earlierLabel(queryStart - bestLag, this.frameCount - bestLag);
      if (earlier === LABEL_VIEWER_GAME) return null;
      return {lagSeconds: bestLag / FRAMES_PER_SECOND, bitErrorRate: bestBer, seconds, earlier};
    }
    noRepeat() {
      this.repeatLag = -1;
      return null;
    }
    repeatBitErrorRate(queryStart, lag) {
      let errors = 0, overlap = 0;
      for (let q = 0; q < QUERY_FRAMES; q++) {
        const now = this.printAt(queryStart + q);
        const then = queryStart + q - lag;
        if (now === 0 || !this.inHistory(then)) continue;
        const old = this.printAt(then);
        if (old === 0) continue;
        errors += popcount(now ^ old);
        overlap++;
      }
      return overlap < QUERY_FRAMES * MIN_OVERLAP ? 1 : errors / (32 * overlap);
    }
    /** The viewer's word wins; otherwise the most common label over the earlier airing. */
    earlierLabel(from, to) {
      const counts = [0, 0, 0, 0];
      for (let f = from; f < to; f += 1 << SLOT_BITS) {
        const label = this.slotLabels[(f & HISTORY_MASK) >>> SLOT_BITS];
        if (label === LABEL_VIEWER_GAME) return LABEL_VIEWER_GAME;
        if (label >= 0 && label < 4) counts[label]++;
      }
      let best = LABEL_UNKNOWN;
      for (let i = 0; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
      return best;
    }
    clearHistory() {
      this.history.fill(0);
      this.chain.fill(0);
      this.heads.fill(0);
      this.slotLabels.fill(0);
      this.frameCount = 0;
      this.streamStart = 0;
      this.learningFrom = -1;
      this.repeatLag = -1;
    }

    // Learning

    /** An ad was just confirmed; start learning from [secondsBack] ago (when it probably began). */
    beginLearning(secondsBack = 2) {
      if (this.isLearning) return;
      const back = Math.trunc(secondsBack * FRAMES_PER_SECOND);
      this.learningFrom = Math.max(this.streamStart, this.frameCount - back, this.frameCount - HISTORY_FRAMES + 1);
      this.learnedThisSession = [];
    }
    /** The ad ended; keep what was heard except the last [trimSeconds], which may be the game. */
    endLearning(trimSeconds = 0) {
      if (!this.isLearning) return;
      const end = this.frameCount - Math.trunc(trimSeconds * FRAMES_PER_SECOND);
      if (end - this.learningFrom >= MIN_LEARN_FRAMES) this.learn(this.learningFrom, end);
      this.learningFrom = -1;
      this.learningEndedAt = this.frameCount;
    }
    /*
     * The viewer says this is the game: forget whatever matched in the last [seconds], and what was
     * learned from an ad that is still being learned or ended within that time, so the same mistake
     * does not repeat. The audio is also marked as game so it never counts as a repeat.
     */
    forgetRecent(seconds = 30) {
      const since = this.frameCount - Math.trunc(seconds * FRAMES_PER_SECOND);
      const doomed = new Set(this.recentMatches.filter(m => m[0] >= since).map(m => m[1]));
      if (this.isLearning || this.learningEndedAt >= since) this.learnedThisSession.forEach(id => doomed.add(id));
      this.learnedThisSession = [];
      this.learningFrom = -1;
      if (this.repeatLag >= 0) {
        this.ignoredLag = this.repeatLag;
        for (let f = Math.max(since, this.repeatSince); f < this.frameCount; f += 1 << SLOT_BITS) {
          const then = f - this.repeatLag;
          if (this.inHistory(then)) this.slotLabels[(then & HISTORY_MASK) >>> SLOT_BITS] = LABEL_VIEWER_GAME;
        }
      }
      this.labelRecent(seconds, LABEL_VIEWER_GAME);
      doomed.forEach(id => this.entries.delete(id));
      this.recentMatches = this.recentMatches.filter(m => !doomed.has(m[1]));
      if (doomed.size) this.rebuildIndex();
      return doomed.size;
    }
    learn(from, to) {
      const start = Math.max(from, this.frameCount - HISTORY_FRAMES + 1);
      if (to - start < MIN_LEARN_FRAMES) return;
      const prints = new Int32Array(to - start);
      let zeros = 0;
      for (let i = 0; i < prints.length; i++) { prints[i] = this.printAt(start + i); if (prints[i] === 0) zeros++; }
      if (zeros > prints.length / 2) return; // mostly silence
      // A repeat of something already learned only refreshes it.
      const repeat = this.match(prints.subarray(0, Math.min(prints.length, QUERY_FRAMES)), null);
      if (repeat) {
        const entry = this.entries.get(repeat.entryId);
        if (entry) { entry.hits++; entry.lastSeen = this.clock(); }
        return;
      }
      while (this.entries.size >= this.maxEntries) {
        let oldest = null;
        for (const e of this.entries.values()) if (!oldest || e.lastSeen < oldest.lastSeen) oldest = e;
        if (!oldest) break;
        this.entries.delete(oldest.id);
      }
      const entry = {id: this.allocateId(), prints, hits: 0, lastSeen: this.clock()};
      this.entries.set(entry.id, entry);
      this.learnedThisSession.push(entry.id);
      this.rebuildIndex();
    }
    /** Ids share 12 bits of each index key with the frame number, so they are recycled. */
    allocateId() {
      while (this.entries.has(this.nextId) || this.nextId > MAX_ID) this.nextId = this.nextId > MAX_ID ? 1 : this.nextId + 1;
      return this.nextId++;
    }
    rebuildIndex() {
      let size = 0;
      for (const e of this.entries.values()) {
        for (let f = 0; f < e.prints.length && f <= 0xFFFFF; f++) { const p = e.prints[f]; if (p !== 0 && p !== -1) size++; }
      }
      const packed = new BigUint64Array(size);
      let n = 0;
      for (const e of this.entries.values()) {
        const id = BigInt(e.id) << 20n;
        for (let f = 0; f < e.prints.length && f <= 0xFFFFF; f++) {
          const p = e.prints[f];
          if (p === 0 || p === -1) continue;
          packed[n++] = (BigInt(p >>> 0) << 32n) | id | BigInt(f);
        }
      }
      packed.sort();
      this.index = packed;
    }
    /** Forgets every learned ad and the history (Settings › Reset what SportsWitch learned). */
    clearAll() {
      this.entries.clear();
      this.rebuildIndex();
      this.learnedThisSession = [];
      this.recentMatches = [];
      this.clearHistory();
    }

    // Persistence: the Android app's layout (big-endian, as Java's DataOutputStream writes).

    save() {
      let bytes = 8;
      for (const e of this.entries.values()) bytes += 20 + 4 * e.prints.length;
      const view = new DataView(new ArrayBuffer(bytes));
      let at = 0;
      view.setInt32(at, MAGIC); at += 4;
      view.setInt32(at, this.entries.size); at += 4;
      for (const e of this.entries.values()) {
        view.setInt32(at, e.id); at += 4;
        view.setInt32(at, e.hits); at += 4;
        view.setBigInt64(at, BigInt(Math.trunc(e.lastSeen))); at += 8;
        view.setInt32(at, e.prints.length); at += 4;
        for (let i = 0; i < e.prints.length; i++) { view.setInt32(at, e.prints[i]); at += 4; }
      }
      return view.buffer;
    }
    load(buffer) {
      const view = new DataView(buffer);
      let at = 0;
      if (view.getInt32(at) !== MAGIC) throw new Error('Not a SportsWitch fingerprint file');
      at += 4;
      this.entries.clear();
      const count = view.getInt32(at); at += 4;
      for (let n = 0; n < count; n++) {
        const id = view.getInt32(at); at += 4;
        const hits = view.getInt32(at); at += 4;
        const lastSeen = Number(view.getBigInt64(at)); at += 8;
        const length = view.getInt32(at); at += 4;
        const prints = new Int32Array(length);
        for (let i = 0; i < length; i++) { prints[i] = view.getInt32(at); at += 4; }
        if (id >= 1 && id <= MAX_ID) this.entries.set(id, {id, prints, hits, lastSeen});
      }
      this.rebuildIndex();
    }
    /** The history of the last couple of hours, so repeats are noticed across sessions. */
    saveHistory() {
      const from = Math.max(0, this.frameCount - HISTORY_FRAMES);
      const count = this.frameCount - from;
      const slots = count >>> SLOT_BITS;
      const view = new DataView(new ArrayBuffer(4 + 8 + 4 + 4 * count + 4 + slots));
      let at = 0;
      view.setInt32(at, HISTORY_MAGIC); at += 4;
      view.setBigInt64(at, BigInt(this.frameCount)); at += 8;
      view.setInt32(at, count); at += 4;
      for (let f = from; f < this.frameCount; f++) { view.setInt32(at, this.printAt(f)); at += 4; }
      view.setInt32(at, slots); at += 4;
      let f = this.frameCount - slots * (1 << SLOT_BITS);
      for (let s = 0; s < slots; s++) {
        view.setInt8(at++, this.slotLabels[(f & HISTORY_MASK) >>> SLOT_BITS]);
        f += 1 << SLOT_BITS;
      }
      return view.buffer;
    }
    loadHistory(buffer) {
      const view = new DataView(buffer);
      let at = 0;
      if (view.getInt32(at) !== HISTORY_MAGIC) throw new Error('Not a SportsWitch history file');
      at += 4;
      this.clearHistory();
      const end = Number(view.getBigInt64(at)); at += 8;
      const count = view.getInt32(at); at += 4;
      if (!(count >= 0 && count <= HISTORY_FRAMES && end >= count && end <= MAX_FRAME)) throw new Error('Corrupt history');
      const start = end - count;
      for (let f = start; f < end; f++) { this.record(f, view.getInt32(at)); at += 4; }
      this.frameCount = end;
      const slots = view.getInt32(at); at += 4;
      let f = end - slots * (1 << SLOT_BITS);
      for (let s = 0; s < slots; s++) {
        const label = view.getInt8(at++);
        if (f >= 0) this.slotLabels[(f & HISTORY_MASK) >>> SLOT_BITS] = label;
        f += 1 << SLOT_BITS;
      }
      this.streamStart = this.frameCount;
    }
  }

  // ---- Personal model -----------------------------------------------------------------------------

  /*
   * On-device adaptation of the forest to the streams this computer plays.
   *
   * The forest learned from public clips, and real streams sound different: on the Android app's first
   * SHIELD sessions it scored 77-86% of seconds correctly, against 98% on its public test. A small
   * logistic model over the same 46 features plus the forest's own score is refit here from what
   * SportsWitch learns: the viewer's corrections, ads confirmed by fingerprint or by airing again, and
   * long undisputed stretches of game. It is regularised toward "trust the forest", so with little data
   * it changes almost nothing.
   *
   * predict() returns a live probability where 0.5 means no opinion: the forest's validated 41% cutoff
   * maps to 0.5 before any learning.
   */
  const FEATURES = 46, DIM = FEATURES + 1, WIDTH = DIM + 1;
  const FOREST_CUTOFF = 0.41;
  const MAX_PER_CLASS = 4000, PENDING_MS = 300000, REFIT_EVERY = 120, MIN_CLASS_WEIGHT = 20;
  const ITERATIONS = 300, STEP = 0.5, L2 = 10;
  const MODEL_MAGIC = 0x5357504D; // "SWPM"
  function sigmoid(s) { return 1 / (1 + Math.exp(-s)); }
  function logit(p) { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); }
  /** The forest's score as evidence: positive favours the game, 0 at its 41% cutoff. */
  function forestEvidence(forestLive) { return logit(forestLive) - logit(FOREST_CUTOFF); }
  /** The forest's live probability recentred so its cutoff is 0.5, with no learning applied. */
  function centred(forestLive) { return sigmoid(forestEvidence(forestLive)); }

  class Examples {
    constructor(capacity) { this.capacity = capacity; this.rows = new Float32Array(capacity * WIDTH); this.size = 0; this.next = 0; }
    add(x, weight) {
      this.rows.set(x.subarray(0, DIM), this.next * WIDTH);
      this.rows[this.next * WIDTH + DIM] = weight;
      this.next = (this.next + 1) % this.capacity;
      if (this.size < this.capacity) this.size++;
    }
    weight(i) { return this.rows[i * WIDTH + DIM]; }
    totalWeight() { let t = 0; for (let i = 0; i < this.size; i++) t += this.weight(i); return t; }
    clear() { this.size = 0; this.next = 0; }
  }

  class PersonalModel {
    constructor() {
      this.live = new Examples(MAX_PER_CLASS);
      this.ad = new Examples(MAX_PER_CLASS);
      this.pending = [];
      this.fit = null;
      this.sinceFit = 0;
    }
    get gameExamples() { return this.live.size; }
    get adExamples() { return this.ad.size; }
    /** The model has enough of both kinds of example to differ from the forest. */
    get isAdapted() { return this.fit !== null; }
    /** Scores one reading and, for the watched game, keeps it a few minutes in case it gets a label. */
    predict(features, forestLive, time, keep = true) {
      const x = new Float32Array(DIM);
      for (let i = 0; i < FEATURES; i++) x[i] = features[i];
      x[FEATURES] = forestEvidence(forestLive);
      if (keep) {
        this.pending.push({time, x, live: false, weight: 0});
        while (this.pending.length && this.pending[0].time < time - PENDING_MS) this.commit(this.pending.shift());
      }
      return this.probability(x);
    }
    /*
     * Readings heard between [from] and [to] were the game ([live]) or an ad, with this [weight]. A
     * stronger label replaces a weaker one. Automatic game labels (onlyWhereForestAgrees) are kept only
     * where the forest also leaned toward the game, so they can't teach it a mistake.
     */
    label(from, to, live, weight, onlyWhereForestAgrees = false) {
      for (const row of this.pending) {
        if (row.time < from || row.time > to || weight < row.weight) continue;
        if (onlyWhereForestAgrees && (row.x[FEATURES] > 0) !== live) continue;
        row.live = live;
        row.weight = Math.fround(weight);
      }
    }
    /** Commits every labelled reading and refits; call at the end of a session. */
    flush() {
      while (this.pending.length) this.commit(this.pending.shift());
      this.refit();
    }
    reset() {
      this.live.clear();
      this.ad.clear();
      this.pending = [];
      this.fit = null;
      this.sinceFit = 0;
    }
    commit(row) {
      if (row.weight <= 0) return;
      (row.live ? this.live : this.ad).add(row.x, row.weight);
      if (++this.sinceFit >= REFIT_EVERY) this.refit();
    }
    probability(x) {
      const f = this.fit;
      if (!f) return sigmoid(x[FEATURES]);
      let s = f.bias + f.forestWeight * x[FEATURES];
      for (let i = 0; i < FEATURES; i++) s += f.w[i] * (x[i] - f.mean[i]) / f.sd[i];
      return sigmoid(s);
    }
    /** Class-balanced, weighted logistic regression by gradient descent, pulled toward the forest alone. */
    refit() {
      this.sinceFit = 0;
      const liveWeight = this.live.totalWeight(), adWeight = this.ad.totalWeight();
      if (liveWeight < MIN_CLASS_WEIGHT || adWeight < MIN_CLASS_WEIGHT) {
        this.fit = null;
        return;
      }
      const sets = [[this.live, true], [this.ad, false]];
      const n = this.live.size + this.ad.size;
      const mean = new Float64Array(FEATURES), sd = new Float64Array(FEATURES);
      for (const [set] of sets) for (let r = 0; r < set.size; r++) for (let i = 0; i < FEATURES; i++) mean[i] += set.rows[r * WIDTH + i];
      for (let i = 0; i < FEATURES; i++) mean[i] /= n;
      for (const [set] of sets) for (let r = 0; r < set.size; r++) for (let i = 0; i < FEATURES; i++) { const d = set.rows[r * WIDTH + i] - mean[i]; sd[i] += d * d; }
      for (let i = 0; i < FEATURES; i++) sd[i] = Math.sqrt(sd[i] / n) + 1e-6;
      // Each class carries half the total weight, however many examples it has.
      const total = liveWeight + adWeight;
      const liveScale = 0.5 * total / liveWeight, adScale = 0.5 * total / adWeight;
      const z = new Float64Array(DIM), w = new Float64Array(DIM), grad = new Float64Array(DIM);
      w[FEATURES] = 1;
      let bias = 0;
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        grad.fill(0);
        let gradBias = 0;
        for (const [set, isLive] of sets) {
          const scale = isLive ? liveScale : adScale, target = isLive ? 1 : 0;
          for (let r = 0; r < set.size; r++) {
            const at = r * WIDTH;
            for (let i = 0; i < FEATURES; i++) z[i] = (set.rows[at + i] - mean[i]) / sd[i];
            z[FEATURES] = set.rows[at + FEATURES];
            let s = bias;
            for (let i = 0; i < DIM; i++) s += w[i] * z[i];
            const err = (sigmoid(s) - target) * set.rows[at + DIM] * scale;
            for (let i = 0; i < DIM; i++) grad[i] += err * z[i];
            gradBias += err;
          }
        }
        for (let i = 0; i < DIM; i++) {
          const prior = i === FEATURES ? 1 : 0;
          w[i] -= STEP * (grad[i] + L2 * (w[i] - prior)) / total;
        }
        bias -= STEP * (gradBias + L2 * bias) / total;
      }
      this.fit = {mean, sd, w: w.slice(0, FEATURES), forestWeight: w[FEATURES], bias};
    }
    save() {
      const view = new DataView(new ArrayBuffer(4 + 4 + this.live.size * WIDTH * 4 + 4 + this.ad.size * WIDTH * 4));
      let at = 0;
      view.setInt32(at, MODEL_MAGIC); at += 4;
      for (const set of [this.live, this.ad]) {
        view.setInt32(at, set.size); at += 4;
        for (let i = 0; i < set.size * WIDTH; i++) { view.setFloat32(at, set.rows[i]); at += 4; }
      }
      return view.buffer;
    }
    load(buffer) {
      const view = new DataView(buffer);
      let at = 0;
      if (view.getInt32(at) !== MODEL_MAGIC) throw new Error('Not a SportsWitch personal model');
      at += 4;
      this.reset();
      const row = new Float32Array(WIDTH);
      for (const set of [this.live, this.ad]) {
        const size = view.getInt32(at); at += 4;
        for (let r = 0; r < size; r++) {
          for (let i = 0; i < WIDTH; i++) { row[i] = view.getFloat32(at); at += 4; }
          set.add(row, row[DIM]);
        }
      }
      this.refit();
    }
  }
  PersonalModel.centred = centred;
  PersonalModel.forestEvidence = forestEvidence;
  PersonalModel.FOREST_CUTOFF = FOREST_CUTOFF;

  // ---- One tab's readings -------------------------------------------------------------------------

  const WINDOW = 5 * C.RATE;        // the model was trained on five-second windows
  const READING_HOP = 32 * C.HOP;   // a reading every 1.024 s keeps windows on the frame grid
  const MIN_SEGMENT = 2 * C.RATE;
  const RECENT = 512, RECENT_MASK = RECENT - 1;

  /*
   * Turns one tab's capture into a reading about every second, as the Android app does for the TV.
   * Each reading normally classifies the latest five seconds. Right after a splice it classifies only
   * the audio since the splice (once there are two seconds of it), so a new ad is judged on its own
   * sound instead of waiting for the game to leave the window. Each reading is also scored by the
   * personal model and checked against learned ads; the watched tab is checked for repeats too.
   */
  class TabAnalyzer {
    constructor(tabId, inputRate, ctx) {
      this.tabId = tabId;
      this.inputRate = inputRate;
      this.ctx = ctx; // {constants, forest, fingerprints, personal, clock}
      this.resampler = new C.StreamResampler(inputRate, C.RATE);
      this.frames = new C.FrameStream(ctx.constants);
      this.splices = new SpliceDetector(inputRate);
      this.prints = new PrintMaker();
      this.recent = new Int32Array(RECENT);
      this.selected = false;
      this.onPower = (hop, power) => this.onPrint(power);
      this.flush();
    }
    /** Forget buffered audio, e.g. after the tab moved to another channel. */
    flush() {
      this.resampler.reset();
      this.frames.reset();
      this.splices.reset();
      this.prints.reset();
      this.printCount = 0;
      this.printsFrom = 0;
      this.printing = false;
      this.spliceSinceHop = false;
      this.lastSplice = -1;
      this.nextStart = 0;
      if (this.selected && this.ctx.fingerprints) this.ctx.fingerprints.resetStream();
    }
    /** The watched game: its audio goes into the history, and it alone is learned from. */
    setSelected(on) {
      if (on && !this.selected && this.ctx.fingerprints) this.ctx.fingerprints.resetStream();
      this.selected = on;
    }
    onPrint(power) {
      const print = this.prints.next(power);
      this.recent[this.printCount & RECENT_MASK] = print;
      this.printCount++;
      if (this.selected) this.ctx.fingerprints.pushPrint(print);
    }
    /** Feeds captured mono samples; returns a reading whenever one is due. */
    accept(pcm) {
      if (this.splices.accept(pcm, 0, pcm.length)) {
        this.spliceSinceHop = true;
        this.lastSplice = Math.floor(this.splices.lastSpliceAt * C.RATE / this.inputRate);
      }
      const resampled = this.resampler.process(pcm);
      if (resampled.length) this.frames.push(resampled);
      const fp = this.ctx.fingerprints;
      // Other tabs are fingerprinted only once there are learned ads to recognise.
      const wantPrints = !!fp && (this.selected || fp.entryCount > 0);
      if (wantPrints && !this.printing) {
        this.prints.reset();
        this.printsFrom = this.printCount;
      }
      this.printing = wantPrints;
      this.frames.advance(wantPrints, wantPrints ? this.onPower : null);

      const total = this.frames.total;
      if (total < this.nextStart + WINDOW) return null;
      while (total >= this.nextStart + WINDOW + READING_HOP) this.nextStart += READING_HOP; // fell behind: latest only
      const end = this.nextStart + WINDOW;
      this.nextStart += READING_HOP;
      let start = end - WINDOW;
      if (this.lastSplice >= 0) {
        const since = end - this.lastSplice;
        if (since >= MIN_SEGMENT && since < WINDOW) start = Math.ceil(this.lastSplice / C.HOP) * C.HOP;
      }
      const features = this.frames.features(start, end);
      let zeros = 0;
      for (let i = start; i < end; i++) if (this.frames.at(i) === 0) zeros++;
      const liveProbability = C.predictLive(features, this.ctx.forest);
      let knownAd = null, repeat = null;
      if (fp) {
        if (this.selected) {
          knownAd = fp.matchRecent();
          if (!knownAd) repeat = fp.matchRepeat();
        } else if (fp.entryCount > 0 && this.printCount - this.printsFrom >= QUERY_FRAMES) {
          const query = new Int32Array(QUERY_FRAMES);
          for (let i = 0; i < QUERY_FRAMES; i++) query[i] = this.recent[(this.printCount - QUERY_FRAMES + i) & RECENT_MASK];
          knownAd = fp.matchPrints(query);
        }
      }
      const splice = this.spliceSinceHop;
      this.spliceSinceHop = false;
      const time = this.ctx.clock();
      const adjustedLive = this.ctx.personal ? this.ctx.personal.predict(features, liveProbability, time, this.selected) : centred(liveProbability);
      return {
        tabId: this.tabId,
        /** The forest's live probability (its validated cutoff is 0.41). */
        liveProbability,
        /** Live probability adapted to this computer, centred so 0.5 means no opinion. */
        adjustedLive,
        energy: features[C.RMS_MEAN_INDEX],
        /** Share of exactly-zero samples: near 1 means the capture is blocked, not quiet. */
        zeroFraction: zeros / (end - start),
        splice,
        knownAd,
        repeat,
        features,
        /** Seconds of audio classified: under five when only the audio since a splice was used. */
        windowSeconds: (end - start) / C.RATE,
        time,
      };
    }
  }

  root.SportsWitchLearning = {
    SpliceDetector, PrintMaker, AdFingerprints, PersonalModel, TabAnalyzer, centred,
    LABEL_UNKNOWN, LABEL_GAME, LABEL_AD, LABEL_VIEWER_GAME, FRAMES_PER_SECOND, QUERY_FRAMES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
