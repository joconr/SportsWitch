/*
 * SportsWitch 4.2.0 settings sheet: every page of the Android app's settings, written for someone
 * opening it for the first time. Each row says in plain words what it does, changes apply immediately,
 * Back goes up one level and puts focus back where you were, and Left/Right change values in place.
 * Shared by the popup, the detached controller and settings.html.
 */
(() => {
  'use strict';
  function invoke(type, extra = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({type, ...extra}, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || 'SportsWitch did not answer'));
        else resolve(response.data);
      });
    });
  }
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  };

  /* One page of rows. Keys keep focus on the same row across refreshes. */
  class PageBuilder {
    constructor(sheet, content) { this.sheet = sheet; this.content = content; }
    add(el) { this.content.append(el); return el; }
    section(text) { return this.add(make('h3', 'sw-section', text)); }
    note(text, tone = '') { return this.add(make('p', 'sw-note' + (tone ? ' ' + tone : ''), text)); }
    view(el) { return this.add(el); }
    row(key, title, detail, value, {onClick, onLeft, onRight, chevron, kind} = {}) {
      const row = make('button', 'sw-row' + (kind ? ' ' + kind : ''));
      row.type = 'button';
      row.dataset.key = key;
      const text = make('span', 'sw-row-text');
      text.append(make('span', 'sw-row-title', title));
      if (detail) text.append(make('span', 'sw-row-detail', detail));
      row.append(text);
      if (onLeft) {
        const stepper = make('span', 'sw-stepper');
        const minus = make('span', 'sw-step', '−'), plus = make('span', 'sw-step', '+');
        minus.setAttribute('aria-hidden', 'true'); plus.setAttribute('aria-hidden', 'true');
        minus.addEventListener('click', e => { e.stopPropagation(); this.sheet.run(onLeft); });
        plus.addEventListener('click', e => { e.stopPropagation(); this.sheet.run(onRight); });
        stepper.append(minus, make('span', 'sw-row-value', value), plus);
        row.append(stepper);
        row.setAttribute('aria-label', `${title}: ${value}. Left and right arrows change it.`);
      } else if (value !== undefined && value !== null && value !== '') {
        row.append(make('span', 'sw-row-value', value));
      }
      if (chevron) row.append(make('span', 'sw-chevron', '›'));
      row.addEventListener('click', () => onClick && this.sheet.run(onClick));
      row.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' && onLeft) { e.preventDefault(); this.sheet.run(onLeft); }
        else if (e.key === 'ArrowRight' && onRight) { e.preventDefault(); this.sheet.run(onRight); }
      });
      return this.add(row);
    }
    toggle(key, title, detail, value, onChange) {
      const change = () => onChange(!value);
      const row = this.row(key, title, detail, null, {onClick: change, onLeft: null, onRight: null, kind: 'sw-toggle'});
      const knob = make('span', 'sw-switch' + (value ? ' on' : ''));
      knob.setAttribute('aria-hidden', 'true');
      row.append(knob);
      row.setAttribute('role', 'switch');
      row.setAttribute('aria-checked', String(!!value));
      row.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.sheet.run(change); } });
      return row;
    }
    stepper(key, title, detail, value, onLeft, onRight) {
      return this.row(key, title, detail, value, {onClick: onRight, onLeft, onRight, kind: 'sw-stepper-row'});
    }
    link(key, title, detail, value, onClick) { return this.row(key, title, detail, value, {onClick, chevron: true}); }
    action(key, title, detail, value, onClick) { return this.row(key, title, detail, value, {onClick}); }
    choice(key, title, detail, selected, onClick) { return this.row(key, title, detail, selected ? '✓' : '', {onClick, kind: selected ? 'sw-selected' : ''}); }
  }

  /*
   * Pages stack (Settings › Customize your ad break › Topics); Back returns one level and focus lands on
   * the row you came from. options: {embedded, onClose, onPreview, onWelcomeDone}.
   */
  class Sheet {
    constructor(host, options = {}) {
      this.options = options;
      this.stack = [];
      this.data = null;
      this.root = make('div', 'sw-sheet-root' + (options.embedded ? ' embedded' : ''));
      this.root.hidden = true;
      this.scrim = make('div', 'sw-scrim');
      this.scrim.addEventListener('click', () => this.closeAll());
      this.panel = make('section', 'sw-sheet');
      this.panel.setAttribute('role', 'dialog');
      this.panel.setAttribute('aria-modal', options.embedded ? 'false' : 'true');
      const top = make('div', 'sw-top');
      this.backButton = make('button', 'sw-back', '←');
      this.backButton.type = 'button';
      this.backButton.setAttribute('aria-label', 'Back');
      this.backButton.addEventListener('click', () => this.back());
      const titles = make('div', 'sw-titles');
      this.crumbs = make('div', 'sw-crumbs');
      this.title = make('h2', 'sw-title');
      titles.append(this.crumbs, this.title);
      top.append(this.backButton, titles);
      this.content = make('div', 'sw-content');
      this.toastBox = make('div', 'sw-toast');
      this.toastBox.setAttribute('role', 'status');
      this.panel.append(top, this.content, this.toastBox);
      this.root.append(this.scrim, this.panel);
      host.append(this.root);
      this.root.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !this.dialogOpen) { e.preventDefault(); this.back(); }
      });
    }
    get isOpen() { return this.stack.length > 0; }
    /** The sheet can move with the controller into a Picture-in-Picture window. */
    get doc() { return this.root.ownerDocument; }
    async open(title, build) {
      if (!this.stack.length) {
        this.returnFocus = this.doc.activeElement;
        this.root.hidden = false;
        this.root.classList.remove('closing');
      } else {
        const top = this.stack[this.stack.length - 1];
        top.focusKey = this.focusedKey();
        top.scroll = this.content.scrollTop;
      }
      this.stack.push({title, build, focusKey: null, scroll: 0});
      await this.render(null, 'forward');
    }
    async back() {
      if (!this.stack.length) return false;
      this.stack.pop();
      if (!this.stack.length) { this.hide(); return true; }
      const top = this.stack[this.stack.length - 1];
      await this.render(top.focusKey, 'back', top.scroll);
      return true;
    }
    closeAll() {
      if (!this.stack.length) return;
      this.stack = [];
      this.hide();
    }
    hide() {
      const done = () => { this.root.hidden = true; this.root.classList.remove('closing'); this.content.replaceChildren(); };
      if (this.light) done(); else { this.root.classList.add('closing'); setTimeout(done, 200); }
      if (this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus();
      this.options.onClose?.();
    }
    /** Rebuilds the current page after a value changed, keeping focus on the same row. */
    async refresh() {
      if (this.stack.length) await this.render(this.focusedKey(), null, this.content.scrollTop);
    }
    focusedKey() {
      const el = this.doc.activeElement;
      return el && this.content.contains(el) ? el.closest('[data-key]')?.dataset.key || null : null;
    }
    async render(focusKey, direction, scroll = 0) {
      const page = this.stack[this.stack.length - 1];
      try {
        this.data = await invoke('GET_PAGE_DATA');
      } catch (e) {
        this.data = this.data || null;
        this.toast('SportsWitch did not answer: ' + e.message);
        if (!this.data) return;
      }
      this.light = !!this.data.lighterMotion;
      this.root.classList.toggle('sw-light', this.light);
      if (page !== this.stack[this.stack.length - 1]) return; // the viewer moved on meanwhile
      this.title.textContent = page.title;
      this.crumbs.textContent = this.stack.slice(0, -1).map(p => p.title).join(' › ');
      this.crumbs.hidden = this.stack.length < 2;
      this.backButton.setAttribute('aria-label', this.stack.length > 1 ? `Back to ${this.stack[this.stack.length - 2].title}` : 'Close');
      const content = make('div', 'sw-page');
      try {
        await page.build(new PageBuilder(this, content), this.data);
      } catch (e) {
        content.append(make('p', 'sw-note ad', 'Could not show this page: ' + e.message));
      }
      if (page !== this.stack[this.stack.length - 1]) return;
      this.content.replaceChildren(content);
      if (direction && !this.light) content.classList.add(direction === 'forward' ? 'sw-in-forward' : 'sw-in-back');
      this.content.scrollTop = scroll;
      const target = (focusKey && content.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)) || (direction ? content.querySelector('button') : null);
      if (target) target.focus({preventScroll: !!focusKey});
    }
    /** Runs a row's handler; a failure becomes a short note at the bottom instead of an exception. */
    async run(handler) {
      try {
        await handler();
      } catch (e) {
        this.toast(e.message || String(e));
      }
    }
    toast(text) {
      this.toastBox.textContent = text;
      this.toastBox.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toastBox.classList.remove('show'), 4200);
    }
    dialog(title, message, {ok = 'OK', cancel = 'Cancel', input = null} = {}) {
      return new Promise(resolve => {
        this.dialogOpen = true;
        const box = make('div', 'sw-dialog');
        const card = make('div', 'sw-dialog-card');
        card.setAttribute('role', 'alertdialog');
        card.append(make('h3', '', title));
        if (message) card.append(make('p', '', message));
        let field = null;
        if (input) {
          field = make('input', 'sw-input');
          field.type = 'text';
          field.value = input.value || '';
          field.placeholder = input.placeholder || '';
          field.spellcheck = false;
          card.append(field);
        }
        const buttons = make('div', 'sw-dialog-buttons');
        const cancelButton = make('button', 'sw-button', cancel);
        const okButton = make('button', 'sw-button primary', ok);
        cancelButton.type = okButton.type = 'button';
        buttons.append(cancelButton, okButton);
        card.append(buttons);
        box.append(card);
        this.panel.append(box);
        const finish = value => {
          this.dialogOpen = false;
          box.remove();
          resolve(value);
        };
        okButton.addEventListener('click', () => finish(input ? field.value : true));
        cancelButton.addEventListener('click', () => finish(input ? null : false));
        box.addEventListener('keydown', e => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(input ? null : false); }
          if (e.key === 'Enter' && field && field.ownerDocument.activeElement === field) { e.preventDefault(); finish(field.value); }
        });
        (field || okButton).focus();
      });
    }
  }

  // ---- The pages ------------------------------------------------------------------------------------

  const B = () => globalThis.SportsWitchBreaks;
  async function saveSettings(sheet, changes) {
    await invoke('SAVE_SETTINGS', {settings: changes});
    await sheet.refresh();
  }
  async function saveBreaks(sheet, changes) {
    await invoke('SAVE_BREAKS', {changes});
    await sheet.refresh();
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function breakSummary(d) {
    const p = d.breaks;
    const parts = [p.trivia && 'Trivia', p.scores && 'Scores', p.fantasyCard && d.accounts.fantasyTeam && 'Fantasy',
      p.radio && p.radioStation && 'Radio', p.spotify && 'Spotify'].filter(Boolean);
    return !p.screen && !p.radio && !p.spotify ? 'Off' : parts.join(' · ') || 'Off';
  }

  const Pages = {
    settings(sheet) {
      return sheet.open('Settings', (b, d) => {
        const s = d.settings;
        b.section('Ad breaks');
        b.link('breaks', 'Customize your ad break', 'Trivia, live scores, your fantasy matchup and music while ads are muted.',
          breakSummary(d), () => Pages.adBreaks(sheet));

        b.section('Detection');
        b.stepper('mute', 'Act on an ad at', 'How sure SportsWitch must be before it mutes or switches. Higher means fewer mistakes but slower reactions. Recommended: 90%.',
          `${s.muteCertainty}% sure`,
          () => saveSettings(sheet, {muteCertainty: Math.max(s.muteCertainty - 1, Math.max(60, s.releaseCertainty + 1))}),
          () => saveSettings(sheet, {muteCertainty: Math.min(s.muteCertainty + 1, 99)}));
        b.stepper('release', 'Back to the game below', 'How unsure it must become before sound returns. Recommended: 50%.', `${s.releaseCertainty}%`,
          () => saveSettings(sheet, {releaseCertainty: Math.max(s.releaseCertainty - 5, 10)}),
          () => saveSettings(sheet, {releaseCertainty: Math.min(s.releaseCertainty + 5, Math.min(90, s.muteCertainty - 1))}));
        b.toggle('learn', 'Learn on this computer', 'Remembers ads, notices ads that air again and learns from "That\'s an ad" / "That\'s the game". Nothing leaves this computer.',
          s.learnAds, v => saveSettings(sheet, {learnAds: v}));
        if (d.learnedSummary) b.note(d.learnedSummary);
        b.action('reset', 'Reset what SportsWitch learned', 'Forgets remembered ads, the recent audio history and your corrections.', null, async () => {
          if (!await sheet.dialog('Reset learning?', "SportsWitch will start learning your games' ads and sound again.", {ok: 'Reset'})) return;
          await invoke('RESET_LEARNING');
          sheet.toast('Learning reset.');
          await sheet.refresh();
        });

        b.section('Switch mode');
        b.note('Only used in Switch mode, which moves between the games in your lineup.');
        b.stepper('break', 'Typical ad break', "How long a game you left for ads is presumed to stay in its break while SportsWitch can't hear it clearly.",
          `${s.breakEstimateSeconds} s`,
          () => saveSettings(sheet, {breakEstimateSeconds: Math.max(s.breakEstimateSeconds - 15, 30)}),
          () => saveSettings(sheet, {breakEstimateSeconds: Math.min(s.breakEstimateSeconds + 15, 600)}));
        b.stepper('recheck', 'Recheck a game still on ads', 'Wait before trying a game again if it was still in its break.', `${s.recheckSeconds} s`,
          () => saveSettings(sheet, {recheckSeconds: Math.max(s.recheckSeconds - 15, 15)}),
          () => saveSettings(sheet, {recheckSeconds: Math.min(s.recheckSeconds + 15, 300)}));
        b.stepper('settle', 'Ignore audio after a switch', 'Seconds to let a newly watched game settle before SportsWitch acts on its sound.', `${s.settleSeconds} s`,
          () => saveSettings(sheet, {settleSeconds: Math.max(s.settleSeconds - 1, 3)}),
          () => saveSettings(sheet, {settleSeconds: Math.min(s.settleSeconds + 1, 20)}));
        b.toggle('priority', 'Return to higher-priority games', "Go back to a game higher in your lineup once it is clearly live again. Off: stay on the game SportsWitch switched to until that game's ad, or until you pick another. Also next to the Switch button.",
          s.returnToPriority, v => saveSettings(sheet, {returnToPriority: v}));
        b.toggle('automute', 'Mute when every game is on a break', null, s.autoMuteWhenNoGame, v => saveSettings(sheet, {autoMuteWhenNoGame: v}));
        b.toggle('follow', 'Jump to big moments', 'Switch to a lineup game in the red zone or a close finish. Otherwise SportsWitch just tells you.',
          s.followBigMoments, v => saveSettings(sheet, {followBigMoments: v}));
        b.toggle('whoosh', 'Whoosh sound on a switch', null, s.switchWhoosh, v => saveSettings(sheet, {switchWhoosh: v}));
        b.toggle('fullscreen', 'Fullscreen video after a switch', "Experimental: tries the site's own fullscreen button through a brief Chrome debugger connection (Chrome shows a notice while it does). Muting never changes fullscreen. Press Esc to leave.",
          s.autoFullscreenOnSwitch, v => saveSettings(sheet, {autoFullscreenOnSwitch: v}));

        b.section('Display & data');
        b.toggle('overlay', 'Status in the corner', 'A small pill over the game showing what SportsWitch hears.', s.showOverlay, v => saveSettings(sheet, {showOverlay: v}));
        b.toggle('lighter', 'Lighter animations', 'For slower computers: the ad-break screen and menus change without animating, so the game stays smooth. On by itself on computers with 2 GB of memory or less.',
          d.lighterMotion, async v => { await invoke('SET_FLAGS', {flags: {lighterMotion: v}}); await sheet.refresh(); });
        b.toggle('log', 'Save a detection log', 'Numbers only, no audio, kept in Chrome on this computer (up to 50 MB; the oldest sessions are deleted first). Includes what was on, so it\'s off unless you turn it on.',
          s.saveDetectionLog, v => saveSettings(sheet, {saveDetectionLog: v}));
        if (d.logs.length) b.link('logs', 'Detection logs', 'Download saved sessions as CSV files, for retraining.', `${d.logs.length} saved`, () => Pages.logs(sheet));

        b.section('More');
        b.link('setup', 'Setup & help', 'Pinning, shortcuts and troubleshooting.', null, () => Pages.setup(sheet));
        b.link('updates', 'Updates', d.updates.kind === 'store' ? 'New versions install themselves between games; your settings stay.'
          : d.updates.kind === 'folder' && d.updates.helper ? 'New versions come from GitHub and install themselves between games.'
          : 'This copy looks for new versions on GitHub every day.', d.updates.available ? `${d.updates.available} is out` : d.version, () => Pages.updates(sheet));
        b.link('privacy', 'Privacy', 'What SportsWitch reads and where it goes.', null, () => Pages.privacy(sheet));
        if (d.support.url) b.link('support', '♥  Support SportsWitch', 'Buy the developer a coffee on Ko-fi.', null, () => Pages.support(sheet));
        b.action('defaults', 'Restore recommended detection settings', null, null, async () => {
          await invoke('RESET_SETTINGS');
          sheet.toast('Recommended settings restored.');
          await sheet.refresh();
        });
        b.note(`SportsWitch ${d.version}`, 'dim');
      });
    },

    adBreaks(sheet) {
      return sheet.open('Customize your ad break', (b, d) => {
        const p = d.breaks, BD = B();
        b.note('While SportsWitch mutes an ad, it can show trivia, scores and your fantasy matchup, and play music. Pick any mix; they share one screen.');
        b.action('preview', 'Preview the ad-break screen', 'See it for 25 seconds with live content.', null, () => sheet.options.onPreview?.());
        b.toggle('screen', 'Ad-break screen', 'Shows the cards below over the muted ad. It disappears when the game is back; a click hides it sooner.',
          p.screen, v => saveBreaks(sheet, {screen: v}));

        b.section('Trivia');
        b.toggle('trivia', 'Trivia questions', "Family-friendly questions to talk about. The answer appears after 15 seconds. New questions arrive all the time, plus questions from this week's standings.",
          p.trivia, v => saveBreaks(sheet, {trivia: v}));
        const topics = BD.TRIVIA_TOPICS.filter(t => p.triviaTopics.includes(t.key));
        b.link('topics', 'Topics', null, topics.slice(0, 3).map(t => t.label).join(', ') + (topics.length > 3 ? ` +${topics.length - 3}` : ''), () => Pages.topics(sheet));

        b.section('Scores');
        b.toggle('scores', 'Scores around the league', 'Live scores along the bottom of the ad-break screen.', p.scores, v => saveBreaks(sheet, {scores: v}));
        b.link('leagues', 'Leagues', null, BD.LEAGUES.filter(l => p.leagues.includes(l.key)).map(l => l.label).join(', ') || 'None', () => Pages.leagues(sheet));
        b.toggle('redzone', 'Red-zone and close-finish alerts', 'When another game in your lineup reaches the red zone or a close final two minutes, SportsWitch tells you (and can switch, in Switch mode).',
          p.redZoneAlerts, v => saveBreaks(sheet, {redZoneAlerts: v}));

        b.section('Fantasy football · ESPN');
        const team = d.accounts.fantasyTeam;
        b.link('espn', 'ESPN account', "Uses your espn.com sign-in in Chrome; SportsWitch reads your team's live points.",
          team ? team.teamName : 'Sign in', () => Pages.espn(sheet));
        b.toggle('fantasyCard', 'My matchup on the ad-break screen', "Your score, your opponent's and your top players.", p.fantasyCard, v => saveBreaks(sheet, {fantasyCard: v}));
        b.toggle('fantasyAlerts', 'Scoring alerts in the corner', '"+6.0 Bijan Robinson · rushing TD", even during the game.', p.fantasyAlerts, v => saveBreaks(sheet, {fantasyAlerts: v}));

        b.section('Music during ad breaks');
        b.toggle('radio', 'Radio on this computer', 'Plays a station during ad breaks, fading in and out. The ad keeps playing quietly underneath unless you silence it below.',
          p.radio, async v => {
            if (v && !p.radioStation) return Pages.radioGenres(sheet);
            await saveBreaks(sheet, {radio: v});
            if (v && p.spotify) sheet.toast('Spotify is off while the radio plays.');
          });
        b.link('station', 'Station', 'Thousands of free stations from Radio Browser.', p.radioStation ? p.radioStation.name : 'Choose', () => Pages.radioGenres(sheet));
        b.toggle('silenceAd', 'Silence the ad under the music', 'The ad stays muted while the radio plays, instead of turned down to about 20%. SportsWitch still hears it, so the game comes back as usual.',
          p.silenceAd, v => saveBreaks(sheet, {silenceAd: v}));
        b.link('spotify', 'Spotify', 'Your own Spotify, Free or Premium, playing in a Chrome tab during breaks. Instead of the radio.',
          !p.spotify ? 'Off' : {none: 'Open Spotify', signedOut: 'Sign in', asleep: 'Asleep'}[d.spotify.state] || 'On', () => Pages.spotify(sheet));
        b.stepper('volume', 'Music volume', 'For the radio. Each step is 3 dB, so every step is clearly louder or quieter. Applies straight away, even mid-break. Spotify plays at its own volume.', `${p.musicVolume}%`,
          () => saveBreaks(sheet, {musicVolume: clamp(p.musicVolume - 10, 10, 100)}),
          () => saveBreaks(sheet, {musicVolume: clamp(p.musicVolume + 10, 10, 100)}));
      });
    },

    topics(sheet) {
      return sheet.open('Trivia topics', (b, d) => {
        b.note('Questions come from Open Trivia DB (opentdb.com, CC BY-SA 4.0); topics with grown-up subjects are filtered out.');
        for (const topic of B().TRIVIA_TOPICS) {
          const on = d.breaks.triviaTopics.includes(topic.key);
          b.toggle('topic_' + topic.key, topic.label, null, on, v => {
            const next = v ? [...d.breaks.triviaTopics, topic.key] : d.breaks.triviaTopics.filter(k => k !== topic.key);
            return saveBreaks(sheet, {triviaTopics: next.length ? next : [topic.key]});
          });
        }
      });
    },

    leagues(sheet) {
      return sheet.open('Score leagues', (b, d) => {
        b.note('Scores come from ESPN. Live games are shown first.');
        for (const league of B().LEAGUES) {
          b.toggle('league_' + league.key, league.label, null, d.breaks.leagues.includes(league.key), v =>
            saveBreaks(sheet, {leagues: v ? [...d.breaks.leagues, league.key] : d.breaks.leagues.filter(k => k !== league.key)}));
        }
      });
    },

    espn(sheet) {
      return sheet.open('ESPN Fantasy', (b, d) => {
        const team = d.accounts.fantasyTeam;
        if (team) {
          b.note(`Following ${team.teamName} in ${team.leagueName}.`);
          b.action('change', 'Choose another team or league', null, null, () => Pages.espnLeagues(sheet));
          b.action('forget', 'Forget my ESPN team', 'SportsWitch stops reading your league. You stay signed in to espn.com.', null, async () => {
            await invoke('ESPN_FORGET');
            sheet.toast('SportsWitch no longer reads your ESPN league.');
            await sheet.back();
          });
          return;
        }
        b.note('SportsWitch reads your fantasy team with the espn.com sign-in already in this browser. Your password stays with ESPN.');
        b.action('signin', 'Open ESPN sign-in', 'Sign in there with the account that has your team, then come back and choose Find my team.',
          d.accounts.espnSignedIn ? 'Signed in' : 'Open', async () => { await invoke('ESPN_OPEN_SIGN_IN'); });
        b.action('find', 'Find my team', null, null, () => Pages.espnLeagues(sheet));
        b.action('leagueId', 'Enter a league ID', 'For a league that isn\'t listed: the number after leagueId= in its web address on fantasy.espn.com.', null, async () => {
          const id = await sheet.dialog('Your ESPN league ID', 'It\'s the number after leagueId= in your league\'s web address.', {ok: 'Find my team', input: {placeholder: 'e.g. 1234567'}});
          if (id && id.trim()) await Pages.espnTeams(sheet, id.trim());
        });
      });
    },
    espnLeagues(sheet) {
      return sheet.open('Your ESPN leagues', async b => {
        let leagues;
        try { leagues = await invoke('ESPN_LEAGUES'); }
        catch (e) {
          b.note(e.message, 'uncertain');
          b.action('signin', 'Open ESPN sign-in', null, null, async () => { await invoke('ESPN_OPEN_SIGN_IN'); });
          b.action('retry', 'Try again', null, null, () => sheet.refresh());
          return;
        }
        if (!leagues.length) b.note("ESPN didn't list a football league for this season on that account. Enter its league ID instead (ESPN Fantasy › Enter a league ID).", 'uncertain');
        for (const team of leagues) {
          b.choice(`team_${team.leagueId}_${team.teamId}`, team.teamName, team.leagueName, false, () => Pages.chooseTeam(sheet, team));
        }
      });
    },
    espnTeams(sheet, leagueId) {
      return sheet.open('Which team is yours?', async b => {
        let league;
        try { league = await invoke('ESPN_LEAGUE_TEAMS', {leagueId}); }
        catch (e) { b.note(`Couldn't open that league: ${e.message}`, 'ad'); return; }
        b.note(league.leagueName);
        for (const t of league.teams) {
          b.choice('team_' + t.id, t.name, null, false, () => Pages.chooseTeam(sheet, {leagueId, teamId: t.id, leagueName: league.leagueName, teamName: t.name}));
        }
      });
    },
    async chooseTeam(sheet, team) {
      await invoke('ESPN_CHOOSE_TEAM', {team});
      sheet.toast(`Following ${team.teamName} in ${team.leagueName}.`);
      while (sheet.stack.length && sheet.stack[sheet.stack.length - 1].title !== 'Customize your ad break' && sheet.stack.length > 1) {
        sheet.stack.pop();
      }
      await sheet.refresh();
    },

    radioGenres(sheet) {
      return sheet.open('Radio · pick a style', (b, d) => {
        for (const genre of B().RADIO_GENRES) {
          b.choice('genre_' + genre, genre[0].toUpperCase() + genre.slice(1), null, genre === d.breaks.radioGenre, async () => {
            await invoke('SAVE_BREAKS', {changes: {radioGenre: genre}});
            await Pages.radioStations(sheet, genre);
          });
        }
      });
    },
    radioStations(sheet, genre) {
      return sheet.open(`${genre[0].toUpperCase() + genre.slice(1)} stations`, async (b, d) => {
        let stations;
        try { stations = await invoke('RADIO_STATIONS', {genre}); }
        catch { stations = []; }
        if (!stations.length) b.note("Couldn't load stations. Check the internet connection and try again.", 'ad');
        for (const station of stations) {
          b.choice('station_' + station.id, station.name, [station.codec, station.bitrate ? `${station.bitrate} kbps` : null].filter(Boolean).join(' · '),
            d.breaks.radioStation && d.breaks.radioStation.id === station.id, async () => {
              await invoke('SAVE_BREAKS', {changes: {radio: true, radioStation: station}});
              sheet.toast(`${station.name} plays during ad breaks.`);
              await sheet.refresh();
            });
        }
      });
    },

    spotify(sheet) {
      return sheet.open('Spotify during ad breaks', (b, d) => {
        const p = d.breaks, tab = d.spotify;
        b.note("SportsWitch presses play on your Spotify when an ad break starts and pause when the game is back. It uses Spotify in a Chrome tab, signed in with your own account, Free or Premium. There's nothing else to set up or sign in to.");
        b.section('Your Spotify tab');
        const rows = {
          none: ['Open Spotify', 'Opens open.spotify.com in a pinned tab. Sign in there if Spotify asks.'],
          asleep: ['Wake the Spotify tab', 'Chrome put it to sleep to save memory. Showing it wakes it.'],
          signedOut: ['Sign in to Spotify', 'Shows the Spotify tab. Log in there with your Spotify account.'],
          loading: ['Spotify is loading', 'Shows the Spotify tab.'],
          ready: ['Spotify is ready', tab.track ? `Loaded: ${tab.track}` : 'Shows the Spotify tab.'],
        };
        const [title, detail] = rows[tab.state] || rows.none;
        b.action('tab', title, detail, tab.state === 'ready' ? '✓' : null, () => invoke('SPOTIFY_SHOW'));
        b.note('In that tab, choose a playlist or album, press play once, then pause it. Chrome only lets SportsWitch start music in a tab where you have played some. Keep the tab open; it can stay in the background.', 'text');
        b.section('During ad breaks');
        b.toggle('spotifyOn', 'Play Spotify during ad breaks', 'Plays instead of the radio. Spotify keeps its own volume.', p.spotify, async v => {
          await saveBreaks(sheet, {spotify: v});
          if (v && p.radio) sheet.toast('The radio is off while Spotify plays.');
        });
        b.action('try', 'Try it', 'Plays Spotify for 5 seconds, then pauses it.', null, async () => {
          sheet.toast('Playing Spotify for 5 seconds…');
          const result = await invoke('SPOTIFY_TRY');
          sheet.toast(result.message);
          await sheet.refresh();
        });
      });
    },

    logs(sheet) {
      return sheet.open('Detection logs', (b, d) => {
        b.note('One CSV file per session: a row per second with the 46 features and what SportsWitch decided, plus your corrections. No audio. tools/retrain_from_logs.py in the SportsWitch project turns them into training data.');
        for (const log of d.logs) {
          b.action('log_' + log.id, log.name, new Date(log.startedAt).toLocaleString(), `${Math.max(1, Math.round(log.bytes / 1024))} KB`, async () => {
            download(log.name, await invoke('LOGS_CSV', {id: log.id}));
          });
        }
        if (d.logs.length > 1) b.action('all', 'Download all', null, null, async () => {
          for (const log of d.logs) download(log.name, await invoke('LOGS_CSV', {id: log.id}));
        });
        b.action('clear', 'Delete all logs', null, null, async () => {
          if (!await sheet.dialog('Delete all detection logs?', 'The saved sessions are removed from this computer.', {ok: 'Delete'})) return;
          await invoke('LOGS_CLEAR');
          await sheet.back();
        });
      });
    },

    setup(sheet) {
      return sheet.open('Setup & help', (b, d) => {
        checklist(b, d);
        b.section('Faster corrections');
        b.note('"That\'s an ad" and "That\'s the game" fix a mistake immediately and teach SportsWitch. They are in the popup and the controller, and on the keyboard:');
        b.note(d.shortcuts.map(c => `${c.description}: ${c.shortcut || 'not set'}`).join('\n'), 'text');
        b.action('shortcuts', 'Change the keyboard shortcuts', 'Opens Chrome\'s shortcut settings for extensions.', null, async () => {
          await chrome.tabs.create({url: 'chrome://extensions/shortcuts'});
        });
        b.section('Troubleshooting');
        b.note('• "No sound from" a game: make sure it is playing and not muted on the site. Some protected players block capture.\n' +
          '• Studio shows (e.g. SportsCenter) can sound like ads: press "That\'s the game" and SportsWitch learns.\n' +
          '• Streams stutter or look blurry: try fewer streams and turn on Chrome\'s graphics acceleration (chrome://settings/system).\n' +
          '• The status pill or ad-break screen is missing on a site: some pages don\'t allow extensions to draw on them; the popup and controller still show everything.');
        b.action('help', 'Open the full help page', null, null, async () => { await invoke('OPEN_PAGE', {page: 'help.html'}); });
        b.action('welcome', 'Show the welcome guide again', null, null, async () => { sheet.closeAll(); await Pages.welcome(sheet); });
        if (d.support.url) b.link('support', '♥  Support SportsWitch', 'Buy the developer a coffee on Ko-fi.', null, () => Pages.support(sheet));
      });
    },

    updates(sheet) {
      return sheet.open('Updates', async (b, d) => {
        const u = d.updates, selfUpdating = u.kind === 'folder' && u.helper;
        if (u.updatedFrom) await invoke('UPDATE_SEEN'); // the popup's "what's new" note has done its job
        const keeps = 'Your settings, ad-break choices and everything it learned stay as they are, unless an update says it changes one.';
        b.note(u.kind === 'store' ? `SportsWitch updates itself from the Chrome Web Store. It checks every day and installs a new version between games, never during one. ${keeps}`
          : u.kind === 'workshop' ? 'This is the workshop copy, the folder new versions are made in, so it never updates itself. tools\\publish_release.ps1 puts a new version on GitHub, and the other copies get it from there.'
          : selfUpdating ? `This copy updates itself from SportsWitch's GitHub page. It checks every day and installs a new version between games, never during one. ${keeps}`
          : "This copy was loaded from a folder. It checks SportsWitch's GitHub page every day and tells you when a new version is out. Set up automatic updates once on this computer and it installs them by itself.", 'text');
        b.action('version', 'Version', u.updatedFrom ? `Updated from ${u.updatedFrom}.` : null, d.version, () => {});
        if (u.available && selfUpdating) {
          b.action('install', `SportsWitch ${u.available} is out`, d.monitoring ? 'Installs when this game ends.' : 'SportsWitch restarts with it in a few seconds.', 'Install now', async () => {
            sheet.toast(`Installing SportsWitch ${u.available}…`);
            const result = await invoke('INSTALL_UPDATE');
            if (result.installing) return sheet.toast(`SportsWitch ${result.installing} is installed. Restarting…`);
            sheet.toast(result.pending ? 'It installs when this game ends.' : result.error || 'There is nothing to install.');
            await sheet.refresh();
          });
        } else if (u.available) {
          b.action('get', `SportsWitch ${u.available} is out`, 'Opens its download page on GitHub.', 'Get it', () => invoke('OPEN_UPDATE_PAGE', {what: 'release'}));
        }
        if (u.pending) b.note(u.kind === 'store' ? `SportsWitch ${u.pending} is downloaded. It installs as soon as no game is playing.`
          : `SportsWitch ${u.pending} installs as soon as no game is playing.`, 'uncertain');
        if (u.error) b.note(u.error, 'uncertain');
        if (selfUpdating) b.toggle('auto', 'Install updates by themselves', 'Off: SportsWitch only says when a new version is out.', u.auto, async v => {
          await invoke('SET_AUTO_UPDATE', {on: v});
          await sheet.refresh();
        });
        if (u.kind === 'folder' && !u.helper) b.link('setup', 'Set up automatic updates', 'Once on this computer, about a minute.', null, () => Pages.updateSetup(sheet));
        b.action('check', 'Check now', u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleString()}.` : 'Not checked yet.', null, async () => {
          const result = await invoke('CHECK_UPDATES');
          sheet.toast(result.result);
          await sheet.refresh();
        });
        b.link('changes', "What's new", 'Every version and what it changed.', null, () => invoke('OPEN_UPDATE_PAGE', {what: 'changes'}));
      });
    },

    updateSetup(sheet) {
      return sheet.open('Set up automatic updates', b => {
        b.note('Once on each computer:', 'text');
        b.note('1. Open the folder SportsWitch is loaded from: the button below opens SportsWitch at chrome://extensions, where you click the folder shown after "Loaded from".\n' +
          '2. In that folder, double-click "Set up automatic updates". If Windows asks whether to run it, choose Run (or More info › Run anyway).\n' +
          '3. Come back here and press Check now.', 'text');
        b.note("It adds SportsWitch Updater, a small helper that installs only SportsWitch versions signed by its developer, downloaded from SportsWitch's GitHub page. It needs no administrator rights; README.txt in the folder says how to remove it. Keep the folder where it is: Chrome knows SportsWitch, and its settings, by the folder's place.");
        b.action('extensions', 'Open SportsWitch at chrome://extensions', null, null, async () => { await chrome.tabs.create({url: `chrome://extensions/?id=${chrome.runtime.id}`}); });
      });
    },

    /* The plain-words version of PRIVACY.md, so it's in front of the viewer, not only on the web. */
    privacy(sheet) {
      return sheet.open('Privacy', b => {
        b.note('What SportsWitch reads, and where it goes:', 'text');
        b.note('• The sound of the game tabs you add, analysed on this computer to tell ads from the game. It is never recorded or sent anywhere.\n' +
          '• What it learns (ads it remembers, your corrections) stays in Chrome on this computer. "Reset what SportsWitch learned" deletes it.\n' +
          '• Your games\' tab titles and preview pictures, shown only inside SportsWitch.\n' +
          '• Ad-break extras, if you turn them on: trivia from Open Trivia DB, scores from ESPN, radio from Radio Browser. Fantasy football reads your league with your own espn.com sign-in in Chrome. Spotify plays in your own Spotify tab; SportsWitch only presses play and pause.\n' +
          '• The detection log, off unless you turn it on, keeps numbers (no audio) on this computer.\n' +
          '• Updates: Chrome updates the Chrome Web Store copy. A copy loaded from a folder asks SportsWitch\'s GitHub page once a day for the newest version; with automatic updates set up, SportsWitch Updater downloads it from there.\n' +
          '• Nothing about you is sent to the developer, sold or shared. No ads, no analytics.');
        b.action('policy', 'Read the full privacy policy', 'Opens it on GitHub.', null, () => invoke('OPEN_UPDATE_PAGE', {what: 'privacy'}));
      });
    },

    support(sheet) {
      return sheet.open('Support SportsWitch', async (b, d) => {
        await invoke('SET_FLAGS', {flags: {supportSeen: true}});
        b.note('SportsWitch is free. If it has made game day better, you can buy the developer a coffee on Ko-fi.', 'text');
        b.action('kofi', 'Open Ko-fi', d.support.url.replace(/^https?:\/\//, ''), null, async () => { await chrome.tabs.create({url: d.support.url}); });
        b.toggle('donated', "I've donated", "Then SportsWitch won't bring it up again.", d.support.donated, async v => {
          await invoke('SET_FLAGS', {flags: {supportDonated: v}});
          if (v) sheet.toast('Thank you for supporting SportsWitch!');
          await sheet.refresh();
        });
      });
    },

    welcome(sheet) {
      return sheet.open('Welcome to SportsWitch', (b, d) => {
        b.note('SportsWitch listens to the sports streams you add in Chrome (YouTube TV, ESPN, Peacock, Prime Video and many more) and recognises ads within a few seconds.', 'text');
        b.link('w_privacy', 'Your privacy', 'The games\' sound is analysed on this computer, never recorded or sent anywhere. Nothing about you goes to the developer.',
          null, () => Pages.privacy(sheet));
        b.section('Two ways to use it');
        b.note('• Switch mode: follow two to eight games and jump to another one when yours goes to ads.\n• Silence mode: one game; its ads are muted and the sound comes back by itself.');
        b.section('Step 1 · Your games');
        b.note('Open a game, click SportsWitch in the toolbar and choose Add This Tab. Do the same in each game\'s tab: Chrome asks for every tab.');
        checklist(b, d);
        b.section('Step 2 · Your ad breaks');
        b.toggle('w_trivia', 'Trivia questions', null, d.breaks.trivia, v => saveBreaks(sheet, {trivia: v}));
        b.toggle('w_scores', 'Scores around the league', null, d.breaks.scores, v => saveBreaks(sheet, {scores: v}));
        b.link('w_more', 'More: fantasy football, music, leagues…', null, null, () => Pages.adBreaks(sheet));
        b.section('Step 3 · Go');
        b.note('Use "That\'s an ad" or "That\'s the game" whenever SportsWitch gets it wrong; it learns from them.');
        b.action('w_done', 'Done', 'You can find this again in Setup & help.', null, async () => {
          await invoke('SET_FLAGS', {flags: {onboarded: true}});
          sheet.closeAll();
        });
      });
    },
  };

  /** What's set up, each with how to fix it. Used by Setup & help and the welcome guide. */
  function checklist(b, d) {
    b.action('pin', (d.pinned ? '✓  ' : '!  ') + 'Pin SportsWitch', d.pinned ? 'It\'s on the toolbar.' : 'Click the puzzle-piece Extensions button, then the pin next to SportsWitch.',
      d.pinned ? 'Done' : 'How', () => {});
    b.action('games', (d.gameCount ? '✓  ' : '!  ') + 'Add your games', d.gameCount
      ? `${d.gameCount} in the lineup. ${d.mode === 'switch' && d.gameCount < 2 ? 'Switch mode starts at two.' : 'Add more from each game\'s tab.'}`
      : 'Open a game, click SportsWitch and Add This Tab. Switch mode starts at two.', d.gameCount ? `${d.gameCount} added` : 'How', () => {});
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], {type: 'text/csv'}));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /*
   * The ad-break preview, as the Android controller shows it: the real screen with live content for
   * 25 seconds. Back, Esc or a click outside closes it.
   */
  function showBreakPreview(host) {
    const box = make('div', 'sw-preview');
    const card = make('div', 'sw-preview-card');
    const top = make('div', 'sw-preview-top');
    top.append(make('span', '', 'Previewing your ad-break screen'));
    const close = make('button', 'sw-button', 'Close');
    close.type = 'button';
    top.append(close);
    const stage = make('div', 'sw-preview-stage');
    card.append(top, stage);
    box.append(card);
    host.append(box);
    const screen = globalThis.SportsWitchOverlay.mountPreview(stage);
    let timer = null;
    const finish = () => { clearInterval(timer); screen.destroy(); box.remove(); };
    close.addEventListener('click', finish);
    box.addEventListener('click', e => { if (e.target === box) finish(); });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') finish(); });
    close.focus();
    const pull = async () => {
      try {
        const view = await invoke('GET_BREAK_VIEW');
        if (!view.showing) return finish();
        screen.update(view.model, view.light);
      } catch { finish(); }
    };
    invoke('PREVIEW_BREAK').then(pull, finish);
    timer = setInterval(pull, 1000);
    return finish;
  }

  globalThis.SportsWitchSheet = {Sheet, Pages, showBreakPreview, invoke};
})();
