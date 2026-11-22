# Third party notices

Just Fits is built on other people's work. This file records what it uses,
under what terms, and where to get the original source. Full licence texts are
in the `licenses/` folder and are also shown inside the app under
**Licences and credits** in the footer.

Just Fits itself is GPL-3.0-or-later. See `LICENSE`.

---

## FFmpeg

Does all of the actual work: reading the file, deciding nothing, and encoding
what it is told to. `ffprobe` from the same project reads the duration,
resolution, frame rate and stream layout that `src/plan.js` does its
arithmetic on.

- Project: <https://ffmpeg.org>, source at <https://github.com/FFmpeg/FFmpeg>
- FFmpeg's core is **LGPL v2.1 or later**. Every build shipped here is
  configured with `--enable-gpl`, which pulls in the GPL-licensed parts and
  moves the whole binary to the GPL. Builds that also carry
  `--enable-version3` are **GPL v3 or later**; builds without it are **GPL v2
  or later**. The table below says which is which.
- Full text: `licenses/ffmpeg-license.txt`, and the GPL itself in
  `licenses/gpl-3.0.txt` and `licenses/gpl-2.0.txt`.

**On the command line, FFmpeg is not bundled at all.** The `justfits` command
uses whatever `ffmpeg` and `ffprobe` are on your PATH, so the terms that apply
are those of the build your system installed, not of anything shipped here.
Only the desktop app carries its own copy.

**The bundled binaries are not built here and are not modified.** They are
published builds, taken exactly as the publisher shipped them. The publishers
differ per platform, and so do their configure lines, so the effective licence
is stated per build rather than once for all of them:

| Platform and arch | Publisher | Licence, from the configure line |
| --- | --- | --- |
| macOS x86_64 | [evermeet.cx/ffmpeg](https://evermeet.cx/ffmpeg/) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |
| macOS arm64 | [osxexperts.net](https://www.osxexperts.net) | `--enable-gpl`, no `--enable-version3`, so **GPL v2 or later** |
| Windows x86_64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (the `win64-gpl` build) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |
| Linux x86_64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (the `linux64-gpl` build) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |

All four were read out of the builds those sources served, last on 15 November
2026. Publishers change their configure lines, so the copy on your machine is
the authoritative answer for your copy.

`scripts/fetch-ffmpeg.mjs` is what downloads them, and it is the complete
record of where they came from. To see exactly how the copy on your machine
was configured, including every library compiled into it:

```sh
"/Applications/Just Fits.app/Contents/Resources/ffmpeg/ffmpeg-x64" -version
```

## x264

The H.264 encoder. Every video Just Fits produces comes out of it, and the
two-pass rate control that makes a file land on a target size is x264's.

- Project: <https://www.videolan.org/developers/x264.html>
- **Licence: GNU GPL v2 or later.** Full text: `licenses/gpl-2.0.txt`
- Compiled into the FFmpeg builds above, unmodified.

## x265

The H.265 encoder. Compiled into the same builds. Just Fits does not currently
encode H.265, but the binary carries it, so it is listed.

- Project: <https://www.videolan.org/developers/x265.html>
- **Licence: GNU GPL v2 or later.** Full text: `licenses/gpl-2.0.txt`

## Everything else inside FFmpeg

These builds also carry libopus, libvpx, libaom, libvorbis, libmp3lame,
libwebp, libass, dav1d, libtheora, libspeex and around twenty more, each under
its own terms, mostly BSD, LGPL or MIT. They are not listed individually here
because the list belongs to the build rather than to this app, and it changes
when the build does. `ffmpeg -version` prints the exact configuration of the
copy you have, which is the authoritative answer for your binary.

## Electron

The application shell: Chromium for the window, Node for the file handling.

- Project: <https://www.electronjs.org>
- **Licence: MIT.** Electron bundles Chromium and Node.js, whose combined
  licence text ships inside the app as `LICENSES.chromium.html`.

---

## Meeting the GPL terms

FFmpeg as shipped here is GPL v3 or later, or GPL v2 or later on Apple Silicon
(the table above). Distributing it inside an application carries
obligations, and Just Fits meets them like this:

0. **Compatibility.** Just Fits is GPL-3.0-or-later, the same licence, so there
   is no combination problem to solve.
1. **Notice.** This file, plus the in-app credits screen, names each component
   and its licence.
2. **Licence texts.** Shipped in full, both in `licenses/` and inside the app.
3. **Source.** Linked above. Nothing was modified for Just Fits; published
   builds are used as-is, so the upstream source is the complete source.
4. **Replacing them.** The binaries live in `vendor/ffmpeg` and are found by
   name at runtime. Drop your own GPL build in with the same filenames and the
   app uses it. Nothing is statically linked and nothing is patched.

If you would rather have the source on a disk than a link, ask and it will be
sent.

## A note on H.264 patents

H.264 is covered by patents in some countries. Just Fits encodes H.264 with
x264, an independent open source encoder, and the licence above covers the
copyright in that software and nothing else. Patent licensing is a separate
matter from the software licence. If you are redistributing Just Fits
commercially or at scale, take your own advice on what that means where you
operate.
