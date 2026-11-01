# Chrome Web Store listing and setup

Everything the Chrome Web Store Developer Dashboard asks for, ready to paste. SportsWitch is listed as
**Unlisted**: only people with the link can find and install it, and Chrome keeps every copy up to date.

The store is a second way to get SportsWitch: folder copies with automatic updates keep updating from the GitHub
releases either way. The store package (`-store.zip`) leaves out SportsWitch Updater and its `nativeMessaging`
permission, since Chrome updates the store copy itself.

## First publication (once)

1. **Developer account.** Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   with the Google account that should own SportsWitch. It needs 2-Step Verification. Pay the one-time $5
   registration fee and confirm your contact email. For the trader question, a hobby project for family is
   "non-trader".
2. **New item.** Click **New item** and upload `SportsWitch-v<version>-store.zip` from the latest
   [GitHub release](https://github.com/joconr/SportsWitch/releases/latest) (not the family ZIP: the store package
   has `manifest.json` at its top).
3. **Store listing tab.** Paste the texts below. Category: **Entertainment**. Language: **English**. Upload the
   pictures in `store/screenshots/` and `store/promo-small.png`.
4. **Privacy tab.** Paste the single purpose and the permission justifications below. Remote code: **No**.
   Data usage: tick what's listed under "Data usage", tick the three certifications, and give the privacy
   policy address.
5. **Distribution tab.** Visibility: **Unlisted**. Regions: all.
6. **Submit for review.** Google usually answers within a few days. When it's approved, the dashboard shows
   the install link: open it on each computer that should have the store copy and click **Add to Chrome**. Keep
   one copy per computer: remove its folder copy (such as SportsWitch - Stable) at `chrome://extensions`. The Web
   Store copy starts with fresh settings once.

## Automatic publishing (once, after the first publication)

From then on, every release on GitHub goes to the Chrome Web Store by itself
(`.github/workflows/chrome-web-store.yml`). It needs a Google Cloud service account that may publish:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (any name, e.g.
   "SportsWitch publishing"), search for **Chrome Web Store API** and enable it.
2. **IAM & Admin › Service accounts › Create service account** (no roles needed). Open it, **Keys › Add key ›
   JSON**, and keep the downloaded file safe; it can publish SportsWitch.
3. In the Developer Dashboard, **Account**: add the service account's email address.
4. Note your **publisher ID** (Dashboard › Publisher › Settings) and SportsWitch's **item ID** (the 32 letters
   in its dashboard and store addresses).
5. Give them to GitHub, in a terminal in the folder with the key file:

   ```
   gh variable set CWS_PUBLISHER_ID --repo joconr/SportsWitch --body "<publisher ID>"
   gh variable set CWS_ITEM_ID --repo joconr/SportsWitch --body "<item ID>"
   gh secret set CWS_SERVICE_ACCOUNT_KEY --repo joconr/SportsWitch < <key file>.json
   ```

   Then delete the key file from your computer; GitHub keeps it encrypted.

Each new release is then uploaded and submitted for review automatically. If one fails, open the release's run
under **Actions**, read the error, and use **Run workflow** with the tag to send it again.

## Store listing tab

**Name:** SportsWitch

**Summary** (132 characters at most):

> Recognises ad breaks in your sports streams, then switches to another game or mutes the ad. Trivia, scores and music fill the break.

**Description:**

> SportsWitch is a companion for watching live sports in Chrome. Add the game streams you're watching (YouTube TV, ESPN, Peacock, Prime Video, Paramount+, FOX Sports and most sites that play video in a normal tab) and SportsWitch listens for ad breaks.
>
> SWITCH MODE: follow 2 to 8 games, ranked by priority. When your game goes to ads, SportsWitch moves you to the best game that's live, and back again when you want it to.
>
> SILENCE MODE: watch one game; its ads are muted within a few seconds and the sound comes back with the game.
>
> YOUR AD BREAKS: while an ad is muted, SportsWitch can show family-friendly trivia, live scores around the league, red-zone and close-finish alerts for your other games, your ESPN fantasy matchup, and play a radio station or your own Spotify.
>
> IT LEARNS: SportsWitch remembers ads it has confirmed and recognises their next airing within about two seconds. "That's an ad" and "That's the game" (also Alt+Shift+A / Alt+Shift+G) fix a mistake at once and teach it.
>
> PRIVATE BY DESIGN: the sound is analysed on your computer and never recorded or sent anywhere. Nothing about you goes to the developer: no accounts, ads or analytics. Only the optional ad-break extras use the internet.
>
> Good to know: ad detection is an estimate and can be wrong; correcting it makes it better. SportsWitch switches and mutes; it doesn't remove or block ads, and it can't capture streams that a site protects. It isn't affiliated with any streaming service, league or ESPN.

**Category:** Entertainment · **Language:** English

## Privacy tab

**Single purpose:**

> SportsWitch helps people watch live sports in Chrome without sitting through ad breaks: it recognises ad breaks in the streams the user adds, then switches to another game or mutes the ad, and can fill the break with sports trivia, scores and music.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| tabCapture | Hears the audio of each game tab the user adds (Chrome asks for a click on SportsWitch in that tab). The audio is analysed on the device to recognise ad breaks and is never recorded or sent. |
| activeTab | Chrome grants tab capture for the tab where the user clicked SportsWitch's toolbar button; this is how a game is added. |
| offscreen | Runs the audio analysis and the optional ad-break radio player, which a service worker can't do. |
| tabs | Lists the user's open video tabs to add, switches between and mutes game tabs, reads their titles, and finds the user's own Spotify tab. |
| scripting | Shows SportsWitch's status and ad-break screen on the game being watched, reads stream titles, and presses play or pause in the user's own Spotify tab. |
| storage | Keeps settings, the lineup and what SportsWitch learned on the user's computer. |
| cookies | Only checks whether the user is signed in to espn.com (the SWID cookie), so the optional fantasy-football card can load the user's own league from ESPN. |
| debugger | Only for the optional, off-by-default "Fullscreen video after a switch" setting: after SportsWitch switches games it presses the streaming site's own fullscreen button with a trusted click. Chrome shows its notice while SportsWitch attaches, and it detaches right after. |
| alarms | A once-a-day check for updates. |
| Host permission (all sites) | Sports streams come from many different sites, so SportsWitch must show its status and ad-break screen on whichever site the user adds and read stream titles there. It also fetches trivia, scores and radio stations from Open Trivia DB, ESPN and Radio Browser, and on open.spotify.com a small script keeps the web player's own play/pause actions so SportsWitch can start and pause the user's music. |

**Remote code:** No. All code is in the package; only JSON data and audio streams are downloaded.

**Data usage:** tick

* **Website content:** the audio, titles and preview pictures of the tabs the user adds, used on the device only
  to recognise ad breaks and show the lineup.
* **Authentication information:** the espn.com SWID cookie, used only to load the user's own ESPN Fantasy league
  from ESPN, if the user sets up fantasy football.

and the certifications: not sold or transferred to third parties outside the approved uses; not used for
purposes unrelated to the single purpose; not used for creditworthiness or lending.

**Privacy policy:** https://github.com/joconr/SportsWitch/blob/main/PRIVACY.md

## Pictures

* `store/screenshots/*.png`: 1280 × 800, genuine SportsWitch screens.
* `store/promo-small.png`: 440 × 280 small promo tile.
* The 128 × 128 icon comes from the package (`icons/icon128.png`).
