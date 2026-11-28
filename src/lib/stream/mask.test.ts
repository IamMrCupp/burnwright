import { describe, expect, it } from "vitest";
import { HIDDEN, maskPaths, PathMasker } from "./mask";

describe("maskPaths", () => {
  it("hides a path and keeps its extension", () => {
    expect(maskPaths("Opened /home/me/customers/jane-doe/bios.bin: 16 bytes.")).toBe(
      "Opened [hidden].bin: 16 bytes.",
    );
    expect(maskPaths("Saved 16 bytes to /home/me/dump.hex.")).toBe(
      "Saved 16 bytes to [hidden].hex.",
    );
    expect(maskPaths("~/dumps/x.bin")).toBe("[hidden].bin");
    expect(maskPaths("/home/me/dumps/")).toBe(HIDDEN);
    expect(maskPaths("/usr/local/bin/flashrom")).toBe(HIDDEN);
  });

  it("hides every path in a command line", () => {
    expect(
      maskPaths(
        "minipro -p W25Q32BV@SOIC8 --algorithms=/home/me/xgecu/algorithm.xml -w /tmp/bw-1/image.bin",
      ),
    ).toBe("minipro -p W25Q32BV@SOIC8 --algorithms=[hidden].xml -w [hidden].bin");
    expect(
      maskPaths("/opt/homebrew/bin/flashrom -p ch341a_spi -c 'KB9012 (EDI)' -r /tmp/read.bin"),
    ).toBe("[hidden] -p ch341a_spi -c 'KB9012 (EDI)' -r [hidden].bin");
  });

  it("hides Windows paths", () => {
    expect(maskPaths("Opened C:\\Users\\me\\Jane Doe\\bios.bin")).toBe(
      "Opened [hidden] Doe\\bios.bin",
    );
    expect(maskPaths("Opened C:\\Users\\me\\dumps\\bios.bin: 4 bytes")).toBe(
      "Opened [hidden].bin: 4 bytes",
    );
    expect(maskPaths("\\\\nas\\dumps\\bios.bin")).toBe("[hidden].bin");
  });

  it("leaves the punctuation after a path where it was", () => {
    expect(maskPaths("(remembered from /home/me/a.xml): no such file")).toBe(
      "(remembered from [hidden].xml): no such file",
    );
    expect(maskPaths('"/home/me/a.bin" is empty')).toBe('"[hidden].bin" is empty');
  });

  it("leaves what isn't a path alone", () => {
    for (const text of [
      "PIC18F67K22-I/PT@TQFP64",
      "AT28C256 and/or AT28C64",
      "TL866II+/T48 and T56",
      "Reading Code... done in 0.5 s",
      "Chip ID: 0xEF4016  OK",
      "See https://github.com/IamMrCupp/burnwright/issues/36",
      "4 MiB (4,194,304 bytes)",
      "3.3 V / 5 V",
      "read / write",
      "XGecu's algorithm.xml, a file from the Xgpro package",
      "W25Q32BV@SOIC8: 50%",
      "9f2c7d0e5a1b4c6d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d",
    ]) {
      expect(maskPaths(text), text).toBe(text);
    }
  });

  it("hides a known path whole, spaces and all", () => {
    const path = "/Users/me/Jane Doe MacBook/bios dump.bin";
    // On its own, nothing marks where a path with a space in it ends.
    expect(maskPaths(`Opened ${path}: 16 bytes.`)).toContain("Doe");
    expect(maskPaths(`Opened ${path}: 16 bytes.`, [path])).toBe("Opened [hidden].bin: 16 bytes.");
  });

  it("hides a path inside a known folder as one path, not the folder and then the rest", () => {
    const folder = "/Users/me/Library/Application Support/burnwright";
    expect(
      maskPaths(
        `${folder}/minipro/bin/minipro -p X --infoic ${folder}/minipro/share/infoic.xml -r ${folder}/a.bin`,
        [folder],
      ),
    ).toBe("[hidden] -p X --infoic [hidden].xml -r [hidden].bin");
  });

  it("keeps the punctuation after a known path, and runs on past one that ends mid-name", () => {
    const folder = "/Users/me/Jane Doe MacBook";
    expect(maskPaths(`Saved to ${folder}/other.bin.`, [folder])).toBe("Saved to [hidden].bin.");
    expect(maskPaths(`(in ${folder})`, [folder])).toBe("(in [hidden])");
    const file = "/Users/me/dumps/bios.bin";
    expect(maskPaths(`Kept ${file}.bak, then ${file}: done`, [file])).toBe(
      "Kept [hidden].bak, then [hidden].bin: done",
    );
  });
});

