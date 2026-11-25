# Third-party notices

burnwright is built on other people's work, and most of their licences ask for
one thing back: the copyright notice and the licence text go wherever the
binary goes. This is how that's done and how it stays true.

## What ships

Every installer carries two files in its resource folder:

| File | What |
|---|---|
| `LICENSE.txt` | burnwright's own licence, GPL-3.0-or-later |
| `THIRD-PARTY-NOTICES.txt` | every Rust crate and npm package compiled into the app, with its licence text |

| | Where |
|---|---|
| macOS `.app` | `Contents/Resources/` |
| Linux `.deb` | `/usr/lib/burnwright/` |
| AppImage | `usr/lib/burnwright/` |
| Windows (NSIS) | the install folder |

In the app, **Licences** at the end of the version line opens
`THIRD-PARTY-NOTICES.txt` in whatever your system reads a text file with.

The bundled minipro, libusb and zlib are separate programs with their own
licences, `NOTICE.txt` and source archive, in the `minipro/` folders beside
those files: [minipro-sidecar.md](minipro-sidecar.md#licensing).

`THIRD-PARTY-NOTICES.txt` is committed at the top of the repo, so it can be
read on GitHub and reviewed in a diff. It's generated, never edited by hand.

## What's in it

- **Rust crates** for all four targets at once (both macOS architectures,
  Linux, Windows). A crate that's only in the Windows build is still listed.
  Build scripts and test helpers aren't: they don't end up in the program.
- **npm packages** in the frontend bundle: `dependencies` in `package.json`,
  and theirs. Not `devDependencies`.
- **C libraries a crate carries.** `liblzma-sys` compiles xz's liblzma,
  `lzfse-sys` Apple's LZFSE and `zstd-sys` Zstandard. The crate's own licence
  only covers its Rust wrapper, so `about.toml` names the C library's licence
  file where the tool doesn't find it (xz and LZFSE).

It lists names, not versions. A version bump that adds and removes nothing
leaves the file alone; the exact versions of a release are in its
`Cargo.lock`.

## The accepted list

`about.toml` holds the licences burnwright accepts. **That list is the
decision.** A dependency under anything else fails the generator, and CI with
it, until someone has read the licence and either added it or dropped the
dependency. The npm packages are held to the same list.

Everything on it can go into a GPL-3.0-or-later program. MPL-2.0 is the one
with a string attached: those files stay MPL, and the notices say where their
source is (crates.io, at the version in the release's `Cargo.lock`).

## Regenerating

```bash
cargo install cargo-about --locked --version 0.9.3 --features cli   # once
pnpm install
just notices        # or: scripts/notices/generate.sh
```

Commit the result. `scripts/notices/generate.sh --check` is what CI runs; it's
in `just check` too.

## When CI stops you

- **"doesn't match the dependencies any more"** — a dependency came or went, or
  a licence file changed. Regenerate, read the diff, commit.
- **"failed to satisfy license requirements"** — a crate under a licence that
  isn't in `about.toml`. Read the licence. Then it goes on the list, or the
  crate goes.
- **A checksum that no longer matches** (`liblzma-sys`, `lzfse-sys`) — the C
  library's licence file changed in a new version. Read the new one, then put
  its `shasum -a 256` in `about.toml`.
- **"ships no licence file"** (npm) — that package's notice has to be written
  by hand; the script won't guess.

The bundle checks (`verify-bundle.sh`, `verify-bundle.ps1`) then fail any
installer whose copy of either file isn't the one in the checkout.

## What it doesn't do

- **Crates that ship no licence file get the standard text**, without a
  copyright line of their own. The crate's name and repository are listed, and
  that's all there is to print.
- **It isn't legal advice.** It's a careful list, generated from what each
  package says about itself.
