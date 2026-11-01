/*
 * SportsWitch 4.2.0 "Customize your ad break": the data side, ported from the Android app. Pure
 * functions over the services' JSON, so they can be tested with recorded answers:
 * - Open Trivia DB (opentdb.com, CC BY-SA 4.0) and questions made from this week's ESPN standings;
 * - ESPN's public scoreboard, red-zone and close-finish alerts for lineup games;
 * - ESPN Fantasy Football (the API espn.com's own pages use);
 * - Radio Browser (radio-browser.info) stations;
 * - Spotify's web player in a Chrome tab, with the viewer's own account (4.3.0).
 */
(function (root) {
  'use strict';
  const str = v => (v === undefined || v === null ? '' : String(v));
  const int = v => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  const num = (v, fallback) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : fallback; };
  const encode = v => encodeURIComponent(v);
  function shuffle(list, random = Math.random) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ---- What the viewer can pick ---------------------------------------------------------------------

  /** Leagues SportsWitch can show scores for. [tag] is the score ticker's short name. */
  const LEAGUES = [
    {key: 'NFL', label: 'NFL', sport: 'football', path: 'nfl', football: true},
    {key: 'NCAAF', label: 'College football', sport: 'football', path: 'college-football', groups: '80', football: true, tag: 'CFB'},
    {key: 'NCAAF_FCS', label: 'FCS & HBCU football', sport: 'football', path: 'college-football', groups: '81', football: true, tag: 'FCS'},
    {key: 'NBA', label: 'NBA', sport: 'basketball', path: 'nba'},
    {key: 'WNBA', label: 'WNBA', sport: 'basketball', path: 'wnba'},
    {key: 'NCAAM', label: "Men's college basketball", sport: 'basketball', path: 'mens-college-basketball', tag: 'CBB'},
    {key: 'NHL', label: 'NHL', sport: 'hockey', path: 'nhl'},
    {key: 'MLB', label: 'MLB', sport: 'baseball', path: 'mlb'},
    {key: 'MLS', label: 'MLS', sport: 'soccer', path: 'usa.1'},
    {key: 'EPL', label: 'Premier League', sport: 'soccer', path: 'eng.1', tag: 'EPL'},
  ].map(l => ({football: false, groups: null, tag: l.label, ...l}));
  const LEAGUE = Object.fromEntries(LEAGUES.map(l => [l.key, l]));
  const scoreboardUrl = league => `https://site.api.espn.com/apis/site/v2/sports/${league.sport}/${league.path}/scoreboard` +
    (league.groups ? `?groups=${league.groups}&limit=200` : '');
  const standingsUrl = league => `https://site.api.espn.com/apis/v2/sports/${league.sport}/${league.path}/standings`;

  /** Open Trivia DB categories that suit a family room. */
  const TRIVIA_TOPICS = [
    {key: 'SPORTS', label: 'Sports', category: 21}, {key: 'FILM', label: 'Movies', category: 11},
    {key: 'TV', label: 'TV', category: 14}, {key: 'MUSIC', label: 'Music', category: 12},
    {key: 'VIDEO_GAMES', label: 'Video games', category: 15}, {key: 'BOARD_GAMES', label: 'Board games', category: 16},
    {key: 'CARTOONS', label: 'Cartoons', category: 32}, {key: 'GENERAL', label: 'General knowledge', category: 9},
    {key: 'SCIENCE', label: 'Science & nature', category: 17}, {key: 'GEOGRAPHY', label: 'Geography', category: 22},
    {key: 'ANIMALS', label: 'Animals', category: 27},
  ];
  const TOPIC = Object.fromEntries(TRIVIA_TOPICS.map(t => [t.key, t]));
  const DEFAULT_TOPICS = ['SPORTS', 'FILM', 'TV', 'MUSIC', 'VIDEO_GAMES', 'GENERAL'];
  const RADIO_GENRES = ['classic rock', 'pop', 'hip hop', 'country', '80s', '90s', 'rock', 'jazz', 'chillout',
    'lofi', 'dance', 'oldies', 'r&b', 'latin', 'christian', 'christmas', 'sports talk'];

  /*
   * What SportsWitch shows and plays while an ad is muted. Every piece is optional and they combine
   * on one screen: trivia and the fantasy matchup side by side, scores along the bottom, music
   * underneath, alerts in the corner. The same choices and defaults as the Android app.
   */
  const DEFAULT_BREAK_PREFS = Object.freeze({
    screen: true, trivia: true, triviaTopics: DEFAULT_TOPICS, scores: true, leagues: ['NFL', 'NCAAF'],
    fantasyCard: true, fantasyAlerts: true, redZoneAlerts: true,
    radio: false, radioGenre: RADIO_GENRES[0], radioStation: null,
    spotify: false,
    musicVolume: 70, silenceAd: false,
  });
  function breakPrefs(stored) {
    const o = stored && typeof stored === 'object' ? stored : {};
    const d = DEFAULT_BREAK_PREFS;
    const bool = (k) => typeof o[k] === 'boolean' ? o[k] : d[k];
    const keys = (k, valid, fallback) => Array.isArray(o[k]) ? [...new Set(o[k].filter(x => valid[x]))] : [...fallback];
    const station = o.radioStation && typeof o.radioStation === 'object' && str(o.radioStation.url)
      ? {id: str(o.radioStation.id), name: RadioBrowser.cleanName(str(o.radioStation.name)), url: str(o.radioStation.url),
        codec: str(o.radioStation.codec), bitrate: int(o.radioStation.bitrate)} : null;
    const radio = bool('radio');
    return {
      screen: bool('screen'), trivia: bool('trivia'), triviaTopics: keys('triviaTopics', TOPIC, d.triviaTopics),
      scores: bool('scores'), leagues: keys('leagues', LEAGUE, d.leagues),
      fantasyCard: bool('fantasyCard'), fantasyAlerts: bool('fantasyAlerts'), redZoneAlerts: bool('redZoneAlerts'),
      radio, radioGenre: RADIO_GENRES.includes(o.radioGenre) ? o.radioGenre : d.radioGenre, radioStation: station,
      // Both play on this computer; 4.2 choices with both on keep the radio.
      spotify: bool('spotify') && !radio,
      musicVolume: Math.min(100, Math.max(10, Number.isInteger(o.musicVolume) ? o.musicVolume : d.musicVolume)),
      silenceAd: bool('silenceAd'),
    };
  }
  /** The viewer's change on top of the current choices: picking the radio turns Spotify off, and the other way round. */
  function changeBreakPrefs(current, changes) {
    const next = {...current, ...changes};
    if (changes.radio === true) next.spotify = false;
    if (changes.spotify === true) next.radio = false;
    return breakPrefs(next);
  }
  const anyCard = p => p.trivia || p.scores || p.fantasyCard;
  const anyMusic = p => p.radio || p.spotify;

  // ---- Trivia ---------------------------------------------------------------------------------------

  /** Topics nobody wants as a talking point in front of the kids. */
  const UNSUITABLE = /\b(death|died|dies|dead|kill\w*|murder\w*|suicide|war|nazi\w*|drug\w*|alcohol|beer|vodka|whisk(e)?y|sex\w*|crash\w*|tragic|tragedy|terror\w*|bomb\w*|blood\w*|gun\w*|shoot\w*|prison|cancer|disease|nude|naked|porn\w*)\b/i;
  function decodeBase64(text) {
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim();
  }
  /*
   * Thousands of community-written, reviewed questions, free and without a key. A session token means
   * no question repeats until the pool is used up. One request per five seconds, the token request included.
   */
  const OpenTrivia = {
    SOURCE: 'Open Trivia DB',
    tokenUrl: () => 'https://opentdb.com/api_token.php?command=request',
    questionsUrl: (topic, amount, token) => `https://opentdb.com/api.php?amount=${amount}&category=${topic.category}&type=multiple&encode=base64` +
      (token ? `&token=${token}` : ''),
    parseToken(json) {
      const o = JSON.parse(json);
      return int(o.response_code) === 0 && str(o.token) ? str(o.token) : null;
    },
    suitable(question, right, wrong) {
      return ![question, right, ...wrong].some(t => UNSUITABLE.test(t)) && question.length <= 160 && wrong.length === 3;
    },
    /** Response code (0 ok, 4 token used up, 5 too many requests) and the suitable questions, answers shuffled. */
    parse(json, topic, random = Math.random) {
      const o = JSON.parse(json);
      const questions = [];
      for (const r of o.results || []) {
        const question = decodeBase64(r.question), right = decodeBase64(r.correct_answer);
        const wrong = (r.incorrect_answers || []).map(decodeBase64);
        if (!OpenTrivia.suitable(question, right, wrong)) continue;
        const answers = shuffle([...wrong, right], random);
        questions.push({topic: topic.label, question, answers, correct: answers.indexOf(right), source: OpenTrivia.SOURCE, detail: null});
      }
      return {code: o.response_code === undefined ? 1 : int(o.response_code), questions};
    },
  };
  /** Questions that are true this week, from ESPN standings: "Which of these teams has the best record in the AFC right now?" */
  const StandingsTrivia = {
    SOURCE: 'ESPN standings',
    generate(json, league, random = Math.random, count = 3) {
      const root = JSON.parse(json);
      const groups = [];
      for (const child of root.children || []) {
        const entries = child.standings && child.standings.entries;
        if (!entries) continue;
        const teams = [];
        for (const entry of entries) {
          let record = null, percent = null;
          for (const s of entry.stats || []) {
            if (s.name === 'overall') record = str(s.displayValue);
            else if (s.name === 'winPercent') { const value = num(s.value, null); percent = value !== null ? value : num(s.displayValue, null); }
          }
          const name = entry.team && entry.team.displayName;
          if (name && record !== null && percent !== null && Number.isFinite(percent)) teams.push({name: str(name), record, winPercent: percent});
        }
        if (teams.length >= 4) groups.push([str(child.abbreviation) || str(child.name), teams]);
      }
      const questions = [];
      for (let attempt = 0; attempt < count * 3 && questions.length < count && groups.length; attempt++) {
        const [group, teams] = groups[Math.floor(random() * groups.length)];
        const pick = shuffle(teams, random).slice(0, 4);
        const best = pick.reduce((a, b) => (b.winPercent > a.winPercent ? b : a));
        // Ties would make the answer ambiguous.
        if (pick.filter(t => t.winPercent === best.winPercent).length > 1) continue;
        const names = pick.map(t => t.name);
        if (questions.some(q => q.answers.length === names.length && names.every(n => q.answers.includes(n)))) continue;
        questions.push({topic: `${league.label} this week`, question: `Which of these teams has the best record in the ${group} right now?`,
          answers: names, correct: pick.indexOf(best), source: StandingsTrivia.SOURCE,
          detail: [...pick].sort((a, b) => b.winPercent - a.winPercent).map(t => `${t.name} ${t.record}`).join(' · ')});
      }
      return questions;
    },
  };
  /** The questions waiting to be shown, refilled in the background and saved, so a first break (or one without internet) has questions. */
  class TriviaDeck {
    constructor(saved, onSave = () => {}, random = Math.random) {
      this.queue = Array.isArray(saved) ? saved.filter(q => q && q.question && Array.isArray(q.answers)) : [];
      this.seen = [];
      this.onSave = onSave;
      this.random = random;
    }
    get size() { return this.queue.length; }
    next() {
      const q = this.queue.shift() || null;
      if (q) {
        this.seen.push(q.question);
        if (this.seen.length > 500) this.seen.shift();
        this.onSave(this.queue);
      }
      return q;
    }
    /** Adds fresh questions, mixed in among the waiting ones, skipping any shown recently. */
    add(questions) {
      const fresh = questions.filter(q => !this.seen.includes(q.question) && !this.queue.some(w => w.question === q.question));
      this.queue = shuffle([...this.queue, ...fresh], this.random).slice(-200);
      this.onSave(this.queue);
    }
  }

  // ---- Scores ---------------------------------------------------------------------------------------

  function parseScoreboard(json, league) {
    const games = [];
    for (const event of JSON.parse(json).events || []) {
      const competition = (event.competitions || [])[0];
      if (!competition || !competition.competitors) continue;
      let away = null, home = null;
      const ids = {};
      for (const c of competition.competitors) {
        const team = c.team;
        if (!team) continue;
        const side = {name: str(team.displayName), shortName: str(team.shortDisplayName), abbrev: str(team.abbreviation),
          score: str(c.score) === '' || !Number.isFinite(Number(c.score)) ? null : int(c.score), location: str(team.location)};
        ids[str(team.id)] = side.abbrev;
        if (str(c.homeAway) === 'home') home = side; else away = side;
      }
      if (!away || !home) continue;
      const status = competition.status || event.status || null;
      const type = status && status.type;
      const situation = competition.situation;
      const start = Date.parse(str(competition.date) || str(event.date));
      games.push({
        id: str(event.id), league: league.key, name: str(event.name), away, home,
        state: type ? str(type.state) || 'pre' : 'pre', detail: type ? str(type.shortDetail) : '',
        period: status ? int(status.period) : 0, clockSeconds: status ? num(status.clock, 0) : 0,
        redZone: !!(situation && situation.isRedZone),
        possession: situation && situation.possession != null ? ids[str(situation.possession)] || null : null,
        downDistance: situation && str(situation.downDistanceText) || null,
        start: Number.isFinite(start) ? start : null,
      });
    }
    return games;
  }
  const isLive = g => g.state === 'in';
  const margin = g => (g.away.score !== null && g.home.score !== null ? Math.abs(g.away.score - g.home.score) : null);
  const scoreLine = g => (g.state === 'pre' ? `${g.away.abbrev} @ ${g.home.abbrev}` :
    `${g.away.abbrev} ${g.away.score ?? '-'} – ${g.home.abbrev} ${g.home.score ?? '-'}`);
  function dayNumber(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: 'numeric', day: 'numeric'}).formatToParts(new Date(ms));
    const part = type => Number(parts.find(p => p.type === type).value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000;
  }
  /** "1:00 PM" today, "Sun 1:00 PM" this week, "Nov 8" further out, in this computer's time zone unless [timeZone] says otherwise. */
  function startText(start, now, locale, timeZone) {
    const at = new Date(start);
    const days = dayNumber(start, timeZone) - dayNumber(now, timeZone);
    const clock = at.toLocaleTimeString(locale, {timeZone, hour: 'numeric', minute: '2-digit'});
    if (days === 0) return clock;
    if (days >= 1 && days <= 6) return at.toLocaleDateString(locale, {timeZone, weekday: 'short'}) + ' ' + clock;
    return at.toLocaleDateString(locale, {timeZone, month: 'short', day: 'numeric'});
  }
  /** The score ticker's second line: "NFL · Sun 1:00 PM" before the game, ESPN's short status once it starts. */
  function tickerDetail(g, now, locale, timeZone) {
    const status = g.state === 'pre' && g.start !== null ? startText(g.start, now, locale, timeZone) : g.detail;
    return `${(LEAGUE[g.league] || {tag: g.league}).tag} · ${status}`;
  }

  /*
   * Which lineup games deserve a heads-up: one is in the red zone, or a close finish (last two minutes
   * of football within one score, last two minutes of basketball within six). Each moment is announced
   * once, and never for the game already on screen.
   */
  class GameAlerts {
    constructor() { this.announced = new Map(); }
    /** [lineup] pairs lineup game ids with their titles. Returns new alerts. */
    check(lineup, onScreen, games, now) {
      for (const [key, at] of this.announced) if (now - at > 6 * 3600000) this.announced.delete(key);
      const alerts = [];
      for (const [id, title] of lineup) {
        if (id === onScreen || !title) continue;
        const game = GameAlerts.match(title, games);
        if (!game || !isLive(game)) continue;
        let key, text;
        if (game.redZone && (LEAGUE[game.league] || {}).football) {
          key = `${game.id}:rz:${game.possession}:${game.period}`;
          text = `${game.possession || 'Offense'} in the red zone · ${scoreLine(game)} · ${game.detail}` + (game.downDistance ? ` · ${game.downDistance}` : '');
        } else if (GameAlerts.closeFinish(game)) {
          key = `${game.id}:close`;
          text = `Close finish · ${scoreLine(game)} · ${game.detail}`;
        } else continue;
        if (this.announced.has(key)) continue;
        this.announced.set(key, now);
        alerts.push({gameId: id, text});
      }
      return alerts;
    }
    static closeFinish(game) {
      const m = margin(game);
      if (m === null) return false;
      const league = LEAGUE[game.league] || {};
      if (league.football) return game.period >= 4 && game.clockSeconds <= 120 && m <= 8;
      if (league.sport === 'basketball') return game.period >= 4 && game.clockSeconds <= 120 && m <= 6;
      return false;
    }
    /** Streaming sites say "Dallas Cowboys at Philadelphia Eagles", ESPN too; tolerate small differences. */
    static match(title, games) {
      const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const t = normalize(title);
      const exact = games.find(g => normalize(g.name) === t);
      if (exact) return exact;
      const mentions = side => [side.name, side.shortName, side.location].map(normalize).some(n => n && t.includes(n));
      return games.find(g => mentions(g.home) && mentions(g.away)) || null;
    }
  }

  // ---- ESPN Fantasy Football ------------------------------------------------------------------------

  const SLOTS = {0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX'};
  const POSITIONS = {1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST'};
  const BENCH_SLOTS = new Set([20, 21]);
  /** What a stat change means in an alert, most exciting first. */
  const STAT_LABELS = [[4, 'passing TD'], [25, 'rushing TD'], [43, 'receiving TD'], [101, 'kick return TD'], [102, 'punt return TD'],
    [103, 'pick-six'], [104, 'fumble return TD'], [74, '50+ yd field goal'], [77, '40-49 yd field goal'], [80, 'field goal'],
    [86, 'extra point'], [19, '2-pt conversion'], [26, '2-pt conversion'], [44, '2-pt conversion'], [95, 'interception'],
    [99, 'sack'], [53, 'reception'], [3, 'passing yards'], [24, 'rushing yards'], [42, 'receiving yards'],
    [20, 'interception thrown'], [72, 'fumble lost']];
  /*
   * Public leagues need no sign-in; private ones need the browser to be signed in to ESPN. Field names
   * follow what the site returns today and are read defensively, since ESPN changes them from time to time.
   */
  const EspnFantasy = {
    leagueUrl: (season, leagueId, week) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encode(leagueId)}` +
      '?view=mMatchupScore&view=mRoster&view=mTeam&view=mSettings' + (week ? `&scoringPeriodId=${week}` : ''),
    fanUrl: swid => `https://fan.api.espn.com/apis/v2/fans/${encode(swid)}?displayEvents=true&displayNow=true` +
      '&displayRecs=true&recLimit=5&context=fantasy&source=espncom-fantasy&lang=en&section=espn&region=us',
    /** The football leagues on a signed-in ESPN account. */
    parseLeagues(json, season) {
      const out = [];
      for (const pref of JSON.parse(json).preferences || []) {
        const entry = pref.metaData && pref.metaData.entry;
        if (!entry) continue;
        const football = str(entry.abbrev).toUpperCase() === 'FFL' || int(entry.gameId) === 1 || str(entry.entryURL).includes('football');
        if (!football) continue;
        if ('seasonId' in entry && int(entry.seasonId) !== season) continue;
        const group = (entry.groups || [])[0];
        if (!group) continue;
        out.push({leagueId: str(group.groupId), teamId: int(entry.entryId),
          leagueName: str(group.groupName) || `League ${str(group.groupId)}`, teamName: str(entry.entryName) || `Team ${int(entry.entryId)}`});
      }
      return out.filter((t, i) => out.findIndex(o => o.leagueId === t.leagueId && o.teamId === t.teamId) === i);
    },
    team(o) {
      const name = str(o.name) || `${str(o.location)} ${str(o.nickname)}`.trim();
      return {id: int(o.id), name: name || `Team ${int(o.id)}`, abbrev: str(o.abbrev)};
    },
    parseTeams(json) { return (JSON.parse(json).teams || []).map(EspnFantasy.team); },
    leagueName(json) { const s = JSON.parse(json).settings; return (s && str(s.name)) || 'ESPN league'; },
    /** The viewer's matchup for the league's current week. */
    parseSnapshot(json, teamId) {
      const root = JSON.parse(json);
      const week = int(root.scoringPeriodId) > 0 ? int(root.scoringPeriodId) : root.status ? int(root.status.latestScoringPeriod) : 0;
      if (!week) return null;
      const matchupPeriod = root.status && int(root.status.currentMatchupPeriod) > 0 ? int(root.status.currentMatchupPeriod) : week;
      const teams = root.teams || [];
      const mine = teams.find(t => int(t.id) === teamId);
      if (!mine) return null;
      const roster = [];
      for (const entry of (mine.roster && mine.roster.entries) || []) {
        const pool = entry.playerPoolEntry, player = pool && pool.player;
        if (!player) continue;
        let points = null, projected = null;
        const byStat = {};
        for (const s of player.stats || []) {
          if (int(s.scoringPeriodId) !== week) continue;
          if (int(s.statSourceId) === 0) {
            points = num(s.appliedTotal, 0);
            for (const [key, value] of Object.entries(s.appliedStats || {})) if (Number.isFinite(Number(key))) byStat[Number(key)] = num(value, 0);
          } else if (int(s.statSourceId) === 1) projected = num(s.appliedTotal, 0);
        }
        const slot = entry.lineupSlotId === undefined ? 20 : int(entry.lineupSlotId);
        roster.push({id: player.id !== undefined ? int(player.id) : int(entry.playerId), name: str(player.fullName),
          position: POSITIONS[int(player.defaultPositionId)] || '', slot: SLOTS[slot] || '', starter: !BENCH_SLOTS.has(slot),
          points: points ?? num(pool.appliedStatTotal, 0), projected, pointsByStat: byStat});
      }
      let myScore = null, opponentScore = null, opponentId = null;
      const total = side => { if (!side) return null; for (const k of ['totalPointsLive', 'totalPoints']) { const v = num(side[k], NaN); if (!Number.isNaN(v)) return v; } return null; };
      for (const m of root.schedule || []) {
        if (int(m.matchupPeriodId) !== matchupPeriod) continue;
        const home = m.home, away = m.away;
        let me, them;
        if (home && int(home.teamId) === teamId) { me = home; them = away; }
        else if (away && int(away.teamId) === teamId) { me = away; them = home; }
        else continue;
        myScore = total(me);
        opponentScore = them ? total(them) : null;
        opponentId = them ? int(them.teamId) : null;
      }
      const opponentJson = opponentId !== null ? teams.find(t => int(t.id) === opponentId) : null;
      return {week, leagueName: (root.settings && str(root.settings.name)) || '', mine: EspnFantasy.team(mine),
        opponent: opponentJson ? EspnFantasy.team(opponentJson) : null,
        myScore: myScore ?? roster.filter(p => p.starter).reduce((n, p) => n + p.points, 0), opponentScore, roster};
    },
  };
  /** Notices starters scoring between two snapshots: "+6.0 Bijan Robinson · rushing TD". */
  class ScoringWatcher {
    constructor() { this.week = -1; this.last = new Map(); }
    update(snapshot) {
      const baseline = snapshot.week !== this.week;
      this.week = snapshot.week;
      const scores = [];
      for (const p of snapshot.roster) {
        const before = this.last.get(p.id);
        this.last.set(p.id, p);
        if (baseline || !before || !p.starter) continue;
        const gained = p.points - before.points;
        // Ignore fractional yardage ticks; a catch or 10 yards is worth an alert.
        if (gained < 0.95) continue;
        const stat = STAT_LABELS.find(([id]) => (p.pointsByStat[id] || 0) - (before.pointsByStat[id] || 0) >= 0.95);
        scores.push({player: p.name, gained, reason: stat ? stat[1] : null, playerTotal: p.points, teamTotal: snapshot.myScore});
      }
      return scores.sort((a, b) => b.gained - a.gained);
    }
  }
  /** NFL seasons are named for the year they start; January and February belong to the last one. */
  function fantasySeason(date = new Date()) { return date.getFullYear() - (date.getMonth() <= 1 ? 1 : 0); }

  // ---- Music ----------------------------------------------------------------------------------------

  /*
   * A free, open directory of tens of thousands of internet radio stations. Only https streams are
   * offered: Chrome won't play plain-http audio inside an extension.
   */
  const RadioBrowser = {
    PLAYABLE: new Set(['MP3', 'AAC', 'AAC+', 'OGG']),
    searchUrl: (genre, limit = 60) => `https://all.api.radio-browser.info/json/stations/search?tag=${encode(genre)}` +
      `&order=clickcount&reverse=true&limit=${limit}&hidebroken=true&is_https=true`,
    /** Tells the directory a station was played, as it asks clients to; also returns its current URL. */
    clickUrl: stationId => `https://all.api.radio-browser.info/json/url/${encode(stationId)}`,
    parse(json) {
      const out = [];
      for (const s of JSON.parse(json)) {
        const url = str(s.url_resolved) || str(s.url);
        const codec = str(s.codec).toUpperCase();
        if (!url.startsWith('https://') || !RadioBrowser.PLAYABLE.has(codec) || (s.lastcheckok !== undefined && int(s.lastcheckok) === 0)) continue;
        const station = {id: str(s.stationuuid), name: RadioBrowser.cleanName(str(s.name)), url, codec, bitrate: int(s.bitrate)};
        if (!out.some(o => o.name.toLowerCase() === station.name.toLowerCase())) out.push(station);
      }
      return out;
    },
    /** Directory names often carry sorting junk ("# ", "- 0 N - ") or a list of tags after "||"; keep a name that fits on one line. */
    cleanName(raw) {
      let name = raw.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/^\d\s+N\s*-\s*/, '');
      name = name.split('||')[0].trim();
      if (name.length <= 44) return name || 'Radio';
      const head = name.slice(0, 44);
      const cut = (head.includes(' ') ? head.slice(0, head.lastIndexOf(' ')) : head).replace(/[,\-| ]+$/, '');
      return (cut || head) + '…';
    },
    /** The station's current stream address from clickUrl()'s answer; stations move. */
    parseUrl(json) {
      try {
        const o = JSON.parse(json);
        if (o.ok === false) return null;
        return str(o.url).trim() || null;
      } catch { return null; }
    },
  };
  /** The player gain for a music volume in percent: each 10% step is 3 dB, so loudness follows the setting. */
  const musicGain = percent => Math.pow(10, (Math.min(100, Math.max(0, percent)) - 100) * 0.3 / 20);

  // ---- Spotify ------------------------------------------------------------------------------------

  /*
   * Spotify in a Chrome tab (open.spotify.com), signed in there with the viewer's own account, Free or
   * Premium: no developer app and no sign-in through SportsWitch. SportsWitch presses play when a break
   * starts and pause when the game is back.
   */
  const SpotifyWeb = {URL: 'https://open.spotify.com/', MATCH: ['https://open.spotify.com/*']};
  /*
   * Runs inside the Spotify tab, in the page's own world (chrome.scripting), so it may use only what the
   * page has. Reports what the player shows and, for 'play' or 'pause', acts. The player's own Media
   * Session actions, kept by spotify_media.js, set the state outright. Without them it is the play
   * button, which toggles, so it is pressed only when the music isn't already doing what was asked:
   * [audible] says whether Chrome hears the tab.
   */
  function spotifyPage(action, audible) {
    const actions = window[Symbol.for('sportswitch.mediaSession')] || {};
    const button = document.querySelector('[data-testid="control-button-playpause"]');
    const session = navigator.mediaSession;
    const metadata = session && session.metadata;
    const state = {
      signedIn: !document.querySelector('[data-testid="login-button"]'),
      ready: !!button && !button.disabled,
      session: typeof actions.play === 'function' && typeof actions.pause === 'function',
      playback: session ? session.playbackState : 'none',
      track: metadata ? [metadata.title, metadata.artist].filter(Boolean).join(' · ') : '',
      via: null,
    };
    if (action !== 'play' && action !== 'pause') return state;
    const playing = state.playback === 'playing' || (state.playback !== 'paused' && !!audible);
    if (state.session) {
      // Pausing is always safe; playing what already plays would claim music SportsWitch didn't start.
      if (action === 'pause' || !playing) {
        actions[action]({action});
        state.via = 'session';
      }
    } else if (state.ready && (action === 'play') !== playing) {
      button.click();
      state.via = 'button';
    }
    return state;
  }

  root.SportsWitchBreaks = {
    LEAGUES, LEAGUE, scoreboardUrl, standingsUrl, TRIVIA_TOPICS, TOPIC, DEFAULT_TOPICS, RADIO_GENRES,
    DEFAULT_BREAK_PREFS, breakPrefs, changeBreakPrefs, anyCard, anyMusic,
    OpenTrivia, StandingsTrivia, TriviaDeck, parseScoreboard, isLive, margin, scoreLine, startText, tickerDetail, GameAlerts,
    EspnFantasy, ScoringWatcher, fantasySeason, STAT_LABELS, RadioBrowser, musicGain, SpotifyWeb, spotifyPage, shuffle,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
