# Inspect: what's inside a dump

You read a flash chip off a router, a camera or a board nobody has a schematic
for, and you're looking at four megabytes of hex. **Inspect** scans the buffer
for formats it knows — file systems, compressed data, boot images — and lists
where each one starts. Pick a row and the hex editor goes there.

It follows the **Programmer** bench. A Laptop EC backup goes straight to a file;
open that file on the Programmer bench to inspect it.

## Using it

Get something into the buffer — read a chip or **Open…** a file — then
**Inspect**, in the buffer's bar.

The **What's inside** panel lists what turned up:

| Column | |
|---|---|
| Offset | Where it starts, from the first byte of the buffer. |
| Size | How long it is, when the format says. `unknown` when it doesn't. |
| Type | The format's short name: `uimage`, `gzip`, `squashfs`. |
| Confidence | How sure the scanner is. Low means it matched on little more than the first bytes. |
| What it is | What the scanner read out of the header. |

Click a row, or tab to its offset and press Enter, and the hex editor's cursor
lands on that byte.

A long report is cut off at 500 rows, with a line saying how many there were.

## What the other states mean

- **"Nothing recognised"** — the scan ran and found no format it knows. That's
  the normal answer for a small EEPROM, a microcontroller's program or an erased
  chip. The scanner looks for containers; plain code and data don't show up.
- **"The buffer has been edited since this scan"** — the rows are of the bytes
  as they were. They stay up, with the warning, until you **Scan again**.
- **A red notice** — the scan itself failed. It is never how an empty result is
  reported. The buffer and the app are untouched; see below for why that's
  true.
- **"Scan cancelled"** — you stopped it.

Open another file or read another chip and the panel goes away: its report was
about other bytes.

## How it works

The scanner is [binwalk-ng](https://github.com/binwalk-ng/binwalk-ng), linked
into burnwright — there's nothing to install and nothing leaves the machine.

**A scan runs in a second copy of burnwright**, started for the scan and gone
when it's done. A dump read off a chip is whatever was on the chip, often cut
off or corrupt, and the scanner is a lot of parser code. If one of those
parsers falls over, it takes the copy with it — not the window, and not a
write that's running in it. That's the red notice.

Because a scan touches no chip, it runs beside a read or a write. One scan at a
time.

## What it doesn't do

- **It hasn't met a real dump yet.** Everything it's been run on was built for
  its tests: a uImage, a gzip stream, erased flash, cut-off and garbage input.
  If it says something odd about yours, that's worth
  [an issue](https://github.com/IamMrCupp/burnwright/issues).
- **No extraction.** It says a SquashFS starts at `0x180000`; it doesn't unpack
  it.
- **No entropy view and no strings list** yet. Both are on
  [#153](https://github.com/IamMrCupp/burnwright/issues/153).
- **It's a list of things worth looking at, not a verdict.** A format the
  scanner doesn't know isn't listed, and a low-confidence row can be a
  coincidence.

## In a browser (`pnpm dev`)

There's no scanner in a browser. The preview's Inspect is a stand-in that
finds three formats by their first bytes in a made-up image, so the panel can
be worked on. What it reports says nothing about the real scanner.
