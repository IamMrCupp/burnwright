# burnwright

Open-source, cross-platform GUI for XGecu / MiniPRO universal programmers
(T48, T56, T76, TL866II+), built on the [minipro](https://gitlab.com/DavidGriffith/minipro) engine.
macOS · Linux · Windows. No closed-source vendor software required.

> **Status: early, but it runs.** There's a real screen now: pick a chip, then
> read, verify, blank-check, erase or write it, with a hex editor for the image
> and a log of every minipro command. It's tested against a fake minipro — it
> hasn't read or written a real chip yet, so treat a write as unproven until it
> has. Main (code) memory only for now: no EEPROM data memory, no fuses. The
> installers also explain why they can't find a programmer (USB permissions,
> out-of-date firmware, a T76 on a USB 3 link). The T76 runs on its own bundled
> minipro build, which hasn't been through the app on a real T76 yet.

## Help test it

Got one of these programmers and a chip in a drawer? Read the chip with Xgpro
or the minipro command line, read it with burnwright, and compare the two
files. Five minutes, and a read can't hurt the chip. Then file a
[hardware test report](https://github.com/IamMrCupp/burnwright/issues/new?template=hardware-test.yml),
pass or fail.

The procedure, including when a write test is safe, is in
[docs/testing-on-hardware.md](docs/testing-on-hardware.md). What's been
confirmed so far, and by whom, is in
[docs/tested-hardware.md](docs/tested-hardware.md).

## Releases

Each [GitHub release](https://github.com/IamMrCupp/burnwright/releases) carries
installers for macOS (`.dmg`, arm64 and x86_64), Linux (`.deb`, `.AppImage`) and
Windows (NSIS `-setup.exe`), plus a `SHA256SUMS` file. How releases are built, and
how to cut a test build without shipping it, is in
[docs/releasing.md](docs/releasing.md).

**Are they signed?** The Linux and Windows installers aren't — Windows SmartScreen
will warn. A macOS `.dmg` is signed with a Developer ID and notarized by Apple if
its release was built with the project's signing secrets, and unsigned if it
wasn't (early releases, and anything built from a fork). Ask the file:

```bash
spctl -a -t open --context context:primary-signature -vv burnwright_<version>_aarch64.dmg
```

`source=Notarized Developer ID` means it opens like any other Mac app. `rejected`
means it's unsigned: open it once, let macOS refuse, then allow it under System
Settings → Privacy & Security → Open Anyway.

Each installer carries its own build of minipro (with libusb linked in) and its
chip databases, so there's nothing else to install. Building from source needs
that sidecar too: run `pnpm sidecar` once before `pnpm tauri dev`. See
[docs/minipro-sidecar.md](docs/minipro-sidecar.md).

To work on the screen with no programmer and no Rust build, run `pnpm dev` and
open `http://localhost:1420` in a browser. Outside the Tauri window the page runs
against a pretend programmer and chip (`src/dev/`), which never ships in a build.

## Linux: USB access

Linux won't let an ordinary user open a programmer without a udev rule. The
`.deb` installs one (`/usr/lib/udev/rules.d/60-burnwright-minipro.rules`) and
reloads udev, so a plugged-in programmer just works. The AppImage can't install
system files, so copy the rules in once yourself:

```bash
curl -fsSLO https://raw.githubusercontent.com/IamMrCupp/burnwright/main/packaging/linux/udev/60-burnwright-minipro.rules
```

```bash
sudo install -m 0644 60-burnwright-minipro.rules /etc/udev/rules.d/
```

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then replug the programmer. What the rules cover, and why there's no `.rpm`,
Flatpak or Snap, is in [docs/linux.md](docs/linux.md).

## T76 on macOS

On Apple Silicon Macs the T76 only answers over USB 2.0. On its own USB 3
cable it links at 5 Gb/s, shows up in System Information, and then never
answers a command — so minipro reports "No programmer found".

The fix is a USB 2.0 path: connect the T76 through a USB 2.0 hub, or with a
USB 2.0-only cable. It links at 480 Mb/s and works. burnwright checks for
this — when detect finds nothing and a T76 is sitting on a USB 3 link, it
says so and gives the same fix.

The cause is USB 3 link power management. The T76's controller misses a wake
handshake that Apple Silicon's USB host insists on, and macOS has no switch to
turn that off for one device. Linux and Windows hosts are more forgiving. The
evidence is in [#50](https://github.com/IamMrCupp/burnwright/issues/50).

## Finding minipro

burnwright drives the `minipro` CLI rather than talking USB itself. It looks
for the binary in this order and uses the first one it finds:

1. The minipro path set in the app.
2. `BURNWRIGHT_MINIPRO`, either a full path or a program name to look up on
   `PATH`.
3. The minipro bundled with the app, run with its own chip databases. There
   are two builds: `burnwright-minipro` (the 0.7.4 release) for the TL866A/CS,
   TL866II+, T48 and T56, and `burnwright-minipro-t76` (a later upstream
   commit) for the T76 only. See
   [docs/minipro-sidecar.md](docs/minipro-sidecar.md) for why.
4. `minipro` on `PATH`.

An installed burnwright always has step 3, so steps 1 and 2 are for running a
different minipro, such as a newer build from upstream. That one uses its own
databases and drives every programmer. If a path you set, or the bundled
minipro, isn't there, burnwright stops with an error instead of quietly
running some other minipro.

Chip operations on the T76 also need XGecu's algorithm file (`algorithm.xml`).
It's a vendor file, so burnwright doesn't ship it: you extract your own with
upstream's `dump-alg-minipro.bash`. Details are in
[docs/minipro-sidecar.md](docs/minipro-sidecar.md).

## License
GPL-3.0-or-later (inherited from libminipro).
