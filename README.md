# WebSDR-Sync — Control web SDR with a transceiver

Built with Claude assistence.

Rig control through **Hamlib rigctld over TCP**, a WebSDR filling the rest of the window, the
receiver following the rig frequency, and the receiver muted while you transmit. Tested on macOS and Windows, should run on the same platforms as Chrome and Hamlib do.

```
manifest.json             the extension  (its "key" pins the extension ID)
console.html              the console UI
console.js                rigctl protocol, WebSDR sync, mute logic
bridge.js                 injected into the receiver's page
sw.js                     toolbar button opens the console
host/websdrsync_host.py   TCP relay — Chrome starts it, you never do
host/install-host.sh      registers the relay     (macOS / Linux)
host/uninstall-host.sh    removes it again        (macOS / Linux)
host/install-host.ps1     registers the relay     (Windows)
host/uninstall-host.ps1   removes it again        (Windows)
```

## Version

This package is **0.2**. Two digits, and the leading zero means beta: the second digit goes up
with each iteration (0.2, 0.3, …), the major digit reaches 1 only when the beta is declared over.
The top bar shows it next to the name.

Chrome's manifest wants at least two dot-separated numbers and most tooling assumes three, so the
manifest carries the padded form **0.1.0** — the same version with a trailing zero. The console
strips that zero for display, so what you read on screen is the package version.

Bumping it means editing three things and nothing else: `version` in `manifest.json` (padded),
`VERSION` in `host/websdrsync_host.py` (unpadded), and the name of the zip. Chrome loads an
unpacked folder whatever its version, so going from an older, higher number to 0.1 is fine — just
**Reload** on `chrome://extensions`.

## Install

**Put this folder somewhere local first** — not OneDrive, iCloud Drive, Dropbox or Google Drive,
and not Desktop/Documents if those are iCloud-synced. `C:\WebSDR-Sync` or `~/WebSDR-Sync` is ideal.
On macOS this is not optional: the system refuses to let Chrome execute the relay out of a
cloud-provider mount (`~/Library/CloudStorage/…`) and reports it only as the unhelpful
"Native host has exited", so `install-host.sh` declines to install from there at all.

Then follow your platform, and in both cases finish with:
`chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder. Quit and
reopen Chrome completely if it was already running.

### macOS / Linux

```sh
cd host
./install-host.sh
./install-host.sh --test        # confirms the relay runs, without Chrome
```

### Windows

```powershell
cd host
powershell -ExecutionPolicy Bypass -File .\install-host.ps1
powershell -ExecutionPolicy Bypass -File .\install-host.ps1 -Test
```

`-ExecutionPolicy Bypass` is needed because Windows blocks scripts that came out of a downloaded
zip. The installer also clears the Mark of the Web from the whole folder for you, so later runs
can be a plain `.\install-host.ps1`.

Windows needs Python, which it does not ship: install it from
[python.org](https://www.python.org/downloads/) and tick **Add python.exe to PATH**. Do not rely on
the Microsoft Store stub at `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` — it is an alias
that opens the Store rather than running anything. The installer detects and skips it, then tells
you nothing usable was found.

Where Unix drops a file into a known directory, Windows registers the relay in the **registry**:

```
HKCU:\Software\Google\Chrome\NativeMessagingHosts\nl.websdrsync.rigctld_bridge
  (Default) = <this folder>\host\websdrsync_host.win.json
```

The installer writes that key for Chrome, Chrome Beta, Canary, Chromium, Edge and Brave — all
under `HKCU`, so no administrator rights. Chrome cannot execute a `.py` directly, so the registered
manifest points at a generated `websdrsync_host.bat` which calls the interpreter that was verified
during install. It uses `pythonw.exe` where available so no console window flashes up; pass
`-ShowConsole` if you would rather see one.

`-Test` / `--test` pings the relay exactly as Chrome does but without Chrome. For removal, see
[Uninstall](#uninstall) below.

### Then

Start rigctld, click the toolbar button, and press **Connect**:

```sh
rigctld -m 1042 -r /dev/cu.usbserial-XXXX -s 38400     # macOS
rigctld -m 1042 -r COM4 -s 38400                       # Windows  (Enhanced COM port)
```

`-m 1042` is the FTDX-10. The rig name shown next to the connection status is read from the radio, so a wrong model number
is visible immediately.

## Uninstall

Two steps, because a script cannot do the second one.

**1. Remove the relay.**

```sh
cd host && ./uninstall-host.sh              # macOS / Linux
```
```powershell
cd host
powershell -ExecutionPolicy Bypass -File .\uninstall-host.ps1     # Windows
```

Add `--dry-run` (or `-DryRun` on Windows) first if you want to see exactly what would go without
changing anything.

This clears the native-messaging registration for every Chromium-family browser — Chrome, Beta,
Canary, Chromium, Edge and Brave — under both the current host name and the pre-rename
`nl.catsdr.rigctld_bridge`, then deletes the files the installer generated: the launcher, the
Windows host manifest, the relay log and `__pycache__`. Shipped sources are never touched, so
re-running `install-host` afterwards puts everything back.

It re-checks when it is done and prints `Relay removed. Nothing of it is left registered on this
machine.` If something could not be deleted it says which item and exits non-zero, rather than
claiming success. Running it twice is harmless.

`install-host --uninstall` / `-Uninstall` still works; it just calls the same script.

**2. Remove the extension.** `chrome://extensions` → **Remove** on WebSDR-Sync. Your saved settings
— rigctld host and port, receiver choice, poll intervals, and which panels you leave open — live in
the extension's own storage and go with it.

