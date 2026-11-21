# flashrom fixtures

What flashrom prints, for the parser tests and the fake flashrom in
`tests/flashrom_backend.rs`. `.stdout` and `.stderr` are the two streams of
one run.

None of these came off a KB9012. They're flashrom 1.8.0 (Homebrew, macOS
arm64) run without one, with the chip-specific lines written from the format
strings in its source. Replace them with real captures once a donor board is
on the bench.

| Fixture | Where it's from |
|---|---|
| `version.stdout` | `flashrom --version`, as captured. |
| `version_1_3.stdout` | The same banner with 1.3.0's version. 1.3 has no `--progress`. |
| `no_ch341a.*` | `flashrom -p ch341a_spi -c "KB9012 (EDI)" -V` with no CH341A plugged in, as captured. |
| `unknown_chip.*` | `flashrom -p ch341a_spi -c NOPE`, as captured, with the chip name swapped in. |
| `ch341a_no_flash.stdout` | The banner plus the two "nothing found" lines, as captured from the `dummy` programmer. |
| `kb9012_read_progress.stdout` | `flashrom -p dummy:emulate=SST25VF040.REMS -c SST25VF040 -r f --progress`, as captured, bytes and all: the `[READ: n%]` redraws and their `\b \b` rub-outs are real. The `Found` line is rewritten for the KB9012 and the "UNTESTED" notice for the SST part is cut. |
| `kb9012_read.stdout` | The same read without `--progress`. |
| `kb9012_read_timeout.*` | The progress read cut off at 37%, with `edi_chip_read()`'s timeout and `flashrom_image_read()`'s `Read operation failed!` on stderr. |
| `kb9012_identify.stdout` | The `-V` header as captured, then the probe lines from `edi_chip_probe()` (`edi.c`) and `main()` (`cli_classic.c`). `0xc3` / `0x04` are `ENE_KB9012_HWVERSION` and `ENE_KB9012_EDIID` in `include/edi.h`. |
| `kb9012_no_answer.stdout` | The same, with the probe line the `dummy` programmer really gave: `reading hwversion failed`. |
| `kb9012_silent_bus.stdout` | The same, with a bus that reads all ones. |
| `kb9012_other_chip.stdout` | The same, with an EC that answers with another hardware version. |

Don't edit these by hand in an editor that strips trailing whitespace or
control characters.
