/* SportsWitch 4.2.0 on-page overlay, drawn on the watched game's tab as the Android app draws over the
 * streaming app:
 * - a small status pill in the corner ("Status in the corner");
 * - alerts under it (fantasy scoring, red zone, close finish), with Watch to switch;
 * - the ad-break screen over a muted ad: trivia and the fantasy matchup side by side (stacked when
 *   narrow), scores along the bottom, what's playing in the header. A click (or Esc) hides it until
 *   the break ends.
 * Everything lives in a closed shadow root in the browser's top layer, so it shows over fullscreen
 * players and the page's styles can't reach it. It reads nothing from the page.
 * Loaded in an extension page, it only provides the ad-break screen for the controller's preview.
 */
(() => {
  'use strict';
  if (globalThis.SportsWitchOverlay) return;
  const STYLE = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
.root{position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4eeff;z-index:2147483647;
  --live:#3ddc84;--ad:#ff5a6e;--uncertain:#ffc24b;--dim:#b3a3cc;--accent:#c9a7ff;--card:#241238;--raised:#32194f}
.pill{position:absolute;top:24px;right:28px;max-width:min(480px,calc(100vw - 56px));padding:8px 16px 9px 14px;border-radius:18px;
  background:rgba(21,10,38,.9);border:1px solid rgba(201,167,255,.4);box-shadow:0 6px 22px rgba(5,2,12,.45);transition:opacity .25s,transform .25s}
.pill.prompting{border:3px solid var(--uncertain);font-size:16px;pointer-events:auto}
.pill .head{display:flex;gap:8px;align-items:baseline;font-weight:650}
.pill .dot{font-size:12px}.pill .detail{margin-top:2px;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill button,.toast button{pointer-events:auto;margin-top:8px;border:0;border-radius:10px;padding:6px 14px;background:#c9a7ff;color:#1e0b36;font:700 13px system-ui;cursor:pointer}
.toasts{position:absolute;top:96px;right:28px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:min(460px,calc(100vw - 56px))}
.toast{padding:9px 14px 10px;border-radius:14px;background:rgba(20,10,38,.95);border:1px solid var(--accent);box-shadow:0 6px 22px rgba(5,2,12,.45);
  animation:in .3s cubic-bezier(.2,.8,.2,1) both}
.toast.leaving{animation:out .26s ease both}
@keyframes in{from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:none}}
@keyframes out{to{opacity:0;transform:translateX(60px)}}
.screen{position:absolute;left:24px;right:24px;bottom:24px;margin:0 auto;max-width:1180px;padding:16px 22px;border-radius:22px;
  background:rgba(20,10,38,.95);border:1px solid rgba(201,167,255,.33);box-shadow:0 14px 44px rgba(5,2,12,.6);pointer-events:auto;cursor:pointer;
  animation:rise .32s cubic-bezier(.2,.8,.2,1) both}
.screen.embedded{position:relative;left:auto;right:auto;bottom:auto;cursor:default;animation:none}
@keyframes rise{from{opacity:0;transform:translateY(60px)}to{opacity:1;transform:none}}
.header{display:flex;align-items:center;gap:12px;min-width:0}
.badge{flex:none;padding:4px 10px;border-radius:10px;background:var(--ad);color:#1e0b36;font-weight:800;font-size:12px;letter-spacing:.12em}
.title{flex:1;min-width:0;font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.music{flex:none;max-width:34%;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hint{flex:none;color:var(--dim);font-size:12px}
.cards{display:flex;gap:14px;margin-top:12px}
.card{border-radius:16px;background:var(--card);padding:12px 16px 14px;min-width:0}
.trivia{flex:1.45}.fantasy{flex:1}
.label{color:var(--accent);font-weight:800;font-size:12px;letter-spacing:.1em}
.question{margin-top:6px;font-size:20px;font-weight:700;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.answers{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-top:8px}
.answer{padding:8px 12px;border-radius:10px;background:var(--raised);font-size:15px;transition:opacity .25s,background-color .25s,transform .18s;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.answer.right{background:var(--live);color:#1e0b36;font-weight:700;transform:scale(1.02)}
.answer.wrong{opacity:.4}
.detail{margin-top:6px;color:var(--dim);font-size:13px}
.bar{margin-top:10px;height:4px;border-radius:2px;background:var(--accent);width:100%}
.bar.revealed{background:var(--live)}
.source{margin-top:4px;color:var(--dim);font-size:11px}
.score{margin-top:4px;font-size:26px;font-weight:800}
.score.win{color:var(--live)}.score.lose{color:var(--ad)}
.vs{margin-top:2px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.players{margin-top:10px;white-space:pre-line}
.ticker{display:flex;gap:8px;margin-top:12px;transition:opacity .2s}
.chip{flex:1;min-width:0;padding:6px 12px 7px;border-radius:10px;background:var(--card)}
.chip.rz{background:#5a1a2a}.chip .line{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim)}
.chip.live .line{color:#f4eeff;font-weight:700}.chip .when{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip.live .when{color:var(--accent)}
.narrow .cards{flex-direction:column;gap:10px}.narrow .music{max-width:none}
.narrow .header{flex-wrap:wrap}.narrow .title{flex-basis:100%;order:3;white-space:normal}
.short .question{font-size:17px;-webkit-line-clamp:2}.short .answers{grid-template-columns:repeat(4,1fr)}
.short .answer{font-size:14px;-webkit-line-clamp:1}.short .source{display:none}.short .score{font-size:22px}
.light *,.light{animation:none!important;transition:none!important}
`;
  const TONES = {live: 'var(--live)', ad: 'var(--ad)', uncertain: 'var(--uncertain)', dim: 'var(--dim)'};
  const TICKER_MS = 6000, MIN_CHIP = 150, CHIP_GAP = 8, MAX_CHIPS = 6, WIDE = 640, SHORT_HEIGHT = 480;
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  /* The ad-break screen. hint: what dismisses it, or null in a preview. */
  class BreakScreen {
    constructor(hint, onHide) {
      this.el = make('div', 'screen');
      this.header = make('div', 'header');
      this.badge = make('span', 'badge', 'AD BREAK');
      this.title = make('span', 'title');
      this.music = make('span', 'music');
      this.hint = make('span', 'hint', hint || '');
      this.header.append(this.badge, this.title, this.music);
      if (hint) this.header.append(this.hint);
      this.cards = make('div', 'cards');
      this.triviaCard = make('div', 'card trivia');
      this.fantasyCard = make('div', 'card fantasy');
      this.cards.append(this.triviaCard, this.fantasyCard);
      this.ticker = make('div', 'ticker');
      this.el.append(this.header, this.cards, this.ticker);
      this.page = 0;
      this.scores = [];
      this.shownQuestion = null;
      this.shownRevealed = null;
      this.stepTimer = null;
      if (onHide) this.el.addEventListener('click', () => onHide());
      this.tickerTimer = setInterval(() => this.nextPage(), TICKER_MS);
      this.resize = new ResizeObserver(() => this.fit());
      this.resize.observe(this.el);
    }
    destroy() {
      clearInterval(this.tickerTimer);
      clearInterval(this.stepTimer);
      this.resize.disconnect();
      this.el.remove();
    }
    fit() {
      const width = this.el.clientWidth;
      this.el.classList.toggle('narrow', width > 0 && width < WIDE);
      this.el.classList.toggle('short', (this.el.ownerDocument.defaultView || window).innerHeight < SHORT_HEIGHT);
      const style = getComputedStyle(this.el);
      const inner = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const perPage = Math.max(1, Math.min(MAX_CHIPS, Math.floor((inner + CHIP_GAP) / (MIN_CHIP + CHIP_GAP))));
      if (perPage !== this.perPage) {
        this.perPage = perPage;
        this.page = 0;
        this.renderTicker();
      }
    }
    update(m, light) {
      this.light = light;
      this.el.classList.toggle('light', !!light);
      this.title.textContent = m.title;
      this.music.textContent = m.music || '';
      this.music.hidden = !m.music;
      this.triviaCard.hidden = !m.trivia;
      if (m.trivia) this.renderTrivia(m.trivia);
      this.fantasyCard.hidden = !m.fantasy;
      if (m.fantasy) this.renderFantasy(m.fantasy);
      this.cards.hidden = !m.trivia && !m.fantasy;
      const scores = m.scores || [];
      if (JSON.stringify(scores) !== JSON.stringify(this.scores)) {
        this.scores = scores;
        this.renderTicker();
      }
      this.ticker.hidden = !scores.length;
      if (!this.perPage) this.fit();
    }
    renderTrivia(t) {
      const key = t.loading ? null : t.question;
      if (key === this.shownQuestion && t.revealed === this.shownRevealed) return;
      const fresh = key !== this.shownQuestion;
      this.shownQuestion = key;
      this.shownRevealed = t.revealed;
      const card = this.triviaCard;
      card.replaceChildren();
      clearInterval(this.stepTimer);
      if (t.loading) {
        card.append(make('div', 'label', 'TRIVIA'), make('div', 'question', 'Finding a good question…'));
        return;
      }
      card.append(make('div', 'label', t.topic), make('div', 'question', t.question));
      const answers = make('div', 'answers');
      t.answers.forEach((answer, i) => {
        const el = make('div', 'answer' + (t.revealed ? (i === t.correct ? ' right' : ' wrong') : ''), `${'ABCD'[i]}   ${answer}`);
        if (fresh && !this.light) el.animate([{opacity: 0, transform: 'translateY(8px)'}, {opacity: 1, transform: 'none'}],
          {duration: 220, delay: 60 * i, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards'});
        answers.append(el);
      });
      card.append(answers);
      if (t.revealed && t.detail) card.append(make('div', 'detail', t.detail));
      // The bar empties until the answer (then the next question) shows. Normally it glides; with
      // "Lighter animations" it steps once a second so the page redraws far less.
      const bar = make('div', 'bar' + (t.revealed ? ' revealed' : ''));
      card.append(bar, make('div', 'source', `Question: ${t.source}`));
      const remaining = () => Math.max(0, t.endsAt - Date.now());
      bar.style.width = `${100 * remaining() / t.total}%`;
      if (this.light) {
        this.stepTimer = setInterval(() => {
          bar.style.width = `${100 * remaining() / t.total}%`;
          if (!remaining()) clearInterval(this.stepTimer);
        }, 1000);
      } else {
        bar.animate([{width: bar.style.width}, {width: '0%'}], {duration: remaining(), easing: 'linear', fill: 'forwards'});
      }
    }
    renderFantasy(f) {
      const card = this.fantasyCard;
      card.replaceChildren(make('div', 'label', f.label));
      if (f.score) card.append(make('div', 'score' + (f.winning === true ? ' win' : f.winning === false ? ' lose' : ''), f.score));
      if (f.vs) card.append(make('div', 'vs', f.vs));
      card.append(make('div', 'players', (f.lines || []).join('\n')));
    }
    nextPage() {
      if (this.scores.length <= (this.perPage || 1)) return;
      this.page++;
      if (this.light) return this.renderTicker();
      this.ticker.animate([{opacity: 1}, {opacity: 0}], {duration: 160}).onfinish = () => {
        this.renderTicker();
        this.ticker.animate([{opacity: 0}, {opacity: 1}], {duration: 200});
      };
    }
    renderTicker() {
      const per = this.perPage || 4;
      const pages = Math.max(1, Math.ceil(this.scores.length / per));
      const shown = this.scores.slice((this.page % pages) * per, (this.page % pages) * per + per);
      this.ticker.replaceChildren(...shown.map(g => {
        const chip = make('div', 'chip' + (g.live ? ' live' : '') + (g.redZone ? ' rz' : ''));
        chip.append(make('div', 'line', g.line), make('div', 'when', g.detail));
        return chip;
      }));
      for (let i = shown.length; i < per && shown.length; i++) this.ticker.append(make('div', 'chip-spacer'));
    }
  }

  function shadowHost(doc) {
    const host = doc.createElement('div');
    const root = host.attachShadow({mode: 'closed'});
    const style = doc.createElement('style');
    style.textContent = STYLE;
    root.append(style);
    return {host, root};
  }

  /** The controller's preview: the same screen inside an extension page. */
  function mountPreview(container) {
    const {host, root} = shadowHost(container.ownerDocument);
    const wrap = make('div');
    wrap.style.cssText = 'font:14px/1.4 system-ui,sans-serif;color:#f4eeff;--live:#3ddc84;--ad:#ff5a6e;--uncertain:#ffc24b;--dim:#b3a3cc;--accent:#c9a7ff;--card:#241238;--raised:#32194f';
    const screen = new BreakScreen(null, null);
    screen.el.classList.add('embedded');
    wrap.append(screen.el);
    root.append(wrap);
    container.replaceChildren(host);
    return {update: (model, light) => screen.update(model, light), destroy: () => { screen.destroy(); host.remove(); }};
  }
  globalThis.SportsWitchOverlay = {mountPreview};
  if (location.protocol === 'chrome-extension:') return;

  // ---- On the watched game's page -------------------------------------------------------------------

  const {host, root} = shadowHost(document);
  host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;' +
    'border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;color-scheme:normal';
  const layer = make('div', 'root');
  root.append(layer);
  let pill = null, toasts = null, screen = null, model = null, attached = false;
  const supportsPopover = typeof host.showPopover === 'function';
  if (supportsPopover) host.popover = 'manual';

  function attach() {
    if (!attached) {
      document.documentElement.append(host);
      attached = true;
    }
    if (supportsPopover) {
      // Re-entering the top layer puts the overlay above a player that went fullscreen after it.
      try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch {}
    } else {
      const parent = document.fullscreenElement || document.documentElement;
      if (host.parentNode !== parent) parent.append(host);
    }
  }
  function detach() {
    if (!attached) return;
    try { if (supportsPopover && host.matches(':popover-open')) host.hidePopover(); } catch {}
    host.remove();
    attached = false;
  }
  document.addEventListener('fullscreenchange', () => { if (attached) attach(); });

  function hideScreen() {
    if (!screen) return;
    screen.destroy();
    screen = null;
    try { chrome.runtime.sendMessage({type: 'HIDE_BREAK_SCREEN'}).catch(() => {}); } catch {}
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && screen) hideScreen(); }, true);

  function watch(id) {
    try { chrome.runtime.sendMessage({type: 'OVERLAY_WATCH', gameId: id}).catch(() => {}); } catch {}
  }
  function renderPill(p, prompt, light) {
    if (!p) { pill?.remove(); pill = null; return; }
    if (!pill) { pill = make('div', 'pill'); layer.append(pill); }
    pill.className = 'pill' + (p.prompting ? ' prompting' : '');
    const head = make('div', 'head');
    const dot = make('span', 'dot', p.prompting ? '⇄' : '●');
    dot.style.color = p.prompting ? TONES.uncertain : (TONES[p.tone] || TONES.dim);
    head.append(dot, make('span', '', p.headline));
    pill.replaceChildren(head);
    if (p.detail) pill.append(make('div', 'detail', p.detail));
    if (p.prompting && prompt) {
      const button = make('button', '', 'Watch');
      button.addEventListener('click', () => watch(prompt.id));
      pill.append(button);
    }
  }
  function toast(t, watching, light) {
    if (!toasts) { toasts = make('div', 'toasts'); layer.append(toasts); }
    const el = make('div', 'toast', t.text);
    if (t.watchId != null && t.watchId !== watching) {
      el.append(make('br'));
      const button = make('button', '', 'Watch');
      button.addEventListener('click', () => { watch(t.watchId); el.remove(); });
      el.append(button);
    }
    toasts.append(el);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    setTimeout(() => {
      if (light) return el.remove();
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }, 8000);
  }
  function render(m) {
    model = m;
    if (!m) {
      screen?.destroy(); screen = null;
      pill?.remove(); pill = null;
      toasts?.remove(); toasts = null;
      detach();
      return;
    }
    attach();
    layer.classList.toggle('light', !!m.light);
    renderPill(m.pill, m.prompt, m.light);
    if (m.screen) {
      if (!screen) {
        screen = new BreakScreen('Click to hide', hideScreen);
        layer.append(screen.el);
      }
      screen.update(m.screen, m.light);
    } else if (screen) {
      screen.destroy();
      screen = null;
    }
    for (const t of m.toasts || []) toast(t, m.watching, m.light);
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.target !== 'sportswitch-overlay') return false;
    render(msg.model);
    respond({shown: true});
    return false;
  });
})();
