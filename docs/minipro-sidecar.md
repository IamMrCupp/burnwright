# The minipro sidecar

Every installer carries its own minipro, so burnwright can talk to a programmer
on a machine that's never seen Homebrew, a `-dev` package or MSYS2. It's built
from the `vendor/minipro` submodule, never patched, and shipped as a Tauri
sidecar (`bundle.externalBin`) with minipro's chip databases as resources.

## Two builds: stable and T76

There are actually two sidecars, built the same way from two pins of the same
upstream repository:

| | Submodule | Pinned at | Drives |
|---|---|---|---|
| `burnwright-minipro` | `vendor/minipro` | the 0.7.4 release | TL866A/CS, TL866II+, T48, T56 |
| `burnwright-minipro-t76` | `vendor/minipro-t76` | upstream `master` 3e2f491 | the T76 only |

0.7.4 can't see a T76 at all. The upstream commits that can also break AVR
fuse reads and writes (upstream #382, #388) and some T48 writes (upstream
#373), so no single commit is right for every programmer (#13).

`detect` asks the stable build first. 0.7.4 looks only for the TL866 and
TL866II-family USB IDs, so a lone T76 is "no programmer" to it; only then
does the T76 build get a look. Whichever build the detected programmer needs
drives every operation after that (`crates/engine/src/route.rs`). A minipro
you set yourself (the path setting, `BURNWRIGHT_MINIPRO`) or one found on
`PATH` drives every programmer: routing only ever picks between the two
bundled builds.

Each build has its own databases, because the T76 build's `infoic.xml` adds
the T76 chips and changes some older entries. That's a second ~19 MB
`infoic.xml` in every installer.

Chip lists, searches and chip info don't wait for a detect. They go by the
programmer asked about: the T76's come from the T76 build and its database,
everyone else's from the stable build. The T76's list has about 1,700 names
with a space in them, which are kept, and 98 that end with a space or hold a
tab, which are left out: minipro matches names exactly and burnwright trims
the ones it passes, so those couldn't be selected anyway.

The T76 also needs XGecu's `algorithm.xml`, which burnwright never ships. See
[The T76's algorithm file](#the-t76s-algorithm-file).

When an upstream release fixes the AVR and T48 regressions and keeps T76
support, move `vendor/minipro` to it and drop `vendor/minipro-t76`, the
`t76` variant in `scripts/minipro/`, its `tauri.conf.json` entries and
`crates/engine/src/route.rs`.

## The T76's algorithm file

The T76 is FPGA-based and holds no bitstreams. At the start of every chip
operation minipro uploads the one the chip family needs
(`t76_send_bitstream()` in `vendor/minipro-t76/src/t76.c`), and it reads them
from `algorithm.xml`. XGecu ships those bitstreams inside Xgpro, so the file
is vendor data. burnwright doesn't ship it, download it or build it, and it
isn't in the repo, a fixture or a test. The user supplies their own, built
from the Xgpro package with upstream's `dump-alg-minipro.bash`.

Where the T76 build looks (`get_database_file()` in
`vendor/minipro-t76/src/database.c`):

1. The file given with `--algorithms <file>`, and nowhere else. If it isn't
   there, that's the error — minipro doesn't fall back.
2. Otherwise `algorithm.xml` in the working directory.
3. Then `$MINIPRO_HOME/algorithm.xml` if `MINIPRO_HOME` is set, else
   `algorithm.xml` in the share directory compiled in. The sidecars are built
   with upstream's default prefix, so that's
   `/usr/local/share/minipro/algorithm.xml` on Linux and macOS. On Windows
   it's `%ProgramData%\minipro\algorithm.xml`, and `MINIPRO_HOME` isn't read.

What burnwright does with that:

- **The setting.** "Choose file…" under Algorithm file in the Programmer
  panel (shown once a T76 is detected) stores the path. Every T76 chip
  operation then runs with `--algorithms <that file>`
  (`MiniproRoutes::for_operation` in `crates/engine/src/route.rs`). Chip
  list and chip info queries don't get it, and neither does any other
  programmer. The Rust side holds the path for the session; the frontend
  keeps it in the webview's local storage and hands it back at startup.
  Only the path is stored. The file stays where it is. If handing the path
  back fails at startup, burnwright says so in the Programmer panel and the
  log, and asks again at the next detect: an operation never runs quietly
  without the file you chose. While the file panel is up, no operation starts
  and no other file panel opens, the same as for Open and Save.
- **The error.** When minipro can't open the file, the operation fails with
  `missing_algorithms` and the path minipro tried. When it opens the file and
  finds no usable bitstream for the chip ("No algorithm SPI25F11 was found.",
  a parse error, a bad CRC), it fails with `unusable_algorithms`. Both come
  before any read or write. That isn't the same as the socket being left
  alone: for NAND and eMMC parts minipro powers the socket adapter and runs
  pin detection before it looks for the algorithm (`t76_adapter_init()` and
  `t76_emmc_adapter_init()` in `t76.c`). minipro's own last line in either
  case is "An error occurred while sending bitstream.", which it also prints
  for a real USB failure, so burnwright goes by the lines above it
  (`crates/engine/src/algorithms.rs`).
- **The notice.** After a detect finds a T76, burnwright checks the same
  places minipro would and warns in the Programmer panel if no file is
  there. For a minipro you set yourself it can't know the compiled-in share
  directory, so it stays quiet unless a file is chosen or `MINIPRO_HOME` is
  set.

The bitstreams are tied to the programmer's firmware. Upstream's `t76.md`
pairs Xgpro T76 V13.19 with firmware 00.1.17, and says a mismatch shows up as
a bad or empty chip ID.

The fixtures for this (`crates/engine/fixtures/minipro/t76_algorithm_*.stderr`)
were captured from a real T76 with `capture-t76-algorithm.sh`. Each run is a
chip ID read of an SPI flash part, which has no adapter step, so it fails
before minipro touches the socket. None of them involves an XGecu file:
the "unusable" one hands minipro its own `logicic.xml`.

The T56 loads bitstreams from `algorithm.xml` too, under the stable build,
from the same default places. burnwright recognises the same failure there
but has no setting for it yet: 0.7.4 reads a different layout of the file
(`algorithms_t56` where the T76 build has `algorithms_T56` and
`algorithms_T76`), and nobody has tried a T56 here.

## Where things land

| | Sidecar | Databases, licences, NOTICE |
|---|---|---|
| macOS `.app` | `Contents/MacOS/burnwright-minipro` | `Contents/Resources/minipro/` |
| Linux `.deb` | `/usr/bin/burnwright-minipro` | `/usr/lib/burnwright/minipro/` |
| AppImage | `usr/bin/burnwright-minipro` | `usr/lib/burnwright/minipro/` |
| Windows (NSIS) | `burnwright-minipro.exe` next to `burnwright.exe` | `minipro\` in the install folder |
| `pnpm tauri dev` | `target/debug/burnwright-minipro` | `target/debug/minipro/` |

The T76 build sits next to it as `burnwright-minipro-t76[.exe]`, with its
databases in `minipro-t76/` beside `minipro/`.

So the app finds it as `current_exe().parent()/burnwright-minipro[.exe]` and the
databases under `resource_dir()/minipro/`. Pass those with `--infoic` /
`--logicic`. minipro's built-in default (`/usr/local/share/minipro`, or
`%ProgramData%\minipro` on Windows) isn't populated by any installer.

On Linux the sidecar also needs udev rules before an ordinary user can open
the programmer. The `.deb` installs them; AppImage users copy them in by hand.
See [linux.md](linux.md).

It's called `burnwright-minipro`, not `minipro`, because Tauri puts sidecars in
`/usr/bin` on the `.deb`. A plain `minipro` there would collide with the distro's
own package and shadow whatever the user already has on `PATH`.

## What's linked

libusb is **statically linked on every platform**, built from a pinned,
hash-checked upstream release (`scripts/minipro/versions.sh`). That beats
bundling a dylib and rewriting install names: one file, no `@rpath` or re-signing
dance, and the deployment target is ours to set (macOS 11.0 on arm64, 10.13 on
x86_64) rather than whatever the Homebrew bottle was built for.

| Platform | Runtime dependencies |
|---|---|
| macOS | `libSystem`, `libz`, `libobjc`, IOKit, CoreFoundation, Security: all part of macOS |
| Linux | glibc and `libz.so.1` (the `.deb` declares `zlib1g`). libusb is built without udev, so there's no `libudev` either. |
| Windows | Windows system DLLs only. A fully static `.exe` with the libusb backend; zlib is built from a pinned release as well. |

### macOS: an SDK newer than the deployment target

Setting the deployment target isn't enough by itself. When the SDK is newer than
the target, it declares functions the oldest supported macOS doesn't have. clang
only warns about a call to one and weak-links it: the build passes, the binary
runs on a new enough Mac, and on anything older the symbol is null and the call
is a jump to address 0. That's #97: the macOS 27 SDK added `pipe2`, libusb's
configure found it, and the sidecar segfaulted at `libusb_init` on every macOS
before 27.

`build-sidecar.sh` guards against it three ways:

- **libusb's configure is told `ac_cv_func_pipe2=no`.** The probe is a link test
  with its own prototype, so it never sees the SDK's availability attribute and
  no compiler flag changes its answer. libusb falls back to `pipe()` + `fcntl()`.
- **libusb and minipro compile with `-Werror=unguarded-availability-new`.** A
  call to anything newer than the deployment target stops the build, naming the
  function. The fix is then another `ac_cv_func_<name>=no` next to the first.
- **After linking, `nm -m` on the sidecar must list no `(undefined) weak
  external` symbol.** That's the backstop for whatever gets past the compiler.

All three apply to both sidecars. Linux and Windows have no equivalent: neither
toolchain turns a missing function into a null pointer at runtime.

The Windows build reuses the #12 spike's glue: MSYS2 UCRT64, `USB=src/usb_nix.o`
(libusb rather than upstream's WinUSB backend, which has open read-corruption
bugs), and `.github/minipro-windows/compat.h` for `stpcpy`.

## Building it locally

`pnpm tauri dev`, `pnpm tauri build` and `cargo build`/`test` all need the sidecar
for your host, because tauri-build won't compile `src-tauri` without the files
it bundles. Build it once, and again after bumping `vendor/minipro`:

```bash
git submodule update --init vendor/minipro vendor/minipro-t76
pnpm sidecar
```

That runs `scripts/minipro/build-sidecar.sh`, which writes
`src-tauri/binaries/burnwright-minipro-<target-triple>`,
`src-tauri/binaries/burnwright-minipro-t76-<target-triple>` and their
`minipro/` and `minipro-t76/` folders (all gitignored). It builds in
`target/minipro-sidecar/`, so the submodules stay clean. `--variant stable`
or `--variant t76` builds just one.

- **macOS:** Xcode command-line tools and `pkg-config` (`brew install pkgconf`).
  `--target x86_64-apple-darwin` cross-builds the Intel sidecar on Apple Silicon.
- **Linux:** `build-essential pkg-config zlib1g-dev`.
- **Windows:** run it in an MSYS2 UCRT64 shell with
  `pacman -S git make mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-pkgconf`,
  passing `--target x86_64-pc-windows-msvc` if `rustc` isn't on that shell's PATH.

## Licensing

minipro is GPL-3.0-or-later, so is burnwright, and libusb (LGPL-2.1-or-later) and
zlib are compatible. Each bundle's `minipro/` folder carries:

- `LICENSE.minipro.txt` (GPL-3.0), `COPYING.libusb.txt` (LGPL-2.1) and, on
  Windows, `LICENSE.zlib.txt`
- `NOTICE.txt`: minipro's tag and commit, the libusb and zlib versions, URLs
  and hashes, and the burnwright commit and scripts that built it

`minipro-t76/` carries the same set for the T76 build.

Every release also gets `minipro-sidecar-source_<version>.tar.gz` (the `sources`
job in `release-please.yml`): the minipro source at the pinned commit, the
libusb and zlib tarballs with their signatures, and the build scripts. That's
the corresponding source for both sidecars (both minipro commits), offered
from the same place as the installers.

## How CI checks it

`ci.yml` builds the sidecar in the checks job (so clippy and tests compile) and
in each bundle job; `release-please.yml` does the same before `tauri-action`.
The build script checks its own output every time: the runtime dependencies in
the table above and, on macOS, no weak imports.
After bundling, `scripts/minipro/verify-bundle.sh` (macOS and Linux) and
`verify-bundle.ps1` (Windows) check it from an installed layout:

- **macOS:** copy the `.app` out of the `.dmg`, `otool -L` the sidecar and fail on
  anything outside `/usr/lib` and `/System`.
- **Linux:** `dpkg-deb -I` / `-c`, then `apt install` the `.deb` and run
  `/usr/bin/burnwright-minipro`. Extract the AppImage and run the copy inside it.
  `ldd` must show no libusb and nothing unresolved. The `.deb` is also checked
  for its udev rules: the file is installed, matches
  `packaging/linux/udev/`, flags all three USB IDs and parses (`udevadm verify`
  where it exists, otherwise `udevadm test`'s log); the package ends up fully
  configured; the postinst and postrm exit 0 with no `udevadm` and with a failing
  one, and run the reload and both triggers with a working one; and
  `apt remove` / `purge` take the rules and the sidecar with them.
- **Windows:** silently install the NSIS installer per-user, then run the sidecar
  from the install folder with `PATH` cut down to System32.

Each run passes the bundled databases by path, from an empty working directory
with no `PATH`. It must print the version and database counts, list over a
thousand chips with `-q tl866ii -l`, and report `No programmer found` for `-k`.
On Windows, where minipro pipes every `-l` through a pager, the list also has
to come out the same through the pass-through pager the app sets in `PAGER`.

The checks job also runs the sidecar for real: `cargo test` lists, searches and
describes chips through the app's own commands (`src-tauri/src/commands.rs`).
Those runs pass `-q`, so minipro reads its databases and never looks for a
programmer.

The T76 build gets the same checks, and its `--version` must also count a T76
database.

CI has no programmer attached, so none of this proves a read or write, or that
the udev rules grant access to a real device. That
still needs a real T48 or TL866II+ on each OS, and a T76 for the T76 build.
