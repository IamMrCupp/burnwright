# The stream page

Putting a programming session on a live stream used to mean capturing the
app's window — and with it the file paths in the buffer panel, minipro's
command lines in the log and the hex view. The stream page is the other way:
burnwright serves a small web page of its own, and OBS loads it as a Browser
source. It shows the programmer, the chip and a progress bar — and its own name in
the corner. Nothing else.

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

- **The programmer's model** — "T48".
- **The chip** that's selected.
- **The operation in progress** — Read, Verify, Blank check, Erase, Write or
  Check chip — with a progress bar and a percent. When a verify fails and
  burnwright reads the chip back to show the differences, that shows as a
  Read.
- **How the last operation ended**: OK, warning or error, by name and colour.

The card's top-right corner carries burnwright's logo and name, small — a
credit, so a scene says what's drawing the card without a separate logo
source to place. To leave both off, add `?credit=0` to the address in OBS:
`http://127.0.0.1:8790/stream?credit=0`.

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

## Showing the whole window instead

The card is for a corner of a scene. To put all of burnwright on stream — the
chip's details, the hex view, the log — capture its window in OBS like any
other app, and turn on **Stream page** → **Hide file paths in this window**
first.

While it's on, every file path on both benches reads `[hidden]`, keeping the
extension: `Opened [hidden].bin: 4,194,304 bytes.` That covers the log
(burnwright's own lines and minipro's and flashrom's command lines), the
buffer's file name and its tooltip, error messages, the T76's algorithm file
and the EC bench's flashrom and backup lines. The folder and the file name
both go — a file name is the likeliest place for a customer's name. A
**Paths hidden** marker sits in the top bar while it's on, so you can check
before going live.

It hides what's drawn, not what's kept. Files open and save as usual, **Copy
log** copies the masked text while it's on, and turning it off shows the real
paths again, old log lines included. It's remembered between runs, and it's
separate from the card: either works without the other.

What it doesn't cover:

- **The hex view.** The chip's contents are on screen.
- **The system's open and save panels.** Those are the OS's own windows. If
  OBS captures the window rather than the whole screen, they aren't in the
  picture, but check your capture.
- **A path burnwright never saw.** A path with a space in it is hidden whole
  when you picked it in a file panel or burnwright holds it (the buffer's
  file, the algorithm file, flashrom, a backup). One that only ever appears
  inside minipro's or flashrom's own output is cut at the space, so the part
  after it stays readable. The usual case is a temp folder under a Windows
  user name with a space in it.

## When the card shows

Only while burnwright has a programmer connected. Unplug it, or start
burnwright with none attached, and the card fades out; it comes back when
**Detect** finds one. So the card can sit in a camera scene for a whole
stream and only appear while there's chip work going on.

When burnwright isn't running, the page keeps trying to reconnect, and picks
the feed back up on its own when burnwright starts. In between it shows
nothing at all: a progress bar frozen at 40% on stream would pass for a live
one.

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
| The source is blank, the panel says **Stream page: on**, and a programmer is plugged in | burnwright hasn't found it yet. **Detect** in the app. |
| The bar sweeps instead of filling | The programmer hasn't reported a percent for this stage. It fills once it does. |
