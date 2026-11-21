# Linux

On Linux a programmer shows up as a USB device node under `/dev/bus/usb/` that
only root can open. Without a udev rule, minipro (and so burnwright) reports
"No programmer found" or a permissions error for an ordinary user, even with
the programmer plugged in. The same goes for the CH341A the Laptop EC bench
drives through flashrom: flashrom says "Couldn't open device 1a86:5512." and
burnwright reports "No CH341A found". The `.deb` installs the rules for you. The
AppImage can't, so it's a one-time manual step.

## The udev rules

burnwright ships two rules files, one per tool that opens the device:

- [`60-burnwright-minipro.rules`](../packaging/linux/udev/60-burnwright-minipro.rules)
  for the XGecu programmers minipro drives.
- [`60-burnwright-flashrom.rules`](../packaging/linux/udev/60-burnwright-flashrom.rules)
  for the CH341A flashrom drives ([ec-backup.md](ec-backup.md)).

Between them they cover:

| Programmer | USB ID | Rules file |
|---|---|---|
| TL866A, TL866CS | `04d8:e11c` | `60-burnwright-minipro.rules` |
| TL866II+, T48, T56 | `a466:0a53` | `60-burnwright-minipro.rules` |
| T76 | `a466:1a86` (untested) | `60-burnwright-minipro.rules` |
| CH341A, SPI/I2C mode | `1a86:5512` (untested) | `60-burnwright-flashrom.rules` |

Both grant access two ways:

- **`uaccess`**: the user logged in at the machine's own seat gets an ACL on the
  device from systemd-logind. That's the modern default on systemd distros, and
  it's what a desktop user relies on. No group membership, no logout.
- **`plugdev`** (`MODE="0660"`, `GROUP="plugdev"`): members of `plugdev` get
  access from any session, such as SSH or a headless box with no seat. Ubuntu
  puts the first desktop user in `plugdev` already. Elsewhere it's
  `sudo usermod -aG plugdev "$USER"`, then log in again.

### The minipro file

It's based on upstream minipro's `udev/60-minipro.rules` and
`61-minipro-{uaccess,plugdev}.rules`, merged into one file. minipro 0.7.4's
rules don't list the T76, so burnwright adds it in its own file rather than
patching `vendor/minipro`. Nobody's tried it on a real T76 yet.

The file is named `60-burnwright-minipro.rules` so it can sit next to a distro
`minipro` package's `60-minipro.rules` without either overwriting the other.
It sets `ID_MINIPRO=1` the same way upstream does, so those rules see the T76 too.

### The flashrom file

`1a86:5512` is the CH341A in its SPI/I2C mode (WCH calls it "EPP/MEM"), which
is the one flashrom's `ch341a_spi` opens. The same chip in serial mode shows up
under another product ID. That one isn't listed: flashrom can't use it. Don't
confuse either with the T76 above, where `1a86` happens to be the product ID.

The CH341A has its own file because it isn't a minipro device. Putting it in
the minipro file would mean either tagging it `ID_MINIPRO=1`, which tells a
distro `minipro` package's rules it's an XGecu programmer, or carrying an
unrelated rule in a file named for another tool. A separate file also survives
the copy of `60-burnwright-minipro.rules` that burnwright's own "install the
udev rules" command writes to `/etc/udev/rules.d/`: a file there replaces the
packaged one of the same name, and that copy only lists XGecu programmers.

flashrom's own `util/flashrom_udev.rules` lists the same ID for `plugdev` only.
If your distro installs it, the two sit side by side and burnwright's adds
`uaccess`.

Nobody's tried this rule on a Linux machine with a real CH341A yet.

## What the `.deb` installs

| Path | What |
|---|---|
| `/usr/bin/burnwright` | the app |
| `/usr/bin/burnwright-minipro` | the bundled minipro ([minipro-sidecar.md](minipro-sidecar.md)) |
| `/usr/lib/burnwright/minipro/` | minipro's chip databases, licences and NOTICE |
| `/usr/lib/udev/rules.d/60-burnwright-minipro.rules` | the udev rules for XGecu programmers |
| `/usr/lib/udev/rules.d/60-burnwright-flashrom.rules` | the udev rules for the CH341A |
| `/usr/share/applications/`, `/usr/share/icons/` | the menu entry and icons |

The rules go in `/usr/lib/udev/rules.d/` because that's where package-owned
rules live. `/etc/udev/rules.d/` belongs to the admin, and a file there with the
same name overrides the packaged one.

The postinst reloads udev and re-triggers any XGecu, Microchip or WCH USB device
that's already plugged in, so the programmer works without a replug:

```bash
udevadm control --reload-rules
udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=a466
udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=04d8
udevadm trigger --action=change --subsystem-match=usb --attr-match=idVendor=1a86
```

Removing the package deletes the rules and reloads udev the same way. A
programmer that's plugged in at the time can keep its access until it's
replugged. Neither script fails when udev isn't running (containers, chroots):
the rules simply take effect on the next boot.

## AppImage: install the rules yourself

An AppImage can't install system files, so copy the rules into
`/etc/udev/rules.d/` once and reload udev. Take both files, or only the one for
the programmer you have:

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

Then unplug the programmer and plug it back in. Don't do this as well as
installing the `.deb`: one copy of the rules is enough.

To undo it, delete `/etc/udev/rules.d/60-burnwright-minipro.rules` and
`/etc/udev/rules.d/60-burnwright-flashrom.rules`, and run the reload command
again.

## Other package formats

- **`.rpm`: not shipped for now.** Releases build Linux on one Ubuntu 22.04
  runner, and CI installs and removes the `.deb` there on every PR. An `.rpm`
  would need the same treatment on a Fedora or openSUSE runner (its own
  dependency names, scriptlets and udev paths) to be worth shipping, and nobody
  has asked for it yet. The AppImage runs on rpm-based distros in the meantime.
  It's cheap to add back: Tauri's bundler already builds `.rpm`.
- **Flatpak and Snap: not planned.** Both sandbox USB. Flatpak needs broad
  device access (`--device=all`) and Snap's `raw-usb` interface isn't
  auto-connected, and neither can install the host udev rules the programmer
  still needs. That's the AppImage's manual step plus a sandbox to punch through.
