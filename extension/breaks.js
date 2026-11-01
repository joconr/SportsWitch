/*
 * SportsWitch 4.2.0: runs "Customize your ad break" from the background, as the Android app's Breaks
 * does. While a session runs it keeps trivia, scores and the fantasy matchup fresh, shows them over a
 * muted ad, plays music during the break, and raises red-zone and fantasy-scoring alerts. Everything is
 * optional and combines on one screen. Only these extras use the internet; ad detection never does.
 *
 * Sign-ins: ESPN Fantasy reads the league with Chrome's own espn.com sign-in, so no password ever passes
 * through SportsWitch. Spotify plays in the viewer's own Spotify tab, signed in there as usual; SportsWitch
 * only presses its play and pause.
 */
'use strict';
const BREAK_PREFS_KEY = 'sportsWitchBreakPrefs';
const ACCOUNTS_KEY = 'sportsWitchAccounts';
const TRIVIA_DECK_KEY = 'sportsWitchTriviaDeck';
const TRIVIA_TOKEN_KEY = 'sportsWitchTriviaToken';
const BreakData = self.SportsWitchBreaks;
const SPOTIFY_NOT_HEARD = "Spotify didn't start. Press play once in the Spotify tab, then pause it.";
const BREAK_POLL_MS = 15000;
const QUESTION_MS = 15000;
const ANSWER_MS = 7000;
const OPEN_TDB_SPACING_MS = 5500;
const NFL_CHECK_MS = 5 * 60000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Small JSON requests for the extras; throws with .status for non-2xx answers. */
async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {...options, signal: controller.signal, headers: {Accept: 'application/json', ...(options.headers || {})}});
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      error.status = response.status;
      throw error;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const Accounts = {
  async get() {
    const stored = (await chrome.storage.local.get(ACCOUNTS_KEY))[ACCOUNTS_KEY] || {};
    return {fantasyTeam: null, ...stored};
  },
  /** 4.2 kept a Spotify developer-app sign-in; Spotify now plays in its own tab, so those tokens go. */
  async forgetSpotifySignIn() {
    const stored = (await chrome.storage.local.get(ACCOUNTS_KEY))[ACCOUNTS_KEY];
    if (!stored || !('spotifyTokens' in stored || 'spotifyClientId' in stored)) return;
    const {spotifyTokens, spotifyClientId, ...rest} = stored;
    await chrome.storage.local.set({[ACCOUNTS_KEY]: rest});
  },
  async set(changes) {
    const next = {...(await Accounts.get()), ...changes};
    await chrome.storage.local.set({[ACCOUNTS_KEY]: next});
    return next;
  },
  /** Chrome's own espn.com sign-in, if any. */
  async espnSession() {
    try {
      const [swid, s2] = await Promise.all([
        chrome.cookies.get({url: 'https://www.espn.com/', name: 'SWID'}),
        chrome.cookies.get({url: 'https://www.espn.com/', name: 'espn_s2'}),
      ]);
      return swid && swid.value ? {swid: swid.value, signedIn: !!(s2 && s2.value)} : null;
    } catch {
      return null;
    }
  },
  async espnLeagues() {
    const session = await Accounts.espnSession();
    if (!session || !session.signedIn) throw new Error('Sign in to ESPN in Chrome first (Open ESPN sign-in), then try again.');
    const json = await fetchText(BreakData.EspnFantasy.fanUrl(session.swid), {credentials: 'include'});
    return BreakData.EspnFantasy.parseLeagues(json, BreakData.fantasySeason());
  },
  async espnLeagueTeams(leagueId) {
    const json = await fetchText(BreakData.EspnFantasy.leagueUrl(BreakData.fantasySeason(), String(leagueId).trim()), {credentials: 'include'});
    return {leagueName: BreakData.EspnFantasy.leagueName(json), teams: BreakData.EspnFantasy.parseTeams(json)};
  },
};

