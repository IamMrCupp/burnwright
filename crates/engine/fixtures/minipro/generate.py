# Regenerate: python3 crates/engine/fixtures/minipro/generate.py crates/engine/fixtures/minipro
# Generates minipro stderr fixtures by replaying the exact format strings from
# vendor/minipro/src (main.c update_status/read_page_ram/write_page_ram/erase_device,
# minipro.c minipro_print_system_info). Run once; output is committed.
import sys, os
out = sys.argv[1]

def status(msg, tail):            # main.c update_status(): "\r\e[K" + msg + fmt
    return "\r\x1b[K" + msg + tail

def ram_pass(verb_progress, verb_done, name, blocks, secs):
    s = ""
    for i in range(blocks):
        s += status(f"{verb_progress} {name}...  ", "%2d%%" % (i * 100 // blocks))
    s += status(f"{verb_done} {name}...  %.2fSec  OK" % secs, "\n")
    return s

def read_pass(name, blocks, secs):   # read_page_ram: "Reading %s...  "
    return ram_pass("Reading", "Reading", name, blocks, secs)

def write_pass(name, blocks, secs):  # write_page_ram: "Writing  %s...  " (two spaces) / "Writing %s..."
    return ram_pass("Writing ", "Writing", name, blocks, secs)

T48 = ("Found T48 01.1.32 (0x120)\n"
       "Warning: T48 support is not yet complete!\n"
       "Device code: 46A16257\nSerial code: HSSCVO9LARFMOYKYOMVE5123\n"
       "USB speed: 480Mbps (USB 2.0)\n")
TL866 = ("Found TL866II+ 04.2.132 (0x284)\n"
         "Device code: 39C68E4A\nSerial code: 6Y8A1OY4LDT3B7C9O3DF7123\n"
         "USB speed: 12Mbps (USB 1.1)\n")
CHIP = "Chip ID: 0xEF4016  OK\n"

fixtures = {
    # minipro -p W25Q32BV@SOIC8 -r -
    "t48_read_code.stderr": T48 + CHIP + read_pass("Code", 16, 3.27),
    # minipro -p W25Q32BV@SOIC8 -w -   (erase, write, read-back verify)
    "tl866ii_write_verify.stderr": TL866 + CHIP
        + "Use -P if you want to write-protect this chip.\n"
        + "Erasing... 2.10Sec OK\n"
        + write_pass("Code", 8, 11.42)
        + read_pass("Code", 8, 6.03)
        + "Verification OK\n",
    # minipro -p W25Q32BV@SOIC8 -m firmware.bin  (read, then compare fails)
    "tl866ii_verify_mismatch.stderr": TL866 + CHIP
        + "Found Intel hex file.\n"
        + read_pass("Code", 4, 1.80)
        + "Verification failed at address 0x0010: File=0x3C, Device=0xFF\n",
    # minipro -p W25Q32BV@SOIC8 -b
    "t48_blank_check.stderr": T48 + CHIP + read_pass("Code", 4, 1.12)
        + "Code memory section is blank.\n",
    # minipro -p W25Q32BV@SOIC8 -E
    "t48_erase.stderr": T48 + CHIP + "Erasing... 0.93Sec OK\n",
    # read aborted by overcurrent (read_page_ram)
    "t48_read_overcurrent.stderr": T48 + CHIP
        + status("Reading Code...  ", "%2d%%" % 0) + status("Reading Code...  ", "%2d%%" % 12)
        + "\nOvercurrent protection!\x07\n",
    # wrong chip in the socket
    "tl866ii_invalid_chip_id.stderr": TL866
        + "Invalid Chip ID: expected 0xEF4016, got 0xC22016 (MX25L3206E)\n(use '-y' to continue anyway at your own risk)\n",
    # outdated firmware warning block (minipro_print_system_info)
    "tl866ii_firmware_outdated.stderr": "Found TL866II+ 04.2.131 (0x283)\n"
        + "Warning: Firmware is out of date.\n  Expected  04.2.132 (0x284)\n  Found     04.2.131 (0x283)\n"
        + "Device code: 39C68E4A\nSerial code: 6Y8A1OY4LDT3B7C9O3DF7123\nUSB speed: 12Mbps (USB 1.1)\n",
    # nothing plugged in (usb_nix.c)
    "no_programmer.stderr": "No programmer found.\n",
    # minipro -k  (print_connected_programmer_and_exit)
    "k_t48.stderr": "t48: T48\n",
    "k_none.stderr": "[No programmer found]\n",
    # minipro -V  (print_version_and_exit, print_chip_count)
    "version_t48.stderr": "Supported programmers: TL866A/CS, TL866II+, T48, T56\n" + T48
        + "minipro version 0.7.4     A free and open TL866 series programmer\n"
        + "Commit date:\t2025-06-14 10:21:43 +0200\nGit commit:\t3808aecb6a1dac9906a9691b93820ee1bd2b7a18\n"
        + "Git branch:\tmaster\nShare dir:\t/usr/local/share/minipro\n"
        + "TL866A/CS:\t 7185 devices, 0 custom\nTL866II+:\t15800 devices, 0 custom\n"
        + "T48:\t\t 6224 devices, 0 custom\nT56:\t\t 8216 devices, 0 custom\n"
        + "Logic:\t\t  283 devices, 0 custom\n",
    # minipro -V with no infoic.xml: system info, then a database error
    "version_t48_no_db.stderr": "Supported programmers: TL866A/CS, TL866II+, T48, T56\n" + T48
        + "minipro version 0.7.4     A free and open TL866 series programmer\n"
        + "Error opening file /usr/local/share/minipro/infoic.xml\n",
    # minipro -p W25Q32BV@SOIC8 -D
    "t48_read_id.stderr": T48 + CHIP,
    "tl866ii_id_mismatch.stderr": TL866
        + "Chip ID mismatch: expected 0xEF4016, got 0xC22016 (MX25L3206E)\n",
    "t48_no_chip_id.stderr": T48 + "This chip doesn't have a chip ID!\n",
    # minipro -p W25Q32BV@SOIC8 -D -z  (tl866iiplus.c minipro_pin_test)
    "tl866ii_pins_ok_read_id.stderr": TL866 + "Pin test passed.\n" + CHIP,
    "tl866ii_pins_bad.stderr": TL866 + "Bad contact on pin:3\nBad contact on pin:17\n",
    "t48_pins_unsupported_read_id.stderr": T48 + "Pin test is not supported.\n" + CHIP,
    # minipro -p W25Q32BV@SOIC8 -m -  (verify_page_file, match)
    "t48_verify_ok.stderr": T48 + CHIP + read_pass("Code", 4, 1.12) + "Verification OK\n",
    # minipro -p W25Q32BV@SOIC8 -b, chip not blank (verify_page_file)
    "t48_not_blank.stderr": T48 + CHIP + read_pass("Code", 4, 1.12)
        + "Verification failed at address 0x0000: File=0xFF, Device=0x3C\n",
    # minipro -p W25Q32BV@SOIC8 -w -, read-back after the write differs
    "tl866ii_write_verify_fail.stderr": TL866 + CHIP
        + "Use -P if you want to write-protect this chip.\n"
        + "Erasing... 2.10Sec OK\n"
        + write_pass("Code", 8, 11.42)
        + read_pass("Code", 8, 6.03)
        + "Verification failed at address 0x0042: File=0x12, Device=0xFF\n",
    # minipro -p W25Q32BV@SOIC8 -w -, image smaller than the chip (write_page_file)
    "tl866ii_size_mismatch.stderr": TL866 + CHIP
        + "Use -P if you want to write-protect this chip.\n"
        + "Incorrect file size: 1024 (needed 4194304, use -s/S to ignore)\n",
}
for name, body in fixtures.items():
    with open(os.path.join(out, name), "wb") as f:
        f.write(body.encode())
