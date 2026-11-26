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
`.deb` installs two rules files into `/usr/lib/udev/rules.d/`
(`60-burnwright-minipro.rules` for the XGecu programmers,
`60-burnwright-flashrom.rules` for the CH341A) and reloads udev, so a plugged-in
programmer just works. The AppImage can't install system files, so copy the
rules in once yourself:

```bash
curl -fsSLO https://raw.githubusercontent.com/IamMrCupp/burnwright/main/packaging/linux/udev/60-burnwright-minipro.rules
```

```bash
curl -fsSLO https://raw.githubusercontent.com/IamMrCupp/burnwright/main/packaging/linux/udev/60-burnwright-flashrom.rules
```

```bash
sudo install -m 0644 60-burnwright-minipro.rules 60-burnwright-flashrom.rules /etc/udev/rules.d/
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

## T76: the algorithm file

The T76 keeps no chip support of its own. It's FPGA-based, and before every
read, write, erase or chip check minipro loads the bitstream for that chip
family from a file called `algorithm.xml`. Those bitstreams are XGecu's — they
come out of the Xgpro package — so burnwright doesn't ship the file, doesn't
download it, and never will. You bring your own copy.

Without it, burnwright still finds the T76 and searches its chip list. Every
operation on a chip fails before anything is read or written, and burnwright says why
instead of passing on minipro's "An error occurred while sending bitstream."
The Programmer panel also warns as soon as a T76 is detected with no file in
sight.

Two ways to supply it:

- **Choose it in the app.** With a T76 detected, use "Choose file…" under
  Algorithm file in the Programmer panel. burnwright remembers the path and
  hands it to minipro as `--algorithms` on every T76 operation. The file is
  read where it is — nothing is copied into the app.
- **Put it where minipro looks.** That's
  `/usr/local/share/minipro/algorithm.xml` on Linux and macOS (or
  `$MINIPRO_HOME/algorithm.xml` if you set `MINIPRO_HOME`), and
  `%ProgramData%\minipro\algorithm.xml` on Windows.

Upstream minipro's `dump-alg-minipro.bash` builds the file from the Xgpro
package. The bitstreams are tied to the programmer's firmware: upstream pairs
Xgpro T76 V13.19 with firmware 00.1.17. A file that doesn't match gets you
"minipro can't use the algorithm file" or a chip ID that reads wrong. More in
[docs/minipro-sidecar.md](docs/minipro-sidecar.md#the-t76s-algorithm-file).

## Appearance and themes

burnwright has a light and a dark look. **Appearance**, at the bottom of the
side column, follows the system or holds one of them. On a Mac it's also under
View → Appearance in the menu bar.

You can also write your own: a theme is a small JSON file of colours in a
`themes` folder in burnwright's config directory, and it shows up in the same
list. Colours only — a theme can't touch the layout. The format, every colour
you can set and a starter file are in [docs/themes.md](docs/themes.md).

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

## What's inside a dump

**Inspect**, in the buffer's bar, scans the buffer for formats it knows — file
systems, compressed data, boot images — and lists where each one starts. Pick a
row and the hex editor goes there. A strip above the list shows how random each
stretch of the buffer looks: flat where it's erased, at the top where it's
compressed or encrypted. Under it, the text in the dump — version banners,
boot arguments, URLs — with a filter box.

It runs on this computer, in a second copy of burnwright, so a corrupt dump
that trips the scanner can't take the window down with it. It lists what it
finds and will save one as a file of its own; it doesn't unpack anything. And it hasn't met a real dump yet — only
images built for its tests.

More in [docs/inspect.md](docs/inspect.md).

## Laptop ECs

There's a second bench, **Laptop EC**, for backing up a laptop's embedded
controller with the chip still on the board. One chip so far — the ENE KB9012,
over its debug port — with a CH341A and [flashrom](https://flashrom.org), which
you install yourself. It reads and saves; it doesn't write. Nobody's run it on
a real board yet.

What you need, the wiring, and where the backup lands are in
[docs/ec-backup.md](docs/ec-backup.md).

## Streaming a session

burnwright can serve a small page for OBS to load as a Browser source, so a
programming session goes on a live stream without the app's window being
captured. The page shows the programmer, the chip, the operation and its
progress. File paths, the log and the buffer stay in the app.

It's off by default: **Stream page** in the top-right corner turns it on. It
listens on this computer only.

To show the whole window instead, capture it in OBS and turn on **Hide file
paths in this window** in the same panel: every path in the log and
everywhere else reads `[hidden]`. More on both in
[docs/stream-page.md](docs/stream-page.md).

## Support

If it's earned a spot on your bench and you'd like to throw a coffee my way:

- [Ko-fi](https://ko-fi.com/IamMrCupp)
- [Buy Me a Coffee](https://buymeacoffee.com/IamMrCupp)

No pressure — it stays open source either way.

## License
GPL-3.0-or-later. The text is in [LICENSE](LICENSE).

burnwright is built on other people's work.
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) lists every Rust crate and
npm package compiled into the app, with its licence, and ships inside every
installer; **Licences** in the app's footer opens it
([docs/notices.md](docs/notices.md)). The bundled minipro, libusb and
zlib carry their own licences and a source archive
([docs/minipro-sidecar.md](docs/minipro-sidecar.md#licensing)).