After both steps the folder itself is inert; delete it whenever you like.

## Why a native messaging host

A browser cannot open a raw TCP socket — there is no API for it in a page, and MV3 extensions have
none either (`chrome.sockets.tcp` belonged to Chrome Apps, which are gone). Something outside the
browser has to make the connection.

A native messaging host is the version of that with no daemon: Chrome launches
`websdrsync_host.py` when the console connects and kills it when the console closes. There is nothing
to start and nothing to remember.

```
console.html ──native messaging──▶ websdrsync_host.py ──TCP──▶ rigctld ──serial──▶ radio
     │                                                                    
     └──postMessage──▶ bridge.js (inside the WebSDR page) ──▶ setfreqif() / Mute
```

The relay is deliberately dumb — it opens one socket and shuttles bytes, knowing nothing about
Hamlib — so it works against any line-oriented TCP rig server. It refuses to connect anywhere
outside loopback and private-network addresses.

`manifest.json` carries a `key` field that pins the extension ID to
`oemieknppkbaemfioegnockcekglefbn`. Without it an unpacked extension gets an ID derived from its
folder path, and the relay's `allowed_origins` would stop matching the moment you moved the folder.

## Why rigctld rather than the serial port

Only one program can hold a serial port. rigctld holds it and multiplexes, so WSJT-X, your logger
and this console can all use the radio at once. It also means the radio does not have to be on the
same machine as the browser — point **rigctld host** at another box on the LAN.

The console only ever *reads*: `f` (frequency), `m` (mode), `t` (PTT). No frequency, mode or PTT
command is ever sent to the radio.

| Field | Meaning |
|---|---|
| rigctld host | `127.0.0.1`, or another machine on your LAN |
| Port | rigctld's port, 4532 by default |
| Freq poll | frequency and mode, default 1000 ms |
| PTT poll | TX/RX state, default 300 ms — fast enough for SSB and FT8 |

Only one command is outstanding at a time, so replies match requests by order; the rigctl protocol
carries no request ids. Hamlib mode names are mapped to the receiver's — `PKTUSB`/`USB` → USB,
`PKTLSB`/`LSB` → LSB, `CW`/`CWR` → CW, and so on.

If your backend cannot report PTT it answers `RPRT -11`; the console says so once and carries on
without TX muting rather than filling the log.

## Receivers

| Receiver | URL | Coverage |
|---|---|---|
| Maasbree PH4RTM — low | `sdr.websdrmaasbree.nl:8901` | 160 m – 15 m |
| Maasbree PH4RTM — high | `sdr.websdrmaasbree.nl:8902` | 40 m – 10 m |
| Hack Green G4NNS | `hackgreensdr.org:8901` | 160, 80, 60, 40, 20, 17 m |
| Bordeaux | `ham.websdrbordeaux.fr:8000` | 80, 40, 20, 15, 10 m + 2 m, 70 cm, QO-100 |
| Twente PI4THT | `websdr.ewi.utwente.nl:8901` | 0 – 29.16 MHz, one wideband slice |

Coverage is recorded per receiver in kHz in the `SDRS` array, read off each receiver's own
`bandinfo` (centre ± samplerate/2). It drives two things.

**Auto** — the first entry in the receiver list. It picks the first receiver in the list that
covers the rig's frequency, so a QSY from 80 m to 10 m moves you from Maasbree low to Maasbree high
on its own. Handing over means loading a different site, so it only happens when the current
receiver genuinely cannot reach the frequency — within one receiver, tuning stays seamless.