/** The viewer's Spotify tab, looked up each time since tabs come and go. See SportsWitchBreaks.spotifyPage. */
const SpotifyTab = {
  /** The one playing, else the one used most recently. */
  async find() {
    const tabs = await chrome.tabs.query({url: BreakData.SpotifyWeb.MATCH});
    tabs.sort((a, b) => Number(b.audible) - Number(a.audible) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0] || null;
  },
  /** spotifyPage's answer from inside the tab; null while Chrome has the tab asleep or can't reach it. */
  async run(tab, action) {
    if (tab.discarded) return null;
    try {
      const [frame] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: BreakData.spotifyPage,
        args: [action, !!tab.audible]});
      return frame && frame.result ? frame.result : null;
    } catch {
      return null;
    }
  },
  /** Whether the tab is heard, or says it plays (on a speaker it is not heard here). */
  async heard(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.audible) return true;
    const page = await SpotifyTab.run(tab, 'state');
    return !!page && page.playback === 'playing';
  },
  /** For the settings page: none | asleep | signedOut | loading | ready, and what's loaded. */
  async status() {
    const tab = await SpotifyTab.find();
    if (!tab) return {state: 'none'};
    const page = await SpotifyTab.run(tab, 'state');
    if (!page) return {state: 'asleep'};
    return {state: !page.signedIn ? 'signedOut' : !page.ready && !page.session ? 'loading' : 'ready', track: page.track};
  },
  /** Brings the Spotify tab forward, or opens one, pinned so it stays out of the way. */
  async show() {
    const tab = await SpotifyTab.find();
    if (!tab) {
      await chrome.tabs.create({url: BreakData.SpotifyWeb.URL, pinned: true});
      return {opened: true};
    }
    await chrome.tabs.update(tab.id, {active: true});
    await chrome.windows.update(tab.windowId, {focused: true});
    return {opened: false};
  },
};

class Breaks {
  /*
   * host: lineup() → {games: [{id, title}], onScreen}; onGameAlert(id, text); onChanged();
   * offscreen(type, data) for the radio; duck(on) turns the ad down under the radio (or back to silent).
   */
  constructor(host) {
    this.host = host;
    this.prefs = {...BreakData.DEFAULT_BREAK_PREFS};
    this.deck = null;
    this.loaded = null;
    this.scores = [];
    this.fantasy = null;
    this.fantasyNote = null;
    this.musicLine = null;
    this.question = null;
    this.revealed = false;
    this.questionEndsAt = 0;
    /** Corner alerts waiting to be shown: fantasy scores and big moments. */
    this.alerts = [];
    this.alertSeq = 0;
    this.running = false;
    this.inBreak = false;
    this.previewUntil = 0;
    this.screenHidden = false;
    this.radioActive = false;
    this.radioCovering = false;
    this.stationRefreshed = null;
    /** {tabId} while Spotify plays because SportsWitch pressed play; one Spotify step at a time. */
    this.spotifyStarted = null;
    this.spotifyQueue = Promise.resolve();
    this.standingsFetched = false;
    this.refilling = false;
    this.nflLive = false;
    this.nflCheckedAt = 0;
    this.tick = 0;
    this.pollTimer = null;
    this.triviaTimer = null;
    this.gameAlerts = new BreakData.GameAlerts();
    this.scoring = new BreakData.ScoringWatcher();
  }

  load() {
    if (!this.loaded) this.loaded = (async () => {
      const stored = await chrome.storage.local.get([BREAK_PREFS_KEY, TRIVIA_DECK_KEY]);
      this.prefs = BreakData.breakPrefs(stored[BREAK_PREFS_KEY]);
      this.deck = new BreakData.TriviaDeck(stored[TRIVIA_DECK_KEY], queue => { void chrome.storage.local.set({[TRIVIA_DECK_KEY]: queue}); });
    })();
    return this.loaded;
  }
  changed() { this.host.onChanged(); }
  async offscreen(type, data) {
    try { return await this.host.offscreen(type, data); } catch { return null; }
  }

  get showing() {
    return (this.inBreak || Date.now() < this.previewUntil) && this.prefs.screen && BreakData.anyCard(this.prefs) && !this.screenHidden;
  }
  /** The viewer clicked the ad-break screen away, e.g. to browse the site, until this break ends. */
  hideScreen() {
    if (this.screenHidden) return;
    this.screenHidden = true;
    this.changed();
  }
  /** The ad is being turned down for the radio rather than muted. */
  get radioCoversAd() { return this.radioCovering; }