describe("PathMasker", () => {
  const SECRET = "/Users/me/Jane Doe MacBook/bios dump.bin";

  function state() {
    return {
      chip: { query: "/typed", selected: { name: "PIC18F67K22-I/PT" } },
      buffer: {
        bytes: Uint8Array.of(1, 2, 3),
        path: SECRET,
        source: { kind: "file", path: SECRET },
      },
      fileError: null as string | null,
      log: [
        { id: 1, kind: "note", text: `Opened ${SECRET}: 3 bytes.` },
        { id: 2, kind: "command", text: "minipro -p X -w /tmp/bw/image.bin" },
        { id: 3, kind: "output", text: "Writing Code..." },
      ],
      nextLogId: 4,
    };
  }

  it("hides the path in every string, wherever it is", () => {
    const masked = new PathMasker().mask(state());
    expect(JSON.stringify(masked)).not.toContain("Jane");
    expect(JSON.stringify(masked)).not.toContain("/Users");
    expect(JSON.stringify(masked)).not.toContain("/tmp");
    expect(masked.buffer.path).toBe("[hidden].bin");
    expect(masked.buffer.source.path).toBe("[hidden].bin");
    expect(masked.log.map((line) => line.text)).toEqual([
      "Opened [hidden].bin: 3 bytes.",
      "minipro -p X -w [hidden].bin",
      "Writing Code...",
    ]);
  });

  it("leaves the real state as it was", () => {
    const real = state();
    const before = JSON.stringify(real);
    new PathMasker().mask(real);
    expect(JSON.stringify(real)).toBe(before);
  });

  it("keeps the identity of what it didn't change", () => {
    const real = state();
    const masked = new PathMasker().mask(real);
    // The hex editor is handed these bytes: a copy would reset it.
    expect(masked.buffer.bytes).toBe(real.buffer.bytes);
    expect(masked.log[2]).toBe(real.log[2]);
    expect(masked.chip.selected).toBe(real.chip.selected);
    const clean = { log: [{ id: 1, text: "Reading Code..." }], n: 1 };
    expect(new PathMasker().mask(clean)).toBe(clean);
  });

  it("gives the same copy for the same object, so a redraw is cheap", () => {
    const masker = new PathMasker();
    const real = state();
    const first = masker.mask(real);
    const next = { ...real, nextLogId: 5 };
    const second = masker.mask(next);
    expect(second.log).toBe(first.log);
    expect(second.buffer).toBe(first.buffer);
  });

  it("leaves the keys it's told to skip", () => {
    const real = state();
    const masked = new PathMasker().mask(real, ["chip"]);
    // What's being typed into the search box is written back as typed.
    expect(masked.chip).toBe(real.chip);
    expect(masked.chip.query).toBe("/typed");
    expect(masked.buffer.path).toBe("[hidden].bin");
  });

  it("still hides an earlier file's path after the buffer has moved on", () => {
    const masker = new PathMasker();
    const first = state();
    masker.mask(first);
    const later = {
      ...first,
      buffer: { ...first.buffer, path: "/Users/me/other.bin", source: { kind: "file", path: "/Users/me/other.bin" } },
      log: [...first.log, { id: 4, kind: "note", text: "Opened /Users/me/other.bin: 3 bytes." }],
    };
    const masked = masker.mask(later);
    expect(JSON.stringify(masked)).not.toContain("Jane");
    expect(JSON.stringify(masked)).not.toContain("Doe");
  });

  it("goes back over old lines when it learns a path they hold", () => {
    const masker = new PathMasker();
    const line = { id: 1, kind: "note", text: `Opening ${SECRET}` };
    // The line arrives before anything holds the path.
    expect(masker.mask({ log: [line], path: null as string | null }).log[0].text).toContain("Doe");
    const masked = masker.mask({ log: [line], path: SECRET });
    expect(masked.log[0].text).toBe("Opening [hidden].bin");
  });

  it("hides a path it was told about before the state held it, and its folder", () => {
    const masker = new PathMasker();
    masker.remember(SECRET);
    const failed = {
      fileError: `Couldn't open bios dump.bin: no such file: ${SECRET}`,
      log: [{ id: 1, text: "Looked in /Users/me/Jane Doe MacBook for it" }],
    };
    const masked = masker.mask(failed);
    expect(masked.fileError).toBe("Couldn't open bios dump.bin: no such file: [hidden].bin");
    expect(masked.log[0].text).toBe("Looked in [hidden] for it");
    // Another file in that folder is one path, not the folder and the rest.
    expect(masker.mask("Opened /Users/me/Jane Doe MacBook/old.bin: 4 bytes")).toBe(
      "Opened [hidden].bin: 4 bytes",
    );
    // Nothing to remember in these.
    masker.remember(null);
    masker.remember("image.bin");
    expect(masker.mask("image.bin")).toBe("image.bin");
  });

  it("doesn't take a command line that starts with a path for one long path", () => {
    const masker = new PathMasker();
    const state = {
      flashrom: { path: "/opt/homebrew/sbin/flashrom" },
      log: [{ id: 1, kind: "command", text: "/opt/homebrew/sbin/flashrom -p ch341a_spi -r /tmp/r.bin" }],
    };
    expect(masker.mask(state).log[0].text).toBe("[hidden] -p ch341a_spi -r [hidden].bin");
  });

  it("learns whole paths from the fields that hold one", () => {
    const masker = new PathMasker();
    const spaced = "/Users/me/Library/Application Support/burnwright/backups/kb9012 1.bin";
    const masked = masker.mask({
      backup: { path: spaced, sha256: "ab12" },
      algorithms: { configured: "/Users/me/My Files/algorithm.xml", found: null, default_path: "/usr/share/a b/algorithm.xml" },
      flashromChosen: "/Users/me/my tools/flashrom",
      log: [
        { id: 1, text: `Backup saved to ${spaced}` },
        { id: 2, text: "using /Users/me/My Files/algorithm.xml, not /usr/share/a b/algorithm.xml" },
        { id: 3, text: "/Users/me/my tools/flashrom --version" },
      ],
    });
    expect(masked.log.map((line) => line.text)).toEqual([
      "Backup saved to [hidden].bin",
      "using [hidden].xml, not [hidden].xml",
      "[hidden] --version",
    ]);
    expect(masked.backup).toEqual({ path: "[hidden].bin", sha256: "ab12" });
  });

  it("takes anything", () => {
    const masker = new PathMasker();
    expect(masker.mask(null)).toBeNull();
    expect(masker.mask(7)).toBe(7);
    expect(masker.mask("/home/me/a.bin")).toBe("[hidden].bin");
    expect(masker.mask(["/home/me/a.bin", 1])).toEqual(["[hidden].bin", 1]);
    const map = new Map([["a", "/home/me/a.bin"]]);
    expect(masker.mask({ map }).map).toBe(map);
  });
});
