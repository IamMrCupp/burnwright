// The themes folder under `pnpm dev` in a plain browser: three pretend
// files, so the Appearance choice can be looked at with no app around it.
// One is a full theme, one has entries that can't be used, and one isn't a
// theme at all. `main.tsx` only imports this in development.
import type { ThemeSource } from "../lib/theme";

const FILES: Record<string, string> = {
  "amber.json": JSON.stringify({
    name: "Amber terminal",
    base: "dark",
    colors: {
      bg: "#120d02",
      panel: "#1b1404",
      border: "#4a3810",
      fg: "#ffcf70",
      muted: "#b58a3a",
      "control-bg": "#241a05",
      "control-border": "#6b5116",
      "control-hover": "#33260a",
      accent: "#ffb000",
      "accent-soft": "#3d2c05",
      "hex-bg": "#150f02",
      "hex-header-bg": "#241a05",
      "hex-muted": "#8a6a2a",
      "hex-cursor": "#ffb000",
      "hex-cursor-fg": "#120d02",
      "hex-cursor-dim": "#5c4310",
      "hex-selected-bg": "#4a3810",
    },
  }),
  "paper.json": JSON.stringify({
    name: "Paper",
    base: "light",
    colours: {},
    colors: {
      bg: "#f4efe4",
      panel: "#fbf8f1",
      "hex-bg": "#fbf8f1",
      "hex-header-bg": "#efe8d8",
      accent: "#8a4b06",
      font: "Georgia",
      border: "url(https://example.com/paper.png)",
    },
  }),
  "broken.json": '{ "name": "Half a theme", ',
};

export const previewThemes: ThemeSource = {
  list: async () => ({
    folder: "/preview/config/themes",
    files: Object.entries(FILES).map(([file, text]) => ({ file, text })),
  }),
  openFolder: async () => {
    throw new Error("there's no folder to open in the browser preview");
  },
  // Kept until the page is reloaded.
  save: async (file, contents) => {
    if (file in FILES) throw new Error(`${file} is already in the themes folder`);
    FILES[file] = contents;
  },
};