  async updatePrefs(changes) {
    await this.load();
    const old = this.prefs;
    const prefs = BreakData.changeBreakPrefs(old, changes);
    this.prefs = prefs;
    await chrome.storage.local.set({[BREAK_PREFS_KEY]: prefs});
    const radioChanged = JSON.stringify(prefs.radioStation) !== JSON.stringify(old.radioStation) || prefs.radio !== old.radio || prefs.silenceAd !== old.silenceAd;
    if (radioChanged) {
      // Changed mid-break: back to plain muting, then the new choice plays (nothing, if the radio was turned off).
      if (this.radioCovering) {
        this.radioCovering = false;
        await this.host.duck(false);
      }
      this.stationRefreshed = null;
      if (this.radioActive) await this.stopRadio();
      if (this.inBreak) await this.startRadio();
    } else if (prefs.musicVolume !== old.musicVolume) {
      // Heard at once when changed mid-break.
      await this.offscreen('RADIO_VOLUME', {volume: prefs.musicVolume});
    }
    if (prefs.spotify !== old.spotify && this.inBreak) this.spotify(prefs.spotify);
    if (this.running) this.schedulePoll(500);
    this.changed();
    return prefs;
  }

  // Session

  async startSession() {
    await this.load();
    if (this.running) return;
    this.running = true;
    this.standingsFetched = false;
    this.tick = 0;
    this.schedulePoll(0);
    void this.refillTrivia();
  }
  async stopSession() {
    this.running = false;
    clearTimeout(this.pollTimer);
    await this.endBreak();
    if (this.radioActive) await this.stopRadio();
  }
  schedulePoll(ms) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), ms);
  }
  async poll() {
    if (!this.running) return;
    const tick = this.tick++;
    // Scores every 30 s (every 15 s while a lineup game could be in the red zone).
    if (tick % 2 === 0 || (this.prefs.redZoneAlerts && this.host.lineup().games.length)) void this.fetchScores();
    // Fantasy every 45 s while an NFL game is on, every 10 minutes otherwise. The scores above say whether
    // one is on when they include the NFL; otherwise a look at the NFL scoreboard every 5 minutes.
    const scoresCoverNfl = this.prefs.scores && this.prefs.leagues.includes('NFL');
    if (await this.fantasyWanted() && !scoresCoverNfl && Date.now() - this.nflCheckedAt > NFL_CHECK_MS) void this.checkNfl();
    if (tick % 3 === 0 && (this.nflLive || tick % 40 === 0)) void this.fetchFantasy();
    if (this.deck.size < 15 && tick % 4 === 0) void this.refillTrivia();
    this.schedulePoll(BREAK_POLL_MS);
  }

  // Ad breaks

  /** SportsWitch muted (true) or unmuted (false) the ad being watched. */
  async onMuteChanged(muted) {
    await this.load();
    if (muted === this.inBreak) return;
    if (muted) await this.beginBreak(); else await this.endBreak();
  }
  async beginBreak() {
    this.inBreak = true;
    this.screenHidden = false;
    this.nextQuestion();
    await this.startRadio();
    if (this.prefs.spotify) this.spotify(true);
    this.changed();
  }
  async endBreak() {
    if (!this.inBreak) return;
    this.inBreak = false;
    this.screenHidden = false;
    this.question = null;
    clearTimeout(this.triviaTimer);
    if (this.radioActive) await this.stopRadio();
    this.radioCovering = false;
    if (this.prefs.spotify || this.spotifyStarted) this.spotify(false);
    this.changed();
  }
  /*
   * Radio on this computer. The ad is muted at once; once the station plays, the ad is turned down to
   * about 20% under it (or stays silent with "Silence the ad under the music"). Detection keeps hearing
   * the ad either way. If the station can't play, the ad simply stays muted.
   */
  async startRadio() {
    const station = this.prefs.radioStation;
    if (!this.prefs.radio || !station) return;
    this.radioActive = true;
    this.musicLine = `Tuning in ${station.name}…`;
    if (!await this.offscreen('RADIO_PLAY', {station, volume: this.prefs.musicVolume})) {
      this.radioActive = false;
      this.musicLine = null;
    }
  }
  async stopRadio() {
    this.radioActive = false;
    await this.offscreen('RADIO_STOP');
  }
  async onRadioEvent(e) {
    if (e.event === 'state') {
      if (!this.spotifyStarted) this.musicLine = e.line;
    } else if (e.event === 'playing') {
      this.musicLine = e.line;
      if (!this.inBreak) return void await this.stopRadio(); // the game came back while the station was tuning in
      if (!this.prefs.silenceAd) {
        this.radioCovering = true;
        await this.host.duck(true);
      }
    } else if (e.event === 'failed') {
      this.radioActive = false;
      this.musicLine = e.line;
      if (this.radioCovering) {
        this.radioCovering = false;
        if (this.inBreak) await this.host.duck(false);
      }
      void this.refreshStation(e.stationId);
    }
    this.changed();
  }
  /** Internet stations move to new addresses; Radio Browser knows the current one. Looks once. */
  async refreshStation(stationId) {
    const station = this.prefs.radioStation;
    if (!station || !station.id || station.id !== stationId || this.stationRefreshed === station.id) return;
    this.stationRefreshed = station.id;
    try {
      const url = BreakData.RadioBrowser.parseUrl(await fetchText(BreakData.RadioBrowser.clickUrl(station.id)));
      if (!url || url === station.url || !url.startsWith('https://') || (this.prefs.radioStation || {}).id !== station.id) return;
      console.info('[SportsWitch] Radio station moved; trying its new address:', station.name);
      const keep = this.stationRefreshed;
      await this.updatePrefs({radioStation: {...station, url}}); // plays it at once mid-break
      this.stationRefreshed = keep;
    } catch {}
  }

  /** Shows the ad-break screen for a while, outside a break, so it can be tried out. */
  async preview(seconds = 25) {
    await this.load();
    this.previewUntil = Date.now() + seconds * 1000;
    this.screenHidden = false;
    if (!this.question) this.nextQuestion();
    if (!this.scores.length) void this.fetchScores();
    if (!this.fantasy) void this.fetchFantasy();
    if (this.deck.size < 5) void this.refillTrivia();
    this.changed();
    setTimeout(() => this.changed(), seconds * 1000 + 100);
  }

  // Trivia

  nextQuestion() {
    clearTimeout(this.triviaTimer);
    if (!this.prefs.trivia) {
      this.question = null;
      return;
    }
    this.question = this.deck.next();
    this.revealed = false;
    this.questionEndsAt = Date.now() + QUESTION_MS;
    if (this.question) this.triviaTimer = setTimeout(() => this.triviaStep(), QUESTION_MS);
    else this.triviaTimer = setTimeout(() => { this.nextQuestion(); this.changed(); }, 3000);
  }
  triviaStep() {
    if (!this.showing) return;
    if (!this.revealed) {
      this.revealed = true;
      this.questionEndsAt = Date.now() + ANSWER_MS;
      this.triviaTimer = setTimeout(() => { if (this.showing) { this.nextQuestion(); this.changed(); } }, ANSWER_MS);
    }
    this.changed();
  }
  async refillTrivia() {
    await this.load();
    if (this.refilling) return;
    this.refilling = true;
    try {
      const topics = BreakData.shuffle(this.prefs.triviaTopics.length ? this.prefs.triviaTopics : BreakData.DEFAULT_TOPICS).slice(0, 3).map(k => BreakData.TOPIC[k]);
      const leagues = this.prefs.leagues.map(k => BreakData.LEAGUE[k]).filter(l => ['football', 'basketball', 'hockey', 'baseball'].includes(l.sport) && !l.groups);
      const wantStandings = !this.standingsFetched;
      this.standingsFetched = true;
      // This season's standings first: ESPN answers quickly, so a first break has questions at once.
      if (wantStandings && this.prefs.trivia) for (const league of leagues) {
        try { this.deck.add(BreakData.StandingsTrivia.generate(await fetchText(BreakData.standingsUrl(league)), league)); }
        catch (e) { console.info('[SportsWitch] Standings trivia', league.key, e.message); }
      }
      // Open Trivia DB allows one request per five seconds, the token request included.
      let token = (await chrome.storage.local.get(TRIVIA_TOKEN_KEY))[TRIVIA_TOKEN_KEY] || null;
      if (!token) {
        try {
          token = BreakData.OpenTrivia.parseToken(await fetchText(BreakData.OpenTrivia.tokenUrl()));
          if (token) await chrome.storage.local.set({[TRIVIA_TOKEN_KEY]: token});
        } catch {}
        await sleep(OPEN_TDB_SPACING_MS);
      }
      for (let i = 0; i < topics.length; i++) {
        if (i > 0) await sleep(OPEN_TDB_SPACING_MS);
        try {
          const url = BreakData.OpenTrivia.questionsUrl(topics[i], 12, token);
          let result = BreakData.OpenTrivia.parse(await fetchText(url), topics[i]);
          if (result.code === 5) { // too soon: wait out the limit once
            await sleep(OPEN_TDB_SPACING_MS);
            result = BreakData.OpenTrivia.parse(await fetchText(url), topics[i]);
          }
          if (result.code === 0) this.deck.add(result.questions);
          else if (result.code === 3 || result.code === 4) await chrome.storage.local.remove(TRIVIA_TOKEN_KEY); // token unknown or every question seen
        } catch (e) {
          console.info('[SportsWitch] Trivia fetch failed:', e.message);
        }
      }
    } finally {
      this.refilling = false;
    }
  }

  // Scores and big moments

  async fetchScores() {
    const {games} = this.host.lineup();
    const alertsWanted = this.prefs.redZoneAlerts && games.length > 0;
    const keys = new Set();
    if (this.prefs.scores || this.showing) this.prefs.leagues.forEach(k => keys.add(k));
    if (alertsWanted) ['NFL', 'NCAAF', 'NCAAF_FCS', 'NBA'].forEach(k => keys.add(k));
    if (!keys.size) return;
    const all = [];
    for (const key of keys) {
      const league = BreakData.LEAGUE[key];
      try { all.push(...BreakData.parseScoreboard(await fetchText(BreakData.scoreboardUrl(league)), league)); }
      catch (e) { console.info('[SportsWitch] Scores', key, e.message); }
    }
    this.scores = all;
    if (keys.has('NFL')) this.noteNfl(all);
    if (alertsWanted) {
      const lineup = this.host.lineup();
      for (const alert of this.gameAlerts.check(lineup.games.map(g => [g.id, g.title]), lineup.onScreen, all, Date.now())) {
        this.pushAlert(`🏈 ${alert.text}`, {watchId: alert.gameId});
        this.host.onGameAlert(alert.gameId, alert.text);
      }
    }
    this.changed();
  }
  /** The scores to show: live games first, then upcoming, then finals, from the chosen leagues. */
  tickerGames() {
    const order = {in: 0, pre: 1};
    const rank = key => BreakData.LEAGUES.findIndex(l => l.key === key);
    return this.scores.filter(g => this.prefs.leagues.includes(g.league))
      .sort((a, b) => ((order[a.state] ?? 2) - (order[b.state] ?? 2)) || (rank(a.league) - rank(b.league)));
  }

  // Fantasy

  async fantasyWanted() {
    const accounts = await Accounts.get();
    return !!accounts.fantasyTeam && (this.prefs.fantasyCard || this.prefs.fantasyAlerts);
  }
  async checkNfl() {
    this.nflCheckedAt = Date.now();
    try { this.noteNfl(BreakData.parseScoreboard(await fetchText(BreakData.scoreboardUrl(BreakData.LEAGUE.NFL)), BreakData.LEAGUE.NFL)); }
    catch (e) { console.info('[SportsWitch] NFL check:', e.message); }
  }
  noteNfl(games) {
    const wasLive = this.nflLive;
    this.nflLive = games.some(g => g.league === 'NFL' && BreakData.isLive(g));
    this.nflCheckedAt = Date.now();
    if (this.nflLive && !wasLive && this.running) void this.fetchFantasy(); // kickoff: catch up at once
  }
  async fetchFantasy() {
    const team = (await Accounts.get()).fantasyTeam;
    if (!team || (!this.prefs.fantasyCard && !this.prefs.fantasyAlerts)) return;
    try {
      const json = await fetchText(BreakData.EspnFantasy.leagueUrl(BreakData.fantasySeason(), team.leagueId), {credentials: 'include'});
      const snapshot = BreakData.EspnFantasy.parseSnapshot(json, team.teamId);
      this.fantasy = snapshot;
      this.fantasyNote = snapshot ? null : "Couldn't find your team in that league.";
      if (snapshot && this.prefs.fantasyAlerts) {
        for (const s of this.scoring.update(snapshot).slice(0, 3)) {
          const opponent = snapshot.opponentScore != null ? ` – ${snapshot.opponentScore.toFixed(1)}` : '';
          this.pushAlert(`+${s.gained.toFixed(1)} ${s.player}${s.reason ? ` · ${s.reason}` : ''} · You ${snapshot.myScore.toFixed(1)}${opponent}`);
        }
      }
    } catch (e) {
      this.fantasyNote = e.status === 401 ? 'ESPN sign-in expired. Sign in to espn.com in Chrome again.' : 'Fantasy scores unavailable right now.';
    }
    this.changed();
  }

  // Spotify

  /*
   * Plays (true) or pauses (false) the viewer's Spotify tab for a break. Steps run one at a time, so a
   * break that ends while the music is starting still pauses it. Only music SportsWitch started is paused.
   */
  spotify(play) {
    void this.spotifyStep(async () => {
      if (!play) {
        await this.pauseSpotify();
        this.setMusic(null);
        return;
      }
      if (!this.inBreak) return; // the game came back first
      const started = await this.playSpotify();
      this.setMusic(started.line);
      if (!started.ok) return;
      // Chrome lets a tab start music only once the viewer has played some in it; say so if none is heard.
      setTimeout(() => void (async () => {
        if (this.inBreak && this.spotifyStarted && !await SpotifyTab.heard(started.tabId)) this.setMusic(SPOTIFY_NOT_HEARD);
      })(), 3000);
    }).catch(() => {});
  }
  spotifyStep(work) {
    const step = this.spotifyQueue.then(work);
    this.spotifyQueue = step.catch(e => console.info('[SportsWitch] Spotify:', e.message));
    return step;
  }
  /** Presses play in the Spotify tab. {ok, tabId, line}: line is the music line on the ad-break screen. */
  async playSpotify() {
    const tab = await SpotifyTab.find();
    if (!tab) return {ok: false, line: "Spotify isn't open in Chrome. Open it from Customize your ad break."};
    // Keep it awake between breaks; Chrome may otherwise free the memory of a paused tab.
    chrome.tabs.update(tab.id, {autoDiscardable: false}).catch(() => {});
    const page = await SpotifyTab.run(tab, 'play');
    if (!page) return {ok: false, line: 'Chrome put the Spotify tab to sleep. Click that tab once to wake it.'};
    if (!page.signedIn) return {ok: false, line: 'Sign in to Spotify in its tab.'};
    if (!page.ready && !page.session) return {ok: false, line: "Spotify's player isn't ready. Open its tab and choose something to play."};
    if (page.via) this.spotifyStarted = {tabId: tab.id};
    return {ok: true, tabId: tab.id, line: `♪ Spotify${page.track ? ` · ${page.track}` : ''}`};
  }
  async pauseSpotify() {
    const started = this.spotifyStarted;
    this.spotifyStarted = null;
    if (!started) return;
    const tab = await chrome.tabs.get(started.tabId).catch(() => null);
    if (tab) await SpotifyTab.run(tab, 'pause');
  }
  /** "Try it" in the settings: about five seconds of Spotify, then paused again. */
  async trySpotify() {
    if (this.inBreak) return {ok: false, message: 'Try it again once this ad break is over.'};
    const started = await this.spotifyStep(() => this.playSpotify());
    if (!started.ok) return {ok: false, message: started.line};
    await sleep(5000);
    const heard = await SpotifyTab.heard(started.tabId);
    if (!this.inBreak) await this.spotifyStep(() => this.pauseSpotify()); // a break that began meanwhile keeps it
    return heard ? {ok: true, message: 'Spotify played. It will play during ad breaks.'} : {ok: false, message: SPOTIFY_NOT_HEARD};
  }
  setMusic(line) {
    if (!this.radioActive) this.musicLine = line;
    this.changed();
  }

  // What the pages show

  pushAlert(text, extra = {}) {
    this.alerts.push({id: ++this.alertSeq, text, ...extra});
    if (this.alerts.length > 10) this.alerts.shift();
    this.changed();
  }
  /** Alerts not yet shown in the watched tab; each is shown once. */
  takeAlerts() {
    const out = this.alerts;
    this.alerts = [];
    return out;
  }
  /** Everything the ad-break screen draws, for the watched tab and for the controller's preview. */
  screenModel(gameName, now = Date.now()) {
    const p = this.prefs;
    let trivia = null;
    if (p.trivia) {
      const q = this.question;
      trivia = q ? {topic: q.topic.toUpperCase(), question: q.question, answers: q.answers, correct: q.correct, revealed: this.revealed,
        detail: q.detail, source: q.source, endsAt: this.questionEndsAt, total: this.revealed ? ANSWER_MS : QUESTION_MS} : {loading: true};
    }
    let fantasy = null;
    if (p.fantasyCard && (this.fantasy || this.fantasyNote)) {
      const f = this.fantasy;
      fantasy = f ? {
        label: `FANTASY · WEEK ${f.week}`,
        score: f.myScore.toFixed(1) + (f.opponentScore != null ? `  –  ${f.opponentScore.toFixed(1)}` : ''),
        winning: f.opponentScore != null ? f.myScore >= f.opponentScore : null,
        vs: f.mine.name + (f.opponent ? ` vs ${f.opponent.name}` : ''),
        lines: this.fantasyNote ? [this.fantasyNote] : f.roster.filter(x => x.starter).sort((a, b) => b.points - a.points).slice(0, 4)
          .map(x => `${x.slot} · ${x.name}  ${x.points.toFixed(1)}`),
      } : {label: 'FANTASY', score: '', winning: null, vs: '', lines: [this.fantasyNote]};
    }
    const locale = undefined;
    return {
      title: this.radioCovering ? `${gameName} · ad turned down for the radio. Back to the game soon.` : `${gameName} · muted. Back to the game soon.`,
      music: this.musicLine,
      trivia, fantasy,
      scores: p.scores ? this.tickerGames().map(g => ({line: BreakData.scoreLine(g), detail: BreakData.tickerDetail(g, now, locale),
        live: BreakData.isLive(g), redZone: g.redZone})) : [],
    };
  }
  /** "YOUR AD BREAKS" on the popup and controller. */
  async summary() {
    const p = this.prefs, accounts = await Accounts.get();
    const parts = [];
    if (p.screen && p.trivia) parts.push(`Trivia (${p.triviaTopics.length} topics)`);
    if (p.screen && p.scores) parts.push(`Scores: ${BreakData.LEAGUES.filter(l => p.leagues.includes(l.key)).map(l => l.label).join(', ') || 'no leagues'}`);
    if (accounts.fantasyTeam && (p.fantasyCard || p.fantasyAlerts)) parts.push(`Fantasy: ${accounts.fantasyTeam.teamName}`);
    if (p.radio && p.radioStation) parts.push(`Radio: ${p.radioStation.name}`);
    if (p.spotify) parts.push('Spotify');
    if (p.redZoneAlerts) parts.push('Red-zone alerts');
    return parts.length ? parts.join(' · ') : 'Just muting. Add trivia, scores, fantasy football or music with Customize.';
  }
}
