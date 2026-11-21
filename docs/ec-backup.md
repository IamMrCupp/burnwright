# Backing up a laptop EC

The **Laptop EC** bench reads a laptop's embedded controller without taking
the chip off the board, and saves what it read. Today that's one chip — the
ENE KB9012 — over its EDI debug port, with a CH341A as the programmer and
flashrom doing the talking.

It reads. It doesn't write. There's no button for it and no code path behind
one: a wrong write to an EC is a laptop that won't start, and writing waits
until a backup is mandatory and proven.

> **Nobody's run this on a real KB9012 yet.** It's tested against a stand-in
> flashrom replaying what flashrom 1.8.0 prints. A read can't hurt the chip,
> but the wiring can — read the checklist.

## What you need

- **flashrom**, 1.2 or newer. burnwright doesn't ship one. `brew install flashrom`
  on macOS, or your distro's `flashrom` package. With 1.4 or newer you also
  get a percentage while it reads.
- **A CH341A** in SPI mode, with its data lines at 3.3 V. See below — the
  common one isn't.
- **A way onto the EC's debug pins.** Usually the keyboard connector.

macOS and Linux. flashrom on Windows is its own problem and isn't covered.

## The wiring, and why each line is on the checklist

burnwright can't check any of this, so the bench makes you tick each one
before it'll talk to the chip.

- **The laptop is shut down, with its battery or adapter still connected.**
  The EC runs from standby power and has to stay powered to answer. flashrom
  holds the EC's CPU in reset while it works, so the laptop can't be running.
- **The CH341A's data lines are at 3.3 V, not 5 V.** The common black CH341A
  board feeds 3.3 V to its socket but runs the CH341A itself from 5 V, so its
  data lines sit at close to 5 V whatever the jumper says. That can kill the
  EC. flashrom's own
  [CH341A notes](https://github.com/flashrom/flashrom/blob/v1.8.0/doc/supported_hw/supported_prog/ch341ab.rst)
  have the fix. Measure a data pin, not the supply pin.
- **Ground first.** CH341A GND to a ground point on the board, before any
  signal wire.
- **CS, CLK, MOSI and MISO on the KB9012's debug pins**: 59 (CS), 60 (CLK),
  61 (data in, from MOSI) and 62 (data out, to MISO). They usually come out on
  the keyboard connector. Which pads they are is different on every board, so
  check the schematic.
- **The CH341A's 3.3 V and 5 V pins stay off.** The board powers the EC.

## The steps

1. **Look for it** finds the CH341A. It asks flashrom for a plain SPI flash,
   so it doesn't disturb an EC that's already wired up.
2. **Identify** asks the chip what it is. A KB9012 answers with hardware
   version `0xc3` and EDI ID `0x04`.
3. **Back up** reads the whole flash twice and compares the two reads. If
   they match, the image is saved. If they don't, nothing is: a read that
   wanders means a loose wire or an EC that's still running, and a bad backup
   is worse than none.

The EC is stopped during Identify and Back up, and let go again when each
finishes. **Cancel** stops a read; burnwright then runs flashrom once more so
the EC gets let go properly. If that fails the log says so, and the fix is to
take the board off all power for a few seconds.

## Where the backup goes

In burnwright's own data folder, under `backups/`:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/com.mrcupp.burnwright/backups/` |
| Linux | `~/.local/share/com.mrcupp.burnwright/backups/` |

**Show in folder** opens it. Each backup is two files:

- `ene-KB9012__EDI_-<UTC time>-<first 8 of the hash>.bin` — the image, 128 KiB.
- The same name with `.sha256` — its SHA-256, in `sha256sum` format.

Copy them somewhere that isn't this laptop.

## When it doesn't work

- **"No CH341A found."** flashrom couldn't open USB device `1a86:5512`. It
  says the same thing for a programmer that isn't plugged in and one you're
  not allowed to open. On Linux the second needs a udev rule. The `.deb`
  installs one; with the AppImage you copy it in yourself
  ([linux.md](linux.md)). After installing it, replug the CH341A.
- **"Nothing answered."** Try Identify again first — people report a KB9012
  that only answers every second time. Then check the wiring and that the
  board has standby power. Some EC firmware turns the debug port off;
  grounding pin 42 of the KB9012 holds its CPU in reset and brings it back.
- **"The two reads don't match."** Nothing was saved. Reseat the wires, make
  sure the laptop is off, and go again.
- **flashrom isn't found.** A GUI app doesn't get your shell's `PATH`, so
  burnwright also looks where Homebrew and the distros put flashrom. If yours
  is somewhere else, **Choose flashrom…** points at it, or set
  `BURNWRIGHT_FLASHROM`.

## What it can't do yet

- Write, erase or verify against a file.
- Any EC other than the KB9012: no KB9022, no ITE, no Nuvoton.
- Any programmer other than the CH341A.
- Tell you which pads on *your* keyboard connector are which.

The plan is in [issue #36](https://github.com/IamMrCupp/burnwright/issues/36).
