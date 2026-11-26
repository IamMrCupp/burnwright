# Inspect: what's inside a dump

You read a flash chip off a router, a camera or a board nobody has a schematic
for, and you're looking at four megabytes of hex. **Inspect** scans the buffer
for formats it knows — file systems, compressed data, boot images — and lists
where each one starts. Pick a row and the hex editor goes there. Above the
list, a strip shows how random each stretch of the buffer looks, and under it
is the text in the dump. Those two still say something when no format is
recognised.

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

## The entropy strip

Across the top of the panel, the whole buffer from first byte to last. The
height at each point is that stretch's entropy, from 0 to 8 bits a byte:

| It looks like | It probably is |
|---|---|
| Nothing drawn | One byte value repeated. Erased flash (`FF`), or padding. |
| Somewhere in between | Text, tables, machine code. |
| At or near the top | Compressed or encrypted data. |

So an unpacked bootloader, a compressed kernel and the empty space after it
show up as three different heights before you've read a byte. **The edges are
the useful part**: where the height changes is usually where one thing ends
and the next starts.

- **Point at it** and the line under it gives that block's offset and entropy.
- **Click** and the hex editor's cursor goes to the start of that block.
- **From the keyboard:** tab to the strip, step with the arrow keys (Page Up
  and Page Down take bigger steps, Home and End go to the ends), and Enter
  goes to the block.

The line under it also says how much of the buffer is flat — in blocks that
are one value repeated.

The buffer is cut into at most 1,024 blocks, each a power of two and at least
256 bytes: 256-byte blocks up to 256 KiB, 4 KiB blocks for a 4 MiB chip. Two
things follow from that:

- **A small block can't reach the top.** 256 bytes of pure noise measure about
  7.2 bits, not 8 — there aren't enough bytes in the block for every value to
  turn up evenly. At 4 KiB the same noise reads 7.95. On a small chip, "near
  the top" is the test, not "at the top".
- **A block is one number.** A 100-byte string inside 4 KiB of noise doesn't
  show.

It's the same kind of evidence as a low-confidence row: high entropy says
"packed", not which of compressed and encrypted, and plenty of ordinary data
sits in the middle.

## Strings

Under the formats, the text in the buffer: every run of four or more
printable characters, with where it starts and how long it is. It's what
`strings` prints. A U-Boot banner, the kernel's boot arguments, a URL or a
config key says more about a dump than its first screen of hex does.

- **Click a row**, or tab to its offset and press Enter, and the hex editor's
  cursor lands on the string's first byte.
- **Filter** narrows the list to the strings with that text in them, whatever
  its case. It's plain text, not a pattern, and it looks through every string
  in the list, not only the ones drawn.
- **`UTF-16`** marks a string stored two bytes a character, the way Windows
  and UEFI firmware write them. Both kinds are in the one list, in offset
  order.

A few things it does to stay readable:

- **500 rows are drawn at a time.** The line under the list says how many
  there are; the filter is how you get at the rest.
- **A string is shown up to 120 characters**, with `…` after it when it's
  longer. The Length column is the real length.
- **The list holds 20,000 strings.** Compressed data throws up short runs of
  printable bytes by chance — a 64 MiB dump of noise has over 800,000 — so
  when there are more than fit, the shortest are left out first and the panel
  says what the new minimum is. A real string is long more often than a run
  of chance is. Past 16 characters it stops raising the bar and cuts the list
  off instead, and says that too.

What it doesn't find:

- **Anything that isn't ASCII.** Accented, Cyrillic or CJK text, in any
  encoding, isn't listed. A line break ends a string; a tab doesn't.
- **Text inside something compressed.** The strings in a SquashFS are in the
  SquashFS. This reads the bytes as they sit on the chip.

**Strings are whatever was on the chip**, and that includes Wi-Fi keys, admin
passwords and serial numbers. Nothing leaves the machine, but the list puts
all of them on one screen. With **Stream page** → **Hide file paths in this
window** on, the panel says how many strings there are and draws none of
them. The hex view isn't covered: it shows the bytes it's on, as it always
has.

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
- **The strip doesn't mark where the findings are.** The list and the strip
  are two views of the same bytes; lining them up is by offset.
- **It's a list of things worth looking at, not a verdict.** A format the
  scanner doesn't know isn't listed, and a low-confidence row can be a
  coincidence.

## In a browser (`pnpm dev`)

There's no scanner in a browser. The preview's Inspect is a stand-in that
finds three formats by their first bytes in a made-up image, so the panel can
be worked on. What it lists says nothing about the real scanner.

The entropy strip and the strings list are the exceptions: the preview does
the same sum and the same search the scanner does, so what it draws there is
what the app would draw for those bytes.
