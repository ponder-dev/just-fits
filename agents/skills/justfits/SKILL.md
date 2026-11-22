---
name: justfits
description: Shrink a video or picture to fit a size limit with Just Fits (`justfits`), PonderDev's free command line and app, so it can be sent on Discord, email, WhatsApp, Signal, Slack and the rest. Use when the user wants to send, share, upload or attach a file that is too big: "make this fit Discord", "compress this video", "it's too big to send", "get this under 50MB", "shrink this clip for Gmail", "make every video in this folder fit". Runs entirely on the user's machine. Covers checking it's installed, picking the target, running it, and checking the result.
---

# Making a file fit with Just Fits

**Just Fits** (`justfits`) compresses a video, or a picture, to land just under
a size limit, and measures the result. It is PonderDev's free tool: page
https://ponderdev.com/justfits, source `ponder-dev/just-fits`. Use it instead of
hand-written ffmpeg: it works out the bitrate and size, makes as many tries as
it needs, and never writes over a file.

## Is it installed?

    command -v justfits && justfits --version

If not, the command line installs with `npm install -g @ponderdev/justfits`
(Node 22 or newer). That install uses `ffmpeg` from the PATH, so check
`command -v ffmpeg` too; if it's missing, say so and suggest the system's
package manager (`brew install ffmpeg`, `apt install ffmpeg`,
`winget install Gyan.FFmpeg`). The desktop app, from the page's download
button, carries its own ffmpeg. Ask before installing anything.

`justfits --help` and `justfits --describe` only print, so they're safe to run.
`--help` lists the current targets.

## Pick the target: ask where it's going

The limit decides the quality, so ask where the file is going if the user
hasn't said. A long video into a small target comes out small and soft; say so
before running.

| `--to` | Size | For |
| --- | --- | --- |
| `discord` (default) | 10MB | Discord, free account |
| `discord-basic` | 50MB | Discord Nitro Basic |
| `discord-boost3` | 100MB | a Discord server boosted to level 3 |
| `discord-nitro` | 500MB | Discord Nitro |
| `gmail` | 18.2MB | Gmail (its 25MB limit, less the email encoding) |
| `outlook` | 14.6MB | Outlook and Microsoft 365 |
| `whatsapp` | 16MB | WhatsApp video |
| `signal`, `imessage` | 100MB | Signal, iMessage |
| `slack` / `telegram` | 1GB / 2GB | Slack, Telegram |
| `25MB` etc. | any | a plain size |

Services change their limits; `justfits --help` on the installed copy is the
list that counts. If the file already fits, Just Fits says so and writes
nothing: send the original.

## Run it

    justfits "/path/to/video.mp4" --to discord-basic --json

- Several files, or a folder (subfolders too), go in one run:
  `justfits a.mp4 b.mov --to gmail --json` or `justfits "/path/to/folder" --json`.
  Each is fitted on its own to the same target; nothing is combined. Files
  named on their own are saved beside their originals; a folder's results go
  into a new folder beside it, `folder (fitted)` (subfolders mirrored, results
  named `name-fits`, files that already fit copied in so the folder is
  complete, the folder untouched). `--beside` saves each beside its original as
  `name-fits` instead. In a folder, hidden files, earlier `-fits` results and
  `(fitted)` folders are passed over. `-o` and stdin take one file only.
- A video comes out as `name-fits.mp4` beside it, a picture as `name-fits.jpg`.
  Then `name-fits 2.mp4` and so on: it never writes over a file, and the
  original is only read. `-o path` writes somewhere else.
- `-o path` names the one result: a video must end in `.mp4` and a picture in
  `.jpg` (a `.mov` or `.png` for the wrong kind is refused with exit 2, before
  anything is encoded). If the file already fits, `-o` still gets a copy of it,
  as a `result` line; without `-o` it is a `skip` line and nothing is written.
- It reads video (mp4, mov, m4v, mkv, webm, avi) and pictures (jpg, png, heic,
  webp, gif). An animated WebP is refused (exit 1, code `animated-webp`) because
  it would lose its animation. A file that is damaged or is not a video or
  picture is refused with exit 1, never reported as "already fits".
- `--to` takes a preset or a size such as `25MB`, `800KB` or `1.5GB`. `8b` is
  refused as bytes, since it is one letter from 8MB or 8KB.
- `--dry-run` says what it would do and writes nothing.
- With `--json`, stdout is JSON lines: a `result` line (`output`, `before` and
  `after` in bytes, `target`, `attempts`, `width`, `height`, and `notes` when the video is long
  for the target), or a `skip` line
  when it already fits, or an `error` line; then always a `done` line. With
  several files that is one line per file, each with its `input`.
- Exit codes: 0 done or already fit; 2 a usage mistake (bad option, unknown
  target, missing file), nothing started; 4 still over the target after every
  try, with the closest result written; 1 failed (with several files, every
  one failed); 3 several files where some were done and some failed; 129, 130 or 143 stopped by a
  signal, part files removed.
- A video takes every CPU core for a minute or more. On a machine someone is
  using, run it as `nice -n 19 justfits ...` and mention that a game or call
  running at the same time may stutter.

## Report back

Give the output path in full, the size before and after, and the resolution it
chose (`width` x `height`). If the resolution came out low, say so and offer
the next target up, or trimming the video first. A `notes` entry or a line on
stderr saying the video is long for the target means the picture will be soft
or blurry: pass that on. On exit 4, say it's still
over and by how much. For several files, sum it up (how many fitted, the total
before and after) and name each one that failed or stayed over, with its
reason. Nothing is uploaded by Just Fits; don't send or upload
the file yourself unless the user asks.
