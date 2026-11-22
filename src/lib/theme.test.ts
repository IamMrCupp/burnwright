import { describe, expect, it, vi } from "vitest";
import { isColor, parseTheme, readListing, type Theme } from "./theme";

function theme(file: string, value: unknown): Theme {
  const parsed = parseTheme(file, JSON.stringify(value));
  if (!parsed.ok) throw new Error(parsed.problem.reason);
  return parsed.theme;
}

function reason(text: string): string {
  const parsed = parseTheme("x.json", text);
  if (parsed.ok) throw new Error("expected a broken theme");
  return parsed.problem.reason;
}

describe("isColor", () => {
  it("takes hex and plain rgb() / hsl()", () => {
    for (const value of [
      "#fff",
      "#FFFA",
      "#1c1c1e",
      "#1c1c1e80",
      "rgb(0, 0, 0)",
      "rgba(0, 0, 0, 0.45)",
      "rgb(0 0 0 / 45%)",
      "hsl(210, 50%, 40%)",
      "hsla(210deg 50% 40% / 0.5)",
      "  #abcdef  ",
    ]) {
      expect(isColor(value), value).toBe(true);
    }
  });

  it("takes nothing that could do more than colour something", () => {
    for (const value of [
      "red",
      "transparent",
      "var(--bw-bg)",
      "url(https://example.com/a.png)",
      "rgb(0, 0, 0) url(x)",
      "#fff; background: url(x)",
      "rgb(calc(1 + 1), 0, 0)",
      "linear-gradient(#fff, #000)",
      "#ffff0",
      "#ggg",
      "rgb(1, 2)",
      "rgb()",
      "",
      `#${"f".repeat(80)}`,
      12,
      null,
      ["#fff"],
    ]) {
      expect(isColor(value), String(value)).toBe(false);
    }
  });
});

describe("parseTheme", () => {
  it("reads a name, a base and the colours it changes", () => {
    expect(
      theme("amber.json", {
        name: "Amber terminal",
        base: "dark",
        colors: { bg: "#1a1200", "hex-cursor": "rgb(255, 176, 0)" },
      }),
    ).toEqual({
      id: "amber.json",
      name: "Amber terminal",
      base: "dark",
      colors: { bg: "#1a1200", "hex-cursor": "rgb(255, 176, 0)" },
      ignored: [],
    });
  });

  it("takes the property's CSS name too", () => {
    expect(theme("a.json", { base: "light", colors: { "--bw-accent": "#0a0" } }).colors).toEqual({
      accent: "#0a0",
    });
  });

  it("is named after its file when it has no name", () => {
    expect(theme("amber.json", { base: "dark" }).name).toBe("amber");
    expect(theme("Amber.JSON", { base: "dark", name: "  " }).name).toBe("Amber");
    const numbered = theme("amber.json", { base: "dark", name: 7 });
    expect(numbered.name).toBe("amber");
    expect(numbered.ignored).toEqual([`"name" isn't text, so the file's name is used`]);
  });

  it("is usable with no colours at all", () => {
    expect(theme("plain.json", { base: "light" }).colors).toEqual({});
  });

  it("keeps what it can and says what it left out", () => {
    const parsed = theme("mixed.json", {
      name: "Mixed",
      base: "dark",
      author: "someone",
      colors: {
        bg: "#101418",
        font: "Comic Sans",
        panel: "url(https://example.com/x.png)",
        accent: 12,
      },
    });
    expect(parsed.colors).toEqual({ bg: "#101418" });
    expect(parsed.ignored).toEqual([
      `"author" isn't part of a theme`,
      `"font" isn't a colour burnwright has`,
      `"panel": "url(https://example.com/x.png)" isn't a colour a theme can use`,
      `"accent": 12 isn't a colour a theme can use`,
    ]);
  });

  it("says why a file isn't a theme", () => {
    expect(reason("{ nope")).toMatch(/^it isn't valid JSON \(/);
    expect(reason("[]")).toBe("a theme is a JSON object: { … }");
    expect(reason('"dark"')).toBe("a theme is a JSON object: { … }");
    expect(reason("{}")).toBe('"base" has to be "light" or "dark"');
    expect(reason('{"base":"sepia"}')).toBe('"base" has to be "light" or "dark"');
    expect(reason('{"base":"dark","colors":["#fff"]}')).toMatch(/^"colors" has to be an object/);
  });

  it("drops the label an engine puts in front of its JSON error", () => {
    const failing = (message: string) => {
      const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw new SyntaxError(message);
      });
      try {
        return reason("{");
      } finally {
        parse.mockRestore();
      }
    };
    // WebKit, which is what the app runs in on macOS and Linux.
    expect(failing("JSON Parse error: Property name must be a string literal")).toBe(
      "it isn't valid JSON (Property name must be a string literal)",
    );
    // Firefox.
    expect(failing("JSON.parse: expected property name or '}' at line 1 column 3")).toBe(
      "it isn't valid JSON (expected property name or '}' at line 1 column 3)",
    );
    // Chromium's has no label to drop.
    expect(failing("Expected property name or '}' in JSON at position 2")).toBe(
      "it isn't valid JSON (Expected property name or '}' in JSON at position 2)",
    );
  });

  it("doesn't let a long name or value through whole", () => {
    const long = theme("long.json", {
      base: "dark",
      name: "n".repeat(200),
      colors: { bg: "x".repeat(200) },
    });
    expect(long.name).toHaveLength(60);
    expect(long.ignored[0].length).toBeLessThan(90);
  });
});

describe("readListing", () => {
  it("sorts a folder into themes by name and files that can't be used", () => {
    const { themes, broken } = readListing({
      folder: "/config/themes",
      files: [
        { file: "zebra.json", text: '{"name":"Zebra","base":"light"}' },
        { file: "amber.json", text: '{"name":"Amber","base":"dark"}' },
        { file: "bad.json", text: "{" },
        { file: "locked.json", text: null, error: "permission denied" },
        { file: "odd.json" },
      ],
    });
    expect(themes.map((found) => found.name)).toEqual(["Amber", "Zebra"]);
    expect(broken).toEqual([
      { file: "bad.json", reason: expect.stringMatching(/^it isn't valid JSON/) },
      { file: "locked.json", reason: "permission denied" },
      { file: "odd.json", reason: "it couldn't be read" },
    ]);
  });
});
