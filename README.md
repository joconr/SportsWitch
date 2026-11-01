# SportsWitch

SportsWitch is a Chrome extension for watching live sports without sitting through the ads. Add the game streams
you're watching (YouTube TV, ESPN, Peacock, Prime Video, Paramount+, FOX Sports and most other sites) and
SportsWitch listens for ad breaks:

* **Switch mode** follows 2 to 8 games and moves you to the best one that's live when yours goes to ads.
* **Silence mode** mutes the ads on one game and brings the sound back with the game.
* **Your ad breaks** can fill the break with trivia, scores, your ESPN fantasy matchup, a radio station or your
  own Spotify.

The sound is analysed on your computer and never recorded or sent anywhere. See the [privacy policy](PRIVACY.md).

## Install

1. Download `SportsWitch-v<version>.zip` from the [latest release](../../releases/latest) and extract it somewhere
   it can stay, such as Documents.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the **SportsWitch**
   folder (the one with `manifest.json` in it). Pin SportsWitch with the puzzle-piece Extensions button.
3. Once on each computer, double-click **Set up automatic updates** in that folder. If Windows asks whether to run
   it, choose **Run**.

From then on SportsWitch checks this page every day and installs new versions between games, keeping your
settings and everything it has learned. **Settings › Updates** in SportsWitch shows the version, checks right away
and can turn automatic installing off. Without step 3, SportsWitch says when a new version is out, and you put the
new files in the same folder.

## What's new

Every version, in plain words: [CHANGELOG.md](CHANGELOG.md).

## What's here

* [Releases](../../releases): each version's `SportsWitch-v<version>.zip`, with a `.sha256` file for checking the
  download and a `.sig` signature that automatic updates check before installing it.
* `extension/`: SportsWitch itself, as the ZIP has it. In it, `updater/` is SportsWitch Updater, the small helper
  behind automatic updates: it needs no administrator rights and installs only versions signed by SportsWitch's
  developer.

SportsWitch isn't affiliated with any streaming service, league or ESPN.
