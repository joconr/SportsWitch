/* SportsWitch 4.2.0 settings page (also Chrome's "Extension options"): the settings sheet on a full page. */
'use strict';
(() => {
  const {Sheet, Pages, showBreakPreview} = globalThis.SportsWitchSheet;
  const host = document.getElementById('host');
  const sheet = new Sheet(host, {
    embedded: true,
    onPreview: () => showBreakPreview(document.body),
    // The last Back closes the page's only sheet: show Settings again rather than a blank page.
    onClose: () => setTimeout(() => void Pages.settings(sheet), 0),
  });
  const page = location.hash.slice(1);
  if (page === 'breaks') void Pages.settings(sheet).then(() => Pages.adBreaks(sheet));
  else if (page === 'setup') void Pages.settings(sheet).then(() => Pages.setup(sheet));
  else void Pages.settings(sheet);
})();
