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
}
for name, body in fixtures.items():
    with open(os.path.join(out, name), "wb") as f:
        f.write(body.encode())
