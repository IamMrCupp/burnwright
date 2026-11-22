// Holds the stylesheets to the rule App.css states: every colour is a
// --bw-* property defined there, once per look.
import { describe, expect, it } from "vitest";
import { THEME_PROPERTIES, isColor } from "./lib/theme";

const sheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const docs = import.meta.glob<string>("../docs/themes.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(/;

/** The --bw-* properties a rule with this selector defines. */
function tokens(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  expect(start, `App.css has a ${selector} rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return [...body.matchAll(/(--bw-[a-z-]+):/g)].map((match) => match[1]).sort();
}

describe("the stylesheets", () => {
  const app = sheets["./App.css"];

  it("are found", () => {
    expect(app).toBeTruthy();
    expect(Object.keys(sheets).length).toBeGreaterThan(5);
  });

  it("give the dark look a value for every property the light look has", () => {
    const light = tokens(app, "\n:root");
    expect(light.length).toBeGreaterThan(30);
    expect(tokens(app, ':root[data-theme="dark"]')).toEqual(light);
  });

  it("define every property that's used", () => {
    const defined = new Set(tokens(app, "\n:root"));
    for (const [path, css] of Object.entries(sheets)) {
      for (const [, name] of css.matchAll(/var\((--bw-[a-z-]+)/g)) {
        expect(defined.has(name), `${name}, used in ${path}`).toBe(true);
      }
    }
  });

  it("keep colours out of the component stylesheets", () => {
    for (const [path, css] of Object.entries(sheets)) {
      if (path === "./App.css") continue;
      const lines = css.split("\n").filter((line) => COLOUR.test(line));
      expect(lines, `colours in ${path}`).toEqual([]);
      expect(css, `${path} switches on the system's setting itself`).not.toMatch(
        /prefers-color-scheme/,
      );
    }
  });

  it("leave following the system to the script", () => {
    expect(app).not.toMatch(/prefers-color-scheme/);
  });

  it("define exactly the properties a theme file can set", () => {
    expect(THEME_PROPERTIES.map((property) => `--bw-${property}`).sort()).toEqual(
      tokens(app, "\n:root"),
    );
  });

  it("have every one of them in the table in docs/themes.md", () => {
    const page = docs["../docs/themes.md"];
    expect(page).toBeTruthy();
    const listed = [...page.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(listed).toEqual([...THEME_PROPERTIES]);
  });

  it("give every property a value a theme file can hold, so a saved look loads back whole", () => {
    for (const selector of ["\n:root", ':root[data-theme="dark"]']) {
      const start = app.indexOf(`${selector} {`);
      const body = app.slice(start, app.indexOf("}", start));
      const declared = [...body.matchAll(/(--bw-[a-z-]+):\s*([^;]+);/g)];
      expect(declared.length).toBe(THEME_PROPERTIES.length);
      for (const [, name, value] of declared) {
        expect(isColor(value), `${name}: ${value} under ${selector.trim()}`).toBe(true);
      }
    }
  });
});
