# burnwright

Open-source, cross-platform GUI for XGecu / MiniPRO universal programmers
(T48, T56, T76, TL866II+), built on the [minipro](https://gitlab.com/DavidGriffith/minipro) engine.
macOS · Linux · Windows. No closed-source vendor software required.

> Early scaffold — nothing to run yet.

## Releases

Each [GitHub release](https://github.com/IamMrCupp/burnwright/releases) carries
unsigned installers for macOS (`.dmg`, arm64 and x86_64), Linux (`.deb`,
`.AppImage`) and Windows (NSIS `-setup.exe`), plus a `SHA256SUMS` file. How
releases are built, and how to cut a test build without shipping it, is in
[docs/releasing.md](docs/releasing.md).

Each installer carries its own build of minipro (with libusb linked in) and its
chip databases, so there's nothing else to install. Building from source needs
that sidecar too: run `pnpm sidecar` once before `pnpm tauri dev`. See
[docs/minipro-sidecar.md](docs/minipro-sidecar.md).

## Finding minipro

burnwright drives the `minipro` CLI (0.7.x) rather than talking USB itself. It
looks for the binary in this order and uses the first one it finds:

1. The minipro path set in the app.
2. `BURNWRIGHT_MINIPRO`, either a full path or a program name to look up on
   `PATH`.
3. `minipro` on `PATH`.

If you set a path and nothing's there, burnwright stops with an error instead
of quietly running some other minipro. A bundled minipro is planned and will go
between steps 2 and 3.

## License
GPL-3.0-or-later (inherited from libminipro).