**A warning instead of silence** — pick a receiver by hand, tune outside its coverage, and you get
a banner saying so rather than a receiver sitting on the wrong frequency. On Auto, a frequency no
listed receiver reaches (6 m and 23 cm, as the list stands) says so and leaves the current receiver
alone instead of retuning it pointlessly.

## Adding a receiver

Three places, then reload the extension on `chrome://extensions`:

1. `manifest.json` → `host_permissions`
2. `manifest.json` → `content_scripts[0].matches`
3. `console.js` → the `SDRS` array near the top

```js
{ id:"myrx", name:"Some receiver", url:"http://host:port/",
  coverage:[[7000,7300],[14000,14350]] },      // kHz; omit if unknown
```

**Ports are not part of a match pattern.** Chrome match patterns cannot contain one and match every
port on the host, so a single `http://sdr.websdrmaasbree.nl/*` entry covers both the low receiver on
:8901 and the high one on :8902 — only the `SDRS` url needs the right port. Adding another receiver
at a host already listed needs no manifest change at all.

The receiver list is deliberately fixed — there is no free-text URL box. Every entry has been
checked for software flavour, band coverage and frame behaviour, so anything in the dropdown works.
A receiver added to `SDRS` but not the manifest still loads, but without the bridge: the console
notices, warns in the banner and the log, and falls back to `?tune=` URL mode, which reloads the
receiver on every QSY. There is no permanent "linked" badge in the top bar — with a fixed list of
manifest-covered receivers it was green every time it was looked at, and the receiver itself is on
screen below. A missing bridge speaks up instead of a healthy one announcing itself.

Only PA3FWM WebSDR sites will link. KiwiSDR and OpenWebRX run different software and would need a
different bridge.

## Behaviour worth knowing

* **Following is continuous.** The console re-checks once a second, so dragging the receiver's own
  waterfall snaps back within a second. Uncheck **Follow rig frequency** to park it elsewhere. It
  does not chase the dial while you are transmitting.
* **Mute is yours to keep.** A mute you set by hand survives a TX/RX cycle; the console only
  releases a mute it set itself.
* **The console reopens as you left it.** Every control in Rig setup and SDR setup is saved as you
  change it, and so is whether each of the three panels — Rig setup, SDR setup, Log — is open. Set
  the window up once, with the panels you actually watch, and that is what you get next time. A
  fresh install starts with the two setup panels open and the Log closed.
* **Two WebSDR flavours.** PA0SIM's fork (Maasbree) exposes `is_mute` / `MakeCheckbox`; stock
  PA3FWM (Twente, Hack Green, Bordeaux) has neither, only `setmute()` and a `#mutecheckbox` element. The bridge detects
  which it is and reports back whether muting is possible at all, so a receiver with no reachable
  mute says so instead of failing quietly.
* **Band is switched explicitly before tuning.** A receiver in "one band" view — Bordeaux's
  default — will not cross bands on its own: its `setfreqb()` returns early in that view, so a
  cross-band QSY silently does nothing. The bridge works out which band contains the target from
  the receiver's own band table and calls `setband()` first. Correct in every view, on every
  receiver.
* **Squelch can be opened per receiver.** Bordeaux arrives with squelch closed, which just sounds
  dead when the console is steering it. Its `SDRS` entry carries `squelchOff: true`; add the same
  flag to any other receiver that needs it.
* **The TX/RX badge says what it knows.** It reads `IDLE` only while nothing is connected. The
  first PTT poll after a connect paints it `RX` or `TX` — even a first reading of "receiving",
  which is not a change of state. A rig whose backend refuses `t` (rigctld answers `RPRT -11`)
  shows `NO PTT`: TX cannot be detected, so TX muting cannot work, and the badge says so instead
  of sitting on `IDLE` as though nothing had been polled.
* **The rig identifies itself.** On connect the console asks rigctld for `\dump_caps` and shows
  the manufacturer and model as the connection status — the host and port live in Rig setup, so a wrong `-m` model number is obvious
  rather than mysterious.
* **Some receivers try to break out of the frame.** Twente runs
  `if (top != self) top.location.replace(...)`, which would replace the console with the receiver
  and take the rig panel with it. The iframe's `sandbox` attribute omits `allow-top-navigation`, so
  Chrome refuses. You will see one `Failed to execute 'replace' on 'Location'` message in the
  devtools console when such a receiver loads — that is the block working, not a fault.
* **Out-of-band is reported.** If the rig moves somewhere the receiver cannot cover you get a
  banner, not silence on the wrong frequency.
* Chrome will not start audio until you click once inside the receiver — browser autoplay policy.

## What was verified

Run with the extension actually loaded in Chromium, against a mock rigctld and a mock PA3FWM
receiver — real native messaging, real TCP:

