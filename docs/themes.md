# Themes

burnwright ships two looks — light and dark — and the Appearance choice at the
bottom of the side column picks between them or follows the system. If neither
is what you want, write your own. A theme is one small JSON file: a name, the
look it builds on, and the colours it changes.

## Where they go

One file per theme, in the `themes` folder of burnwright's config directory:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/com.mrcupp.burnwright/themes` |
| Linux | `~/.config/com.mrcupp.burnwright/themes` (under `$XDG_CONFIG_HOME` if you set it) |
| Windows | `%APPDATA%\com.mrcupp.burnwright\themes` |

You don't need to find it by hand. **Themes folder**, under the Appearance
choice, opens it — and creates it the first time. Drop a `.json` file in, press
**Reload themes**, and it shows up in the Appearance list under Themes. Edit the
file, reload again, and the change is on screen. No restart.

On a Mac the Appearance choice and these commands are also under **View →
Appearance** in the menu bar — handy once the footer has scrolled out of view.

## Start from what's on screen

The quickest way in: pick the look closest to what you want — Light, Dark, or a
theme you already have — and press **Save as theme**, next to Reload themes.
burnwright writes that look into the themes folder as `my-theme.json` (then
`my-theme-2.json`, and so on — it never overwrites a file), with all 34 colours
at the values they have right now. It shows up in the Appearance list as "My
theme" straight away.

Then it's yours: rename the file, change the `name`, change the colours you
care about, delete the lines you don't. Press Reload themes to see it.

## A starter

Or write one by hand.

Save this as `amber.json`:

```json
{
  "name": "Amber terminal",
  "base": "dark",
  "colors": {
    "bg": "#120d02",
    "panel": "#1b1404",
    "border": "#4a3810",
    "fg": "#ffcf70",
    "muted": "#b58a3a",
    "control-bg": "#241a05",
    "control-border": "#6b5116",
    "control-hover": "#33260a",
    "accent": "#ffb000",
    "accent-soft": "#3d2c05",
    "hex-bg": "#150f02",
    "hex-header-bg": "#241a05",
    "hex-muted": "#8a6a2a",
    "hex-cursor": "#ffb000",
    "hex-cursor-fg": "#120d02",
    "hex-cursor-dim": "#5c4310",
    "hex-selected-bg": "#4a3810"
  }
}
```

It leaves the warning, error and diff colours alone, so those stay the dark
look's. That's the point of `base`: you only write what you want different.

## The file

- **`name`** — what the Appearance list calls it. Optional; without it the
  theme is named after its file.
- **`base`** — `"light"` or `"dark"`. Required. Every colour you don't set comes
  from that look, and the window's title bar and the native controls
  (scrollbars, the select arrows) follow it too.
- **`colors`** — the colours you're changing, by the names in the table below.
  Leave it out and you've got the base look under a new name.

A value is a hex colour (`#rgb`, `#rrggbb`, with or without alpha) or an
`rgb()` / `hsl()` with plain numbers in it: `rgba(0, 0, 0, 0.45)`,
`hsl(40 100% 50%)`. That's the whole list. No colour names, no `var()`, no
gradients, no `url()`.

## The colours

| Name | What it colours |
|---|---|
| `bg` | The window behind the panels, the log, the "no programmer" command block |
| `panel` | Panels, the confirmation dialog, the cards in the Programmer panel |
| `border` | Panel and card edges, dividers, the hex grid's edge |
| `fg` | Text |
| `muted` | Quieter text: panel headings, hints, the footer, hex addresses |
| `control-bg` | Buttons, inputs and selects |
| `control-border` | Their edges |
| `control-hover` | A button under the pointer |
| `accent` | Links, focus rings, the progress bar, commands in the log, the picked chip's edge |
| `accent-soft` | The fill behind the picked chip and the active recent chip |
| `danger` | Error text and edges, the Erase and Write buttons |
| `danger-soft` | The fill behind an error |
| `warning` | Warning text, "unsaved", the notes under the Appearance choice |
| `warning-soft` | The fill behind a warning |
| `warning-border` | A warning's left edge |
| `ok` | A passed outcome's heading and edge |
| `ok-soft` | The fill behind it |
| `backdrop` | The dimming behind the confirmation dialog. Wants some transparency |
| `shadow` | The confirmation dialog's shadow. Same |
| `hex-bg` | The hex grid |
| `hex-header-bg` | Its column header |
| `hex-muted` | The header's text, and the grid's "nothing here" line |
| `hex-edited-fg` | A byte you've changed, and the "modified" marker |
| `hex-edited-bg` | The fill behind a changed byte |
| `hex-selected-bg` | Selected bytes |
| `hex-cursor` | The cursor, the grid's focus ring, the underline on the current difference |
| `hex-cursor-fg` | The byte under the cursor |
| `hex-cursor-dim` | The cursor while the grid doesn't have focus |
| `diff-changed-bg` | Verify: a byte that differs |
| `diff-changed-fg` | Its text |
| `diff-extra-bg` | Verify: a byte past the end of the other side, when the two are different lengths |
| `diff-extra-fg` | Its text |
| `diff-missing-bg` | Verify: a byte only the other side has, shown struck through |
| `diff-missing-fg` | Its text |

The names are the app's `--bw-*` CSS properties without the prefix. Writing
`"--bw-bg"` works too.

## When a file's wrong

burnwright tells you, under the Appearance choice, in the app:

- **A file it can't use at all** — not JSON, no `base`, too big (64 KiB is the
  limit), not text — isn't offered, and the note says which file and why.
- **An entry it can't use** — a name that isn't in the table, a value that isn't
  a colour, a top-level key that isn't `name`, `base` or `colors` — is skipped.
  The rest of the theme works, and the note lists what was skipped once you
  pick it.
- **A theme you'd picked that's since been deleted or broken** — Appearance goes
  back to System and says so.

## What a theme can't do

Colours only. A theme can't change fonts, sizes, spacing or layout, can't load
an image, and can't run anything. That's deliberate — a theme file from someone
else can make burnwright ugly, but it can't move the Write button or hide a
warning's text behind a picture. It can still make a warning hard to read by
giving it the same colour as its background, so look at one before you trust it
on a real write: `pnpm dev` with `?firmware=old` in the URL shows a warning with
no programmer attached.

burnwright doesn't download themes and has no gallery. Files in a folder —
share them however you like.
