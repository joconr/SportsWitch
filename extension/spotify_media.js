/*
 * SportsWitch on open.spotify.com, before Spotify's player loads (the page's own world, as the manifest
 * says). It keeps the play and pause actions the web player hands to Chrome, the Media Session handlers
 * behind Chrome's and Windows' media controls, so SportsWitch can start and pause your music during ad
 * breaks the same way those controls do. Nothing else on the page is read or changed.
 */
(() => {
  'use strict';
  const KEY = Symbol.for('sportswitch.mediaSession');
  if (window[KEY] || typeof MediaSession === 'undefined') return;
  const actions = {};
  Object.defineProperty(window, KEY, {value: actions});
  const setActionHandler = MediaSession.prototype.setActionHandler;
  MediaSession.prototype.setActionHandler = function (action, handler) {
    const result = setActionHandler.call(this, action, handler);
    if (typeof handler === 'function') actions[action] = handler;
    else delete actions[action];
    return result;
  };
})();
