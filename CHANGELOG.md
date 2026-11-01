# What's new in SportsWitch

The newest version first. Install and update instructions are in the [README](README.md).

## SportsWitch 4.4.0

**Released:** 2026-10-31

SportsWitch now keeps itself up to date from its GitHub page. Install this version by hand once (see
[how to install it](README.md)), double-click **Set up automatic updates** in its folder, and later versions
arrive by themselves.

### What's new

* **It updates itself.** Once a day SportsWitch looks for a new version on its GitHub page. With automatic
  updates set up, it installs it between games, never during one, and restarts by itself. Your settings,
  ad-break choices and everything it has learned stay the same, unless an update's notes say it changes
  something.
* **Set up automatic updates** is in the SportsWitch folder: double-click it once on each computer (if Windows
  asks whether to run it, choose Run). It adds SportsWitch Updater, a small helper that installs only versions
  signed by SportsWitch's developer. No administrator rights needed.
* **Settings › Updates** shows your version and when SportsWitch last checked, with **Check now**, **Install
  now** and a switch to turn automatic installing off. Right after an update, the popup links to what's new.
* **Settings › Privacy** explains in plain words what SportsWitch reads and where it goes. The welcome guide
  links to it too.

### Good to know

* To keep your settings, put 4.4.0 in the folder you already use: copy the files from the ZIP's SportsWitch
  folder over the old ones, then click the reload arrow on SportsWitch in `chrome://extensions`. Keep the folder
  where it is from then on.
* Without the setup step, SportsWitch still checks every day and the popup says when a new version is out.
* SportsWitch is getting ready for the Chrome Web Store too, where Chrome keeps it up to date.
* Ad detection, switching, Silence mode and the ad-break extras work exactly as before.

## SportsWitch 4.3.0

**Released:** 2026-10-30

Spotify during ad breaks now works with your own Spotify account. See [how to install it](README.md).

### What's new

* **Spotify plays through your own account.** Just open Spotify in a Chrome tab (open.spotify.com) and sign in
  as you normally would. Free and Premium both work. When an ad break starts, SportsWitch presses play; when the
  game is back, it presses pause.
  * The old setup, with a Spotify developer app, a Client ID and a separate sign-in, is gone. That sign-in didn't
    work for most people.
  * **Customize your ad break › Spotify** shows whether your Spotify tab is open and signed in, and can open it
    for you.
  * **Try it** plays Spotify for five seconds, so you can check everything works before the game.
  * The ad-break screen shows the song that's playing.

### Good to know

* In the Spotify tab, press play once and then pause before the game starts. Chrome only lets SportsWitch start
  music in a tab where you've played something.
* Keep the Spotify tab open. It can stay in the background, and SportsWitch keeps Chrome from putting it to sleep.
* Spotify plays at its own volume, so use Spotify's volume slider. It plays instead of the radio; turning one on
  turns the other off.

## SportsWitch 4.2.1

**Released:** 2026-10-30

A small update to Switch mode. See [how to install it](README.md).

### What's new

* **You choose whether SportsWitch goes back to your top game.** A new switch, **Return to higher-priority
  games**, sits right under the Switch button in the popup and the controller.
  * **On** (as before): when a game higher in your lineup is back from its ads, SportsWitch goes back to it.
  * **Off:** SportsWitch still leaves a game when it goes to ads, but then stays on the game it moved to. It moves
    again only when that game has an ad of its own (then it picks the highest game in your lineup that's live), or
    when you pick a game yourself.
  * The same switch is also in **Settings › Switch mode**.

### Good to know

* It starts out on, so nothing changes until you turn it off.
* Updating in the same folder keeps your settings and everything SportsWitch has learned.

## SportsWitch 4.2.0

**Released:** 2026-10-29

SportsWitch for Chrome now does everything SportsWitch for Android does, and still switches between your
streams on its own. See [how to install it](README.md).

### What's new

* **Catches ads faster and makes fewer mistakes.**
  * It listens to every stream about once a second and keeps a running estimate of whether an ad break is on.
    It acts when it is 90% sure and brings the game back below 50%.
  * One odd second no longer causes a switch, while a clear ad is caught within a few seconds.
  * The short silence between the game and the ads, an ad it has heard before, and audio that already aired
    earlier in the evening all count as strong evidence. Promos full of crowd noise are caught the second time
    they air.
* **It learns your streams.** Each ad it confirms is remembered, so its next airing, on any of your games, is
  recognised within about two seconds. It also adapts to how your streams sound. Nothing leaves your computer.
  * **That's an ad** and **That's the game** fix a mistake at once and teach SportsWitch. They're in the popup
    and the controller, and on the keyboard: **Alt+Shift+A** and **Alt+Shift+G**.
  * **Settings › Reset what SportsWitch learned** starts over.
* **Customize your ad break.** While an ad is muted, SportsWitch can fill the break:
  * family-friendly trivia, with topics you choose;
  * live scores around the league;
  * red-zone and close-finish alerts for the other games in your lineup, with a **Watch** button (or switch by
    itself with **Jump to big moments**);
  * your ESPN fantasy matchup, with scoring alerts in the corner;
  * a radio station, with the ad turned down under it or silenced completely, or your Spotify on another
    speaker.
  * Try it with **▶ Preview** in the popup. Click the screen to hide it until the break ends.
* **Status in the corner.** A small pill on the game shows what SportsWitch hears, even over fullscreen video.
* **New settings pages.** Every option explains itself and applies straight away. A short welcome guide opens
  the first time.
* **Remove one game** from the lineup with ✕, without stopping the others.
* **Lighter animations** for slower computers (Settings › Display & data).

### Good to know

* Your choices for fallback mute, the whoosh and fullscreen carry over. The old confidence and confirmation
  sliders are replaced by the two new detection settings.
* Switch mode still listens to all your games at once and moves to whichever is live, as before.
* SportsWitch asks for one new permission: reading whether you're signed in to espn.com, for the fantasy card.
* Only the ad-break extras use the internet. Ad detection never does.
