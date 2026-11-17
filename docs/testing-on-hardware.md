# Testing on real hardware

burnwright's own tests run against a fake minipro. They prove the app sends the
right commands and handles what comes back. They can't prove a chip ends up
holding the right bytes. That takes a real programmer, a real chip, and
someone willing to compare two files.

If that's you: the read test below takes about five minutes and can't hurt the
chip. Then file a
[hardware test report](https://github.com/IamMrCupp/burnwright/issues/new?template=hardware-test.yml).
What's been tried so far is in [tested-hardware.md](tested-hardware.md).

## Ground rules

- **Never test on the only copy.** If the chip holds a BIOS, a firmware or a
  game you can't get again, read it with a tool you already trust and keep
  that file somewhere safe before burnwright touches it.
- **Read first. Write only to chips you can afford to lose.** A read changes
  nothing on the chip. A write that goes wrong can.
- **Use the socket if you can.** In-circuit reads through a clip fail for
  reasons that have nothing to do with the software: the board powers up, a
  pin is loaded, the clip slips. A clip report is still welcome, but say it
  was a clip.
- **One-time parts are one-time.** An OTP EPROM can be written once. A UV
  EPROM needs a UV eraser to go again. Don't spend one on a test unless you
  meant to.

## What you need

- A TL866A/CS, TL866II+, T48, T56 or T76.
- A chip. burnwright reads and writes main (code) memory only for now: no
  EEPROM data memory, no fuses. Plain memory parts make the cleanest test: a
  25-series SPI flash, a 24C I2C EEPROM, a 28C parallel EEPROM, a 39SF or 29F
  flash.
- A second tool you trust, to compare against: Xgpro, or the `minipro` command
  line.
- burnwright from the
  [latest release](https://github.com/IamMrCupp/burnwright/releases/latest).

If burnwright can't find the programmer, it says why and what to do about it.
If that advice is wrong or doesn't work, that's a report too: paste what it
said.

## The read test

1. Read the chip with the tool you trust and save the result as
   `reference.bin`. With the minipro command line that's:

   ```bash
   minipro -p "W25Q64JV@SOIC8" -r reference.bin
   ```

2. In burnwright, pick the same chip, press **Read**, then **Save as…** and
   save `burnwright.bin`.

3. Compare the two files. The hashes should be identical.

   macOS:

   ```bash
   shasum -a 256 reference.bin burnwright.bin
   ```

   Linux:

   ```bash
   sha256sum reference.bin burnwright.bin
   ```

   Windows, once per file:

   ```bash
   certutil -hashfile reference.bin SHA256
   ```

4. For a second opinion, **Open…** `reference.bin` in burnwright and press
   **Verify**. It should report no differences.

If the files are different sizes, the other tool saved more than main memory.
Xgpro is reported to do this by default for some SPI flash: it appends the
chip's OTP region to the saved file, so a 16 MB GD25LQ128D comes out as
16,780,288 bytes instead of 16,777,216. That's not a failed test. Hash only
as many bytes of the reference as `burnwright.bin` holds:

```bash
head -c 16777216 reference.bin | shasum -a 256
```

Say in the report that the sizes differed, with both sizes.

Comparing against Xgpro tests the whole stack, minipro included. Comparing
against the minipro command line tests only burnwright's part. Both are
useful. Xgpro is the stronger check.

## The write test

Spare chips only.

1. Keep the `reference.bin` you read above. It's how you put the chip back.

2. Make a file of random bytes the same size as the chip. A write of the image
   the chip already holds proves very little. For a 32 KB part:

   ```bash
   head -c 32768 /dev/urandom > random.bin
   ```

3. In burnwright: **Erase**, then **Blank check**. (Skip both for parts that
   don't erase electrically.)

4. **Open…** `random.bin`, press **Write**, then **Verify**.

5. Read the chip back with the tool you trust and compare that file's hash
   with `random.bin`'s. This is the step that counts: it's the only one
   burnwright isn't marking its own homework on.

6. Write `reference.bin` back the same way if you want the chip as it was.

## What to send

One
[hardware test report](https://github.com/IamMrCupp/burnwright/issues/new?template=hardware-test.yml)
per chip, per programmer. The form asks for:

- the programmer and its firmware, as burnwright shows them
- your OS, and the version line from the bottom of burnwright's window
- the chip, as named in burnwright's chip list
- what you tried and whether the hashes matched
- the log: press **Copy log** in the Log panel and paste it

Failures are as useful as passes. A pass adds a row to
[tested-hardware.md](tested-hardware.md). A failure gets fixed, and then adds
a row.
