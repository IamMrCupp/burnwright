# The stream page

Putting a programming session on a live stream used to mean capturing the
app's window — and with it the file paths in the buffer panel, minipro's
command lines in the log and the hex view. The stream page is the other way:
burnwright serves a small web page of its own, and OBS loads it as a Browser
source. It shows the programmer, the chip and a progress bar. Nothing else.

It follows the **Programmer** bench. The Laptop EC bench isn't on it yet.

## Turning it on

**Stream page** in the top-right corner of the window → **Serve a page for
OBS**. It's off until you turn it on, and with it off nothing is listening.

The panel shows the page's address, `http://127.0.0.1:8790/stream` unless you
change the port, with a **Copy** button. The setting is remembered between
runs, and a change applies at once — no relaunch.

In OBS: **+** → **Browser** → paste the address. About 440 × 140 fits the
card. The page's background is transparent, so there's no chroma key to set
up — it layers straight over a camera.

## What it shows

- **The programmer's model** — "T48" — or "No programmer".
- **The chip** that's selected.
- **The operation in progress** — Read, Verify, Blank check, Erase, Write or
  Check chip — with a progress bar and a percent. When a verify fails and
  burnwright reads the chip back to show the differences, that shows as a
  Read.
- **How the last operation ended**: OK, warning or error, by name and colour.

The card is in burnwright's dark look whatever **Appearance** is set to — it
sits over video. A theme file doesn't change it.

## What stays off it

**File paths, the log and the buffer never go to the page.** It's sent a fixed
list of fields — the programmer's model, the chip's name, the operation, its
percent and how it ended — rather than the app's state with the private parts
taken out. A field added to the app later stays off stream until someone
decides otherwise. The two names are cut to one short line; everything else
is one of a few fixed words or a number.

So the page says *that* a write failed, not why. The why is in the app, where
only you can see it.

## When burnwright isn't running

The page keeps trying to reconnect, and picks the feed back up on its own
when burnwright starts. In between it shows nothing at all: a progress bar
frozen at 40% on stream would pass for a live one.

## Who can connect

The server listens on `127.0.0.1` only, so nothing else on the network can
reach it. It also refuses any request whose `Host` isn't `127.0.0.1` or
`localhost`, which keeps out a web page in a local browser trying to reach
the port under a name of its own (DNS rebinding). It answers `GET` and
nothing else: the page can't change anything in the app.

OBS on the same machine is the audience. OBS on a second streaming PC isn't
supported.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The panel says *Port 8790 is in use by something else* | Pick another port in the panel, and update the address in OBS. |
| The source is blank in OBS | Check the address starts `http://127.0.0.1:` and that the panel says **Stream page: on**. The same address in a normal browser should show the card. |
| The card shows "No programmer" | burnwright hasn't found one. **Detect** in the app. |
| The bar sweeps instead of filling | The programmer hasn't reported a percent for this stage. It fills once it does. |
