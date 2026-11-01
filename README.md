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

**Chrome Web Store:** coming. The unlisted install link will be here once Google approves SportsWitch; Chrome
keeps that copy up to date.

## What's new

Every version, in plain words: [CHANGELOG.md](CHANGELOG.md).

## What's in this repository

* `extension/`: the extension as a folder copy has it, including `updater/`, SportsWitch Updater. `setup.ps1`
  registers it with Chrome for the current Windows account (no administrator rights) so that only the
  SportsWitch in that folder can start it; `sportswitch_updater.ps1` downloads a release from here, checks its
  signature against `release-key.xml`, and copies it over the folder.
* [Releases](../../releases): for each version, `SportsWitch-v<version>.zip` (Load unpacked) with its `.sha256`
  checksum and `.sig` signature, made with a key that never leaves the developer's computer, and
  `SportsWitch-v<version>-store.zip`, the Chrome Web Store package, which leaves the updater out.
* `store/`: the Chrome Web Store listing, pictures and setup steps.
* `.github/workflows/`: sends each release to the Chrome Web Store, once that is set up.

SportsWitch isn't affiliated with any streaming service, league or ESPN.
