#!/usr/bin/env bash
#
# Runs the command line on a real Linux box, in a container.
#
#   ./scripts/test-linux.sh            the published main branch
#   ./scripts/test-linux.sh --local    this working copy
#
# The point is not to rely on someone else having a Linux machine. The CLI is
# headless, so a container is a genuine test of it: real kernel, real distro
# ffmpeg, real npm install. The GUI is not testable this way and needs a
# desktop, which is still an open task.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker info >/dev/null 2>&1 || { echo "docker is not running" >&2; exit 1; }

if [ "${1:-}" = "--local" ]; then
  MOUNT=(-v "$PWD:/src:ro")
  INSTALL='cp -r /src /work && cd /work && npm install -g . --silent'
else
  MOUNT=()
  INSTALL='npm install -g github:ponder-dev/just-fits --silent'
fi

docker run --rm --platform linux/amd64 "${MOUNT[@]}" node:22-bookworm bash -c "
  set -e
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq ffmpeg >/dev/null 2>&1
  $INSTALL >/dev/null 2>&1
  cd /tmp

  fail() { echo \"  FAIL: \$1\"; exit 1; }

  echo \"  distro ffmpeg: \$(ffmpeg -version | head -1 | cut -d' ' -f3)\"
  echo \"  justfits:      \$(justfits --version)\"

  justfits --help | grep -q 'justfits <file>' || fail 'no usage in --help'
  echo '  --help         ok'

  ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 \
    -f lavfi -i sine=frequency=440 -t 8 -c:v libx264 -preset veryfast \
    -b:v 6000k -c:a aac -pix_fmt yuv420p clip.mp4

  out=\$(justfits clip.mp4 --to 2MB --json)
  echo \"\$out\" | grep -q '\"ok\":true' || fail \"compress said \$out\"
  size=\$(stat -c%s clip-fits.mp4)
  [ \"\$size\" -le 2000000 ] || fail \"landed at \$size bytes, over target\"
  echo \"  compress       ok, \$size bytes under 2000000\"

  before=\$(md5sum clip.mp4 | cut -d' ' -f1)
  cat clip.mp4 | justfits --to 1MB > piped.mp4 2>/dev/null
  [ \"\$(md5sum clip.mp4 | cut -d' ' -f1)\" = \"\$before\" ] || fail 'the original changed'
  dur=\$(ffprobe -v error -show_entries format=duration -of csv=p=0 piped.mp4)
  [ \"\${dur%.*}\" -ge 7 ] || fail \"piped output is not playable, duration \$dur\"
  echo \"  pipe           ok, \${dur%.*}s playable out of stdout\"
  echo \"  original       untouched\"
"
echo "  linux: all good"
