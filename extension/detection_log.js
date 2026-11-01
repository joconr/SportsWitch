/*
 * SportsWitch 4.2.0 detection log: a per-second record of what SportsWitch heard on the watched game
 * and decided, with the model's 46 features, plus the viewer's "That's an ad / That's the game"
 * corrections. No audio is stored. Same columns as the Android app's logs, so tools/retrain_from_logs.py
 * reads both. Kept in the extension's own storage on this computer (IndexedDB), at most 50 MB with the
 * oldest sessions deleted first; Settings › Display & data › Detection logs downloads them as CSV files.
 * Off unless the viewer turns it on, because it records what was on.
 */
'use strict';
const DetectionLog = (() => {
  const DB_NAME = 'sportswitch-logs';
  const KEEP_FILES = 30;
  /** The whole log; a session writes about 2 MB an hour. */
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const VALUES = 11, FEATURES = 46;
  const CLASS_NAMES = {Live: 'LIVE', Commercial: 'COMMERCIAL', Uncertain: 'UNCERTAIN'};
  /** p_live is the forest's score; p_adjusted is after the personal model (0.5 = no opinion). */
  const HEADER = ['elapsed_ms', 'epoch_ms', 'event', 'mode', 'p_live', 'p_adjusted', 'energy', 'zero_fraction', 'splice',
    'window_s', 'known_ad', 'known_ad_ber', 'repeat_lag_s', 'repeat_ber', 'repeat_earlier', 'classification', 'ad_probability',
    'ad_active', 'muted', 'current_game', 'now_title', 'now_channel', ...Array.from({length: FEATURES}, (_, i) => `f${i}`)].join(',');
  let current = null;
  let buffer = [];
  let writing = Promise.resolve();

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('sessions', {keyPath: 'id', autoIncrement: true});
        db.createObjectStore('lines', {autoIncrement: true}).createIndex('session', 'session');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transaction(stores, mode, work) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        Promise.resolve(work(tx)).then(r => { result = r; }, reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  /** Runs log writes one after another, never letting a failure stop later ones. */
  function queue(work) {
    writing = writing.then(work).catch(err => console.warn('[SportsWitch] Detection log:', err.message));
    return writing;
  }
  const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
    `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const quote = s => '"' + String(s || '').replace(/"/g, '""') + '"';

  async function sessions() {
    return transaction(['sessions'], 'readonly', tx => request(tx.objectStore('sessions').getAll()));
  }
  async function remove(ids) {
    if (!ids.length) return;
    await transaction(['sessions', 'lines'], 'readwrite', async tx => {
      const index = tx.objectStore('lines').index('session');
      for (const id of ids) {
        tx.objectStore('sessions').delete(id);
        const keys = await request(index.getAllKeys(IDBKeyRange.only(id)));
        for (const key of keys) tx.objectStore('lines').delete(key);
      }
    });
  }
  /** Keeps the newest sessions: at most KEEP_FILES, and MAX_TOTAL_BYTES counting the one about to start. */
  async function prune() {
    const all = (await sessions()).sort((a, b) => b.startedAt - a.startedAt);
    let total = 0;
    const doomed = all.filter((s, i) => { total += s.bytes; return i >= KEEP_FILES - 1 || total > MAX_TOTAL_BYTES - MAX_FILE_BYTES; }).map(s => s.id);
    await remove(doomed);
  }
  async function flush() {
    if (!buffer.length || !current) return;
    const rows = buffer;
    buffer = [];
    const session = {...current};
    await transaction(['sessions', 'lines'], 'readwrite', tx => {
      for (const row of rows) tx.objectStore('lines').add(row);
      tx.objectStore('sessions').put({id: session.id, name: session.name, startedAt: session.startedAt, bytes: session.bytes});
    });
  }
  async function startSession() {
    await flush();
    await prune();
    const startedAt = Date.now();
    const name = `session-${stamp(new Date(startedAt))}.csv`;
    const id = await transaction(['sessions'], 'readwrite', tx => request(tx.objectStore('sessions').add({name, startedAt, bytes: HEADER.length + 1})));
    current = {id, name, startedAt, bytes: HEADER.length + 1, rows: 0};
  }
  function write(line) {
    if (!current) return;
    buffer.push({session: current.id, line});
    current.bytes += line.length + 1;
    if (++current.rows % 10 === 0) void queue(flush);
    // A session left running for a day would outgrow the log on its own: go on in a new file.
    if (current.bytes > MAX_FILE_BYTES) void queue(startSession);
  }
  function row(now, event, engine, values, features) {
    const s = engine.s;
    const game = s.games.find(g => g.id === s.currentId);
    return [Math.round(now), Date.now(), quote(event), s.mode.toUpperCase(), ...values,
      s.lastClassification ? CLASS_NAMES[s.lastClassification] : '', engine.adProbability().toFixed(4), s.adActive ? 1 : 0, s.muted ? 1 : 0,
      quote(game ? game.manualTitle || game.displayTitle || game.title : ''), quote(game ? game.title : ''), quote(game ? game.site : ''),
      ...(features ? features.map(f => Number(f).toPrecision(6)) : Array(FEATURES).fill(''))].join(',');
  }

  return {
    open() { current = null; return queue(startSession); },
    close() { return queue(async () => { await flush(); current = null; }); },
    /** Logged after the engine has taken the watched game's reading into account. */
    reading(now, r, engine) {
      write(row(now, 'reading', engine, [r.liveProbability.toFixed(4), r.adjustedLive.toFixed(4), r.energy.toFixed(5),
        r.zeroFraction.toFixed(3), r.splice ? '1' : '0', r.windowSeconds.toFixed(1), r.knownAd ? String(r.knownAd.entryId) : '',
        r.knownAd ? r.knownAd.bitErrorRate.toFixed(3) : '', r.repeat ? r.repeat.lagSeconds.toFixed(0) : '',
        r.repeat ? r.repeat.bitErrorRate.toFixed(3) : '', r.repeat ? String(r.repeat.earlier) : ''], r.features));
    },
    event(now, name, engine) { write(row(now, name, engine, Array(VALUES).fill(''), null)); },
    async list() {
      await queue(flush);
      return (await sessions()).sort((a, b) => b.startedAt - a.startedAt).map(s => ({id: s.id, name: s.name, startedAt: s.startedAt, bytes: s.bytes}));
    },
    async csv(id) {
      await queue(flush);
      const lines = await transaction(['lines'], 'readonly', tx => request(tx.objectStore('lines').index('session').getAll(IDBKeyRange.only(id))));
      return [HEADER, ...lines.map(l => l.line)].join('\n') + '\n';
    },
    async clear() {
      await queue(async () => {
        buffer = [];
        const keep = current ? current.id : null;
        await remove((await sessions()).map(s => s.id).filter(id => id !== keep));
        if (keep !== null) await transaction(['lines'], 'readwrite', async tx => {
          const keys = await request(tx.objectStore('lines').index('session').getAllKeys(IDBKeyRange.only(keep)));
          for (const key of keys) tx.objectStore('lines').delete(key);
        });
      });
    },
  };
})();
