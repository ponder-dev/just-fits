# Just Fits

Makes a video small enough to send. Point it at a file, pick a limit, and it
compresses to land just under that limit. Everything happens on your machine.

Built because "compress for Discord" is a thing everyone needs and every
existing answer is either a website you upload your footage to, or a wall of
ffmpeg flags you have to get right yourself.

## How it decides

Hitting an exact size is arithmetic, not guesswork:

1. Read the duration, resolution, frame rate and whether there is sound.
2. Turn the target size into a total bitrate, minus 5 percent, because mp4
   spends a little on overhead the bitrate maths cannot see.
3. Give sound the smallest share that still sounds like sound. Speech stays
   intelligible far below the point where picture falls apart, so audio gives
   way first, and drops to mono before it drops below 48kbps.
4. Give the rest to picture, then pick the largest frame size that still gets
   enough bits per pixel to look like the source. Frame rate halves before the
   resolution collapses.
5. Encode in two passes, which is precisely what two-pass is for.
6. Measure what actually came out. x264 overshoots on hard footage, so if it
   missed, correct by the measured amount and go again. Three attempts.

All of that lives in `src/plan.js` as pure functions, with no ffmpeg and no
filesystem anywhere near it, because whether your file comes in under the line
is the one thing this has to get right. `test/plan.test.cjs` covers it.

## The presets

Checked August 2026, and they move, so they live in one list in `src/plan.js`
and the custom box is always there.

Discord is 10MB free, 50MB on Nitro Basic, 500MB on Nitro, and a level 3
boosted server gives everyone in it 100MB whether they pay or not.

The email presets aim lower than the number the provider advertises, because
attachments are base64 encoded in transit and that adds about 37 percent.
Gmail says 25MB and will bounce a 25MB file, so the Gmail preset targets 18.2MB.

## The rules it follows

- **Your original is only ever read.** Output goes to `name-fits.mp4` beside
  it, and never to a path that already exists.
- **Nothing is uploaded.** There is no network code in the app at all.
- **No account, no telemetry, no update checker.** The build you have is the
  build you keep.
- GPL v3, like the ffmpeg build it carries.

## Running it

```sh
npm install
npm run fetch-ffmpeg     # puts ffmpeg and ffprobe in vendor/
npm start
```

## The command line

```sh
npm install -g @ponderdev/justfits
justfits clip.mp4 --to discord
```

No dependencies and no bundled encoder, so the install is under 2MB. It uses
whatever ffmpeg is on your PATH, which on Linux is one package away
(`pacman -S ffmpeg`, `apt install ffmpeg`). The desktop app carries its own
copy instead, because someone downloading a finished app should not then be
told to install a video encoder.

Needs Node 22 or newer, and an ffmpeg with libx264 on the PATH (no minimum version has been tested).

```sh
justfits clip.mp4                      # beside it, as clip-fits.mp4 (a picture becomes clip-fits.jpg)
justfits clip.mp4 --to gmail           # any preset, or a size like 25MB
justfits clip.mp4 -o small.mp4         # somewhere specific
justfits clip.mp4 --json               # for scripting
cat clip.mp4 | justfits --to 8MB > small.mp4
```

If the name is taken it writes `clip-fits 2.mp4`, then 3, and never over an
existing file. A file that is neither video nor picture is refused with a
sentence saying so (exit 1). With input from stdin and no `-o`, the result goes
to stdout.

Progress goes to stderr, so stdout stays clean to pipe. Piped input is buffered
to a temp file first and it says so: two-pass encoding reads the input twice
and a pipe cannot be rewound.

### For scripts and assistants

- `--json` prints one JSON line per thing it did, then a `done` line: a
  `result` (written), a `skip` (it already fit) or an `error`. Errors are JSON
  too. When the video itself goes to stdout, the JSON goes to stderr instead.
- `--describe` prints every option, its type and default, the targets and the
  exit codes, as JSON, so nothing has to be guessed from `--help`.
- `--dry-run` says what would happen and writes nothing.
- `--help`, `--version` and `--describe` answer at once and do nothing else.

Exit status: **0** done or already fits, **1** failed, **2** a bad option,
target or missing file (nothing was started), **4** still over the target
after every try. 129, 130 and 143 mean it was stopped, with part files removed.

**Changed in 1.2.0**, for anyone with a script from before: still over the
target is now 4 (it was 2, which is now a usage error), and `--json` ends with a
`done` line, so read the first line rather than parsing everything printed.
The fields in a result are the same as before.

The maths and the ffmpeg work are shared with the desktop app rather than
reimplemented, so both produce the same output for the same input.

## Licences

GPL-3.0-or-later, like the ffmpeg build it carries. `THIRD-PARTY-NOTICES.md`
names every bundled component and how the terms are met; `licenses/` holds the
full texts; and both are readable from inside the app under **Licences and
credits** in the footer.

`npm run licences` regenerates that screen from those files, and the build
scripts run it first so a stale one cannot ship.

## Tests

```sh
npm test                                 # the size arithmetic, instant
node test/cli.test.cjs                   # the command line, as a subprocess
npm run test:linux                       # the command line on real linux, in docker
node test/encode.test.cjs                # real encodes, a minute or two
electron test/window.test.cjs            # the window boots and renders
```

`encode.test.cjs` builds its own footage, compresses it, and checks the result
is both under the limit and still playable. It also checks the original came
through untouched.

`test:linux` installs the published package into a Debian container, with that
distro's own ffmpeg, and runs the same checks. The CLI is headless so a
container is a real test of it. The GUI is not testable this way.

## ffmpeg

`vendor/` is not in git: the binaries are large, they are not ours to
redistribute through our history, and they move on someone else's schedule.
`npm run fetch-ffmpeg` pulls them, `--all` gets every arch a release needs.

Any GPL build with libx264 works. If a host moves, drop the binaries in by
hand as `ffmpeg-x64`, `ffmpeg-arm64`, `ffprobe-x64`, `ffprobe-arm64`, or with
`.exe` on Windows. Nothing in the app cares where they came from.

**Apple Silicon** builds come from osxexperts.net, since evermeet publishes
x86_64 only. Those are checked against a published SHA256 before installing,
and the script refuses rather than installs on a mismatch. Note the published
hash is of the binary inside the zip, not of the zip.

## Still to do

- test a packaged build on Apple Silicon and on Windows, on real hardware