* a Twente-style `top.location.replace()` framebust is blocked — console and rig panel survive
* mute works on a stock receiver (`setmute` + checkbox only) and on a PA0SIM one (`is_mute` +
  `MakeCheckbox`)
* Auto moves between receivers as the rig crosses band coverage, and back again
* a hand-picked receiver tuned out of coverage raises the banner
* the extension ID matches the pinned key, so the relay's `allowed_origins` holds
* Connect brings up the native host and the TCP link; frequency and mode appear
* a QSY on the rig retunes the receiver **without reloading the frame**
* PTT mutes the receiver, dropping PTT unmutes it
* `PKTUSB` maps to USB
* a backend refusing PTT warns exactly once and keeps running
* killing rigctld tears down cleanly and re-enables Connect
* no console errors

Not testable here: your real FTDX10 through real rigctld, and the live Maasbree receiver. If the
frequency does not appear after Connect, open the **Log** panel — every command and reply is there.

## Renamed

The extension, the relay script and its native-messaging host name all changed, so **re-run
`host/install-host.sh`** — the relay is registered as `nl.websdrsync.rigctld_bridge` now and the
script is `host/websdrsync_host.py`. Two things soften it if you forget:

* the console falls back to the old `nl.catsdr.rigctld_bridge` registration once, says so, and
  tells you to re-run the installer;
* saved settings migrate from the old `localStorage` key automatically.

The extension ID is unchanged — it is pinned by the manifest `key`, not derived from the name.
The old `install-host.sh --uninstall` from a pre-rename copy will clear the stale registration.

## Troubleshooting

First stop, always:

```sh
cd host && ./install-host.sh --test
```

That drives the relay exactly as Chrome does, without Chrome, and tells you whether the problem is
the relay or the browser. Its stderr is captured in `host/websdrsync_host.log`.

**"Native host has exited"** — Chrome could not get the relay running. Check
`host/websdrsync_host.log` first: a `started …` line whose `argv` contains a `chrome-extension://…`
origin means Chrome did launch it and the problem is later; no such line means the process never
reached Python at all. Causes, most common first:

* *The folder is on cloud storage.* `~/Library/CloudStorage/…` (OneDrive, Box, Drive via File
  Provider), iCloud Drive, Dropbox. macOS blocks the exec. Move the folder somewhere local and
  re-run `install-host.sh` — it stores absolute paths, so moving without re-running breaks it.
  Because the extension ID is pinned by the manifest `key`, re-loading unpacked from the new path
  keeps the same ID and nothing else needs changing.
* *Gatekeeper quarantine.* Files unpacked from a downloaded zip carry `com.apple.quarantine` and
  macOS refuses to let Chrome exec them. `install-host.sh` now strips it; re-run it. To check by
  hand: `xattr -r com.apple.quarantine .`
* *A python3 that is present but does not run.* `/usr/bin/python3` on macOS is a stub that exits
  unless the Command Line Tools are installed. `install-host.sh` now proves each candidate
  interpreter before baking it in, and prints `skipping … (present but does not run)` when it
  rejects one.
* *A crash at startup.* The traceback is in `host/websdrsync_host.log`.

**Windows: "cannot be loaded because running scripts is disabled"** — the execution policy.
Run it as `powershell -ExecutionPolicy Bypass -File .\install-host.ps1`, which does not change any
system setting.

**Windows: "present but does not run" for a Python that is clearly fine** — fixed in 2.5.1. The
installer's probe used to pass Python a one-liner containing double quotes; Windows PowerShell
wraps an argument containing spaces in double quotes when it builds the command line, so the
embedded ones closed that quoting early and Python received mangled source. The probe now contains
no double quotes, prints the exit code and output of every rejected candidate, and `-Python
'C:\Path\To\python.exe'` forces a specific interpreter.

**Windows: the relay starts but nothing arrives** — almost always the interpreter. Run
`.\install-host.ps1 -Test`; it reports whether the relay answered, and shows its stderr when it did
not. `host\websdrsync_host.log` has the Python side.

**"Specified native messaging host not found"** — a different error, meaning registration itself
failed: `install-host.sh` has not run, or Chrome was not fully quit and reopened. Re-run it after
moving this folder, since the host manifest stores an absolute path.

**Connect fails with a connection error** — the relay is fine but rigctld is not there. Check with
`rigctl -m 2 -r localhost:4532 f`.

**No PTT** — see the `RPRT -11` note above.

Useful on their own:

```sh
python3 host/websdrsync_host.py --selftest   # version, interpreter, log location
cat host/websdrsync_host.log                 # every launch, and any error
```
