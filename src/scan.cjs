'use strict';

/*
 * What a set of paths holds, for the window and the command line alike, so a
 * folder means the same thing in both. The walk is the kit's folder intake
 * (kit/scan.cjs, the same in every tool); what is Just Fits' own is here: the
 * names it takes from inside a folder, and its own results (name-fits.mp4,
 * name-fits 2.jpg), which are passed over so a folder fitted once and then
 * again is not fitted on top of itself, and its results folders ("Holiday
 * (fitted)"), for the same reason. A file named on its own is always taken,
 * and the probe says whether it can be read.
 */

const kit = require('./kit/scan.cjs');

const EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif']);
const OURS = /-fits( \d+)?$/i;

// What it did, for a folder's results folder: "Holiday (fitted)".
const WORD = 'fitted';

const scan = (paths) => kit.scan(paths, { extensions: [...EXTENSIONS], ours: OURS, word: WORD });

/*
 * Where each file's result goes, for one run: a folder's results go into a
 * new "Holiday (fitted)" beside it, chosen once per folder per run; a file on
 * its own, or every file when beside is set (Save next to the originals
 * instead), gets its result beside it. Either way a result is named
 * name-fits.mp4 (decided 2026-11-20), so it reads as a result wherever it goes. Returns
 * { outDir, suffix, folder } for the engine; folder is the results folder, or
 * null beside the original.
 */
function places({ beside = false } = {}) {
  const chosen = new Map();
  return (file) => {
    if (beside || !file.from) return { outDir: undefined, suffix: undefined, folder: null };
    if (!chosen.has(file.from)) chosen.set(file.from, kit.resultsFolder(file.from, WORD));
    const folder = chosen.get(file.from);
    return { outDir: kit.resultDir(file, folder), suffix: undefined, folder };
  };
}

module.exports = { scan, places, EXTENSIONS, WORD };
