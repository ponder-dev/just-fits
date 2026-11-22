'use strict';

/* The window. Holds no logic worth testing: the decisions live in plan.js.
   The start screen, the file row, the run part and the footer come from the
   kit (kit/kit.js); this file fills them with Just Fits' own words. */

const MB = 1000 * 1000;

const el = (id) => document.getElementById(id);

// The strip at the top is room for the Mac's traffic lights, which sit over the
// page. Windows and Linux have a native title bar of their own, so there it
// would only be an empty band under it.
let chosen = null;      // the file being worked on
let targetBytes = 10 * MB;
let busy = false;
let made = null;        // the file the last run saved, for "Show me the file"
let batch = null;       // several files or a folder, instead of chosen (see take below)
let runNo = 0;          // each press of Compress on a batch, so main picks a folder's results folder once per run

// A folder's results go into a new folder beside it ("Holiday (fitted)")
// unless Save next to the originals instead is ticked (decided 2026-11-20).
const settings = Kit.store('justfits', { beside: false });

function human(bytes) {
  if (bytes >= 1000 * MB) return trim(bytes / 1000 / MB) + ' GB';
  if (bytes >= MB) return trim(bytes / MB) + ' MB';
  return Math.max(1, Math.round(bytes / 1000)) + ' KB';
}

// 10 rather than 10.0, but 9.5 rather than 10.
function trim(n) {
  return n.toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, '');
}

function clock(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* --- the parts ---------------------------------------------------------- */

async function choose() {
  const picked = await window.fits.pickFile();
  if (picked && picked.length) intake(picked);
}

// Windows and Linux pickers take files or folders, never both in one, so
// there a folder has a button of its own. A Mac's picker takes either.
async function chooseFolder() {
  const picked = await window.fits.pickFolder();
  if (picked && picked.length) intake(picked);
}

// Option A: nothing but the drop zone until a file is in.
const start = Kit.start(el('start'), {
  name: 'Just Fits',
  version: window.fits.version,
  line: 'Makes a file small enough to send.',
  icon: 'video',
  say: 'Drop videos, pictures or a folder here',
  choose: 'Choose a file',
  takes: 'A video or picture, or several, or a folder of them',
  onChoose: choose,
  also: window.fits.folderButton ? { label: 'Choose a folder', onClick: chooseFolder, change: 'Change folder' } : null,
  // Copy skill puts the app's own SKILL.md on the clipboard; What's this?
  // says what a skill is, with How it works opening the page through main.
  skill: {
    copy: () => window.fits.skillText(),
    about: () => window.fits.openHowItWorks(),
  },
  // No onDrop here: the veil takes a drop anywhere in the window, the drop
  // zone included, so a drop on the zone is not taken twice.
});
start.buttons.choose.id = 'browse';
start.buttons.change.id = 'change';
if (start.buttons.also) start.buttons.also.id = 'browse-folder';
if (start.buttons.changeAlso) start.buttons.changeAlso.id = 'change-folder';

const run = Kit.run(el('run'), {
  onCancel: () => cancel(),
  onReveal: () => { if (made) window.fits.reveal(made); },
  onAgain: () => again(),
  onRetry: () => (batch ? compressMany() : compress()),
});
run.buttons.cancel.id = 'cancel';
run.buttons.reveal.id = 'reveal';
run.buttons.again.id = 'again';
run.buttons.retry.id = 'retry';

const veil = Kit.veil({
  say: 'Drop videos, pictures or a folder',
  icon: 'video',
  // While a file is being fitted a drop is refused: no veil, and the pointer
  // shows it will not be taken, rather than a drop that does nothing.
  when: () => !busy,
  onDrop: (files) => {
    if (files.length) intake(files.map((f) => (window.fits.pathFor ? window.fits.pathFor(f) : f.path)));
  },
});
// Without a veil handler of its own, a drop outside the page's own targets
// would have the window navigate to the file.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

Kit.footer(el('footer'), {
  onSite: () => window.fits.openSite(),
  onLicences: () => window.fits.openLicences(),
});

const runState = () => el('run').dataset.state;

// The estimate above the main button is for before a run; once the button is
// pressed the run part says what is happening instead.
function note() {
  el('aim').textContent = runState() === 'idle' ? `Aiming for ${human(targetBytes)}` : '';
}

function veilSay() {
  veil.say(batch ? 'Drop to use these instead' : chosen ? 'Drop to use this file instead' : 'Drop videos, pictures or a folder');
}

/* --- target picking ----------------------------------------------------- */

let TARGETS = [];

async function drawTargets() {
  TARGETS = await window.fits.targets();
  const select = el('target');
  let html = '';
  let group = null;
  for (const t of TARGETS) {
    if (t.group !== group) {
      if (group !== null) html += '</optgroup>';
      group = t.group;
      html += `<optgroup label="${group}">`;
    }
    const size = t.bytes >= 1000 * MB ? `${t.bytes / 1000 / MB}GB` : `${Math.round(t.bytes / MB)}MB`;
    html += `<option value="${t.id}">${t.label} &middot; ${size}</option>`;
  }
  select.innerHTML = html + '</optgroup>';
  select.value = TARGETS[0].id;
  useTarget(TARGETS[0]);
}

// The done card was for the old limit, and kept saying so beside the new one.
// A failed card goes the same way: its reason belonged to the old limit.
function dropDone() {
  if (!busy && (runState() === 'done' || runState() === 'failed')) run.reset();
}

function useTarget(t) {
  dropDone();
  targetBytes = t.bytes;
  el('why').textContent = t.note || '';
  note();
}

el('target').addEventListener('change', (e) => {
  const t = TARGETS.find((x) => x.id === e.target.value);
  if (!t || busy) return;
  el('custom').value = '';
  useTarget(t);
});

el('custom').addEventListener('input', (e) => {
  const mb = Number(e.target.value);
  if (!(mb > 0)) {
    // Cleared or nonsense: fall back to what the dropdown shows, rather than
    // quietly keeping the last custom size while the dropdown says otherwise.
    const t = TARGETS.find((x) => x.id === el('target').value);
    if (t) useTarget(t);
    return;
  }
  dropDone();
  targetBytes = mb * MB;
  el('why').textContent = '';
  note();
});

/* --- picking a file ----------------------------------------------------- */

// Whatever came in, by the picker or a drop: one file goes the way it always
// has (take), and several files or a folder become a batch (takeMany).
async function intake(paths) {
  if (busy) return;
  paths = paths.filter(Boolean);
  // No path at all (a drop from somewhere that is not a file on disk): take
  // says so in its own words.
  if (!paths.length) return take('');
  const g = await window.fits.gather(paths);
  if (g.single) return take(paths[0]);
  return takeMany(paths, g);
}

async function take(filePath) {
  if (busy) return;
  start.error('');
  run.reset();
  made = null;
  batch = null;
  whereField(null);

  // A drop that carries no path (dragged from somewhere that is not a real
  // file on disk) would otherwise surface ffprobe's ": No such file" with no name.
  const r = filePath
    ? await window.fits.probe(filePath)
    : { ok: false, message: 'Could not tell where that file is. Try "Choose a file" instead.' };
  if (!r.ok) {
    chosen = null;
    // Back to the start, so the previous file's name is not left beside an
    // error about another; the reason goes under the drop zone.
    start.reset();
    note();
    veilSay();
    start.error(r.message);
    el('start').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  chosen = { path: filePath, info: r.info };
  start.landed({
    name: filePath.split(/[\\/]/).pop(),
    icon: r.info.kind === 'image' ? 'photo' : 'video',
    facts: [
      human(r.info.bytes),
      r.info.width && `${r.info.width}x${r.info.height}`,
      r.info.kind === 'video' && r.info.durationSec && clock(r.info.durationSec),
      r.info.kind === 'video' && `${Math.round(r.info.fps)}fps`,
      r.info.kind === 'video' && (r.info.hasAudio ? 'with sound' : 'silent'),
    ].filter(Boolean).join(' · '),
  });
  el('go').disabled = false;
  note();
  veilSay();
}

// Several files or a folder. Each is probed first, so the file row can say
// what came in and the run knows which ones it cannot read before it starts.
async function takeMany(paths, g) {
  if (busy) return;
  start.error('');
  run.reset();
  made = null;
  chosen = null;
  batch = null;
  whereField(null);
  const label = paths.length === 1 && g.folders === 1 ? paths[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop() : `${g.files.length} files`;
  if (!g.files.length) {
    start.reset();
    note();
    veilSay();
    start.error(g.missing.length ? `Could not find ${g.missing[0].split(/[\\/]/).pop()}. It may have been moved or deleted.` : `There are no videos or pictures in ${label}.`);
    return;
  }

  // A few at a time: a folder of hundreds should not wait on each in turn.
  const items = g.files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes, from: f.from, info: null, message: '' }));
  for (let i = 0; i < items.length; i += 4) {
    await Promise.all(items.slice(i, i + 4).map(async (it) => {
      const r = await window.fits.probe(it.path);
      if (r.ok) it.info = r.info; else it.message = r.message;
    }));
  }
  if (busy) return;

  const videos = items.filter((it) => it.info && it.info.kind === 'video').length;
  const pictures = items.filter((it) => it.info && it.info.kind === 'image').length;
  const unreadable = items.length - videos - pictures;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const kinds = [videos && count(videos, 'video', 'videos'), pictures && count(pictures, 'picture', 'pictures'), unreadable && `${unreadable} it cannot read`].filter(Boolean);
  batch = { label, items };
  whereField(items.find((it) => it.from));
  start.landed({
    name: label,
    icon: g.folders ? 'folder' : videos ? 'video' : 'photos',
    facts: `${kinds.join(', ')} · ${human(items.reduce((n, it) => n + it.bytes, 0))}`,
  });
  el('go').disabled = false;
  note();
  veilSay();
}

// Save next to the originals instead: shown only with a folder in, with a
// line saying where the results go otherwise (the first folder's name).
function whereField(fromFolder) {
  el('where-field').hidden = !fromFolder;
  if (!fromFolder) return;
  const name = fromFolder.from.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  el('beside').checked = settings.get('beside');
  el('where-hint').textContent = el('beside').checked
    ? 'Each one is saved beside its original, as name-fits.'
    : `Otherwise they go in a new folder beside it, ${name} (fitted), and the folder itself is left as it is.`;
}
el('beside').addEventListener('change', () => {
  settings.set('beside', el('beside').checked);
  whereField(batch && batch.items.find((it) => it.from));
});

// Start again: back to the drop zone, with the target left as it was.
function again() {
  if (busy) return;
  chosen = null;
  batch = null;
  whereField(null);
  made = null;
  start.error('');
  run.reset();
  start.reset();
  note();
  veilSay();
}

/* --- the work ----------------------------------------------------------- */

// At 800x600 the window is short enough that progress, the result and errors
// all land below the fold, and a grayed button alone looks the same as nothing
// happening. So whatever the user is now waiting on, or has just got, scrolls
// into view.
function inView() {
  el('run').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// The output goes beside the original with no Save window, so the Done card
// says what it is called and where it is, rather than leaving the user to find
// out through "Show me the file". Split by hand: the page has no path module.
function whereText(file) {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const name = file.slice(cut + 1);
  // A file at the top of a drive or the root keeps its separator: C:\ and /.
  const folder = cut > 0 && !/:$/.test(file.slice(0, cut)) ? file.slice(0, cut) : file.slice(0, cut + 1);
  return folder ? `Saved as ${name}, next to the original in ${folder}` : `Saved as ${name}`;
}

// The time left, from how fast this attempt has gone so far. Each attempt
// starts its progress again, so the clock starts again with it.
let pace = null;
function timeLeft(p) {
  const now = Date.now();
  if (!pace || pace.attempt !== p.attempt || p.progress < pace.from) pace = { attempt: p.attempt, from: p.progress, at: now };
  const done = p.progress - pace.from;
  const spent = (now - pace.at) / 1000;
  if (spent < 2 || done < 0.02) return '';
  const s = Math.max(1, Math.round(spent / done * (1 - p.progress)));
  if (s < 60) return `About ${s} second${s === 1 ? '' : 's'} left`;
  const m = Math.round(s / 60);
  return `About ${m} minute${m === 1 ? '' : 's'} left`;
}

window.fits.onProgress((p) => {
  if (!busy) return;
  if (batch) return manyProgress(p);
  const pct = Math.round(p.progress * 100);
  run.working({
    what: p.stage + (p.attempt > 0 ? `, attempt ${p.attempt + 1}, aiming lower` : ''),
    // Until ffmpeg says how far it is (a slow machine's first pass can take
    // a while to say anything, and a picture says nothing), the bar sweeps.
    count: p.progress > 0 ? pct + '%' : '',
    fraction: p.progress,
    unknown: !(p.progress > 0),
    file: chosen ? chosen.path.split(/[\\/]/).pop() : '',
    left: timeLeft(p),
  });
});

function finished({ title, detail = '', where = '', file = null, folder = false, over = false }) {
  made = file;
  run.done({ title, detail, where, reveal: Boolean(file), revealLabel: folder ? 'Show me the folder' : 'Show me the file', tone: over ? 'over' : '' });
  note();
  inView();
}

async function compress() {
  if (!chosen || busy) return;

  if (chosen.info.bytes <= targetBytes) {
    finished({
      title: 'That already fits.',
      detail: `${human(chosen.info.bytes)}, under the ${human(targetBytes)} limit. Nothing to do.`,
    });
    return;
  }

  busy = true;
  pace = null;
  el('go').disabled = true;
  veilSay();
  run.working({ what: 'Working', unknown: true, file: chosen.path.split(/[\\/]/).pop() });
  note();
  inView();

  const r = await window.fits.fit(chosen.path, targetBytes);

  busy = false;
  el('go').disabled = false;
  veilSay();

  if (!r.ok) {
    if (!r.cancelled) {
      run.failed(r.message);
      note();
      inView();
      return;
    }
    // Cancelled: say so, or the window just goes back to how it was.
    finished({ title: 'Stopped.', detail: 'Nothing was saved, and the original is untouched.' });
    return;
  }

  const saved = Math.round((1 - r.bytes / r.before) * 100);
  const title = r.over
    ? `Got it to ${human(r.bytes)}, still over the line.`
    : `Done. ${human(r.before)} to ${human(r.bytes)}, ${saved}% smaller.`;

  const bits = [];
  if (r.plan && r.kind === 'video') {
    bits.push(`${r.plan.width}x${r.plan.height}`);
    bits.push(`${Math.round(r.plan.fps)}fps`);
    bits.push(`${r.plan.videoKbps}k video`);
    if (r.plan.audioKbps) bits.push(`${r.plan.audioKbps}k audio`);
  }
  if (r.attempts > 1) bits.push(`${r.attempts} attempts`);
  // The plan knew when the target was too small for the length; say it here
  // too, so a soft picture is explained rather than a surprise. The sentence
  // is the command line's, from plan.lengthNote through main.
  const rough = r.note || '';

  // the facts stay a facts line; the plain-words warning leads the line under it
  finished({ title, detail: bits.join(' · '), where: (rough ? rough + ' ' : '') + whereText(r.path), file: r.path, over: Boolean(r.over) });
}

/* --- several files ------------------------------------------------------ */

// Cancel stops at once, in a batch too: the file being fitted is stopped and
// its half-written result removed (the engine does that), and no more start.
// Files already fitted stay fitted.
let stopping = false;
function cancel() {
  if (batch) {
    stopping = true;
    if (manyAt) manyProgress(manyAt.last);
  }
  window.fits.cancel();
}

let manyAt = null;      // where a batch run is: which file, since when

function rows() {
  return batch.items.map((it) => ({ name: it.name, state: it.state || 'waiting', note: it.note || '' }));
}

// The queue shows every file, so the one being fitted is kept in sight in it.
function showQueue() {
  run.queue(rows());
  const box = el('run').querySelector('.k-run-queue');
  const now = box && box.querySelector('li[data-q="working"]');
  if (now) box.scrollTop = Math.max(0, now.offsetTop - box.clientHeight / 2);
}

function inWords(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function manyProgress(p) {
  if (!manyAt) return;
  manyAt.last = p;
  const n = batch.items.length;
  // Weighed by size, not by count: a video among photos is most of the work,
  // and counting files said "3 seconds left" as it started on it.
  const items = batch.items;
  const total = items.reduce((t, it) => t + it.bytes, 0) || 1;
  const before = items.slice(0, manyAt.index).reduce((t, it) => t + it.bytes, 0);
  const overall = Math.min(1, (before + items[manyAt.index].bytes * (p ? p.progress : 0)) / total);
  const spent = (Date.now() - manyAt.started) / 1000;
  const left = spent > 3 && overall > 0.02 ? `About ${inWords(spent / overall * (1 - overall))} left` : '';
  const retry = p && p.attempt > 0 ? `, attempt ${p.attempt + 1}` : '';
  run.working({
    what: stopping ? 'Stopping' : `Fitting ${manyAt.index + 1} of ${n}${retry}`,
    count: overall > 0 ? Math.round(overall * 100) + '%' : '',
    fraction: overall,
    unknown: !(overall > 0),
    file: batch.items[manyAt.index].name,
    left,
  });
}

// A short reason for the queue; the whole sentence is in the probe's message.
function shortReason(message) {
  if (/is not a video or picture/.test(message)) return 'Not a video or picture Just Fits can read';
  if (/animated WebP/.test(message)) return 'An animated WebP, which it cannot shrink';
  if (/Could not find/.test(message)) return 'It was moved or deleted';
  return String(message || 'Failed').split('\n')[0];
}

async function compressMany() {
  if (!batch || busy) return;
  const items = batch.items;
  for (const it of items) { it.state = 'waiting'; it.note = ''; it.out = null; it.folder = null; it.copied = false; it.result = null; }
  const run1 = ++runNo;
  const beside = settings.get('beside');

  busy = true;
  stopping = false;
  made = null;
  el('go').disabled = true;
  veilSay();
  manyAt = { index: 0, started: Date.now(), last: null };
  manyProgress(null);
  showQueue();
  note();
  inView();

  const target = targetBytes;
  let stoppedAt = null;
  for (let i = 0; i < items.length; i++) {
    if (stopping) { stoppedAt = i; break; }
    const it = items[i];
    manyAt.index = i;
    manyAt.last = null;
    it.state = 'working';
    manyProgress(null);
    showQueue();

    if (!it.info) {
      it.result = 'failed';
      it.state = 'failed';
      it.note = shortReason(it.message);
    } else if (it.info.bytes <= target && (beside || !it.from)) {
      it.result = 'skipped';
      it.state = 'done';
      it.note = 'Already small enough';
    } else {
      const r = await window.fits.fit(it.path, target, { beside, run: run1 });
      if (r.cancelled) {
        // stopped part way: nothing of it was kept, and the queue says so
        it.state = 'waiting';
        it.note = 'Stopped part way, nothing kept';
        stoppedAt = i;
        break;
      } else if (!r.ok) {
        it.result = 'failed';
        it.state = 'failed';
        it.note = shortReason(r.message);
      } else if (r.copied) {
        // already small enough, copied into the results folder as it is
        it.result = 'skipped';
        it.state = 'done';
        it.note = 'Already small enough, copied in';
        it.out = r.path;
        it.folder = r.folder;
        it.copied = true;
      } else {
        it.out = r.path;
        it.folder = r.folder || null;
        it.before = r.before;
        it.after = r.bytes;
        if (!made) made = r.path;
        if (r.over) {
          it.result = 'over';
          it.state = 'failed';
          it.note = `Could not get under ${human(target)}, got to ${human(r.bytes)}`;
        } else {
          it.result = 'fitted';
          it.state = 'done';
          it.note = `${human(r.before)} to ${human(r.bytes)}`;
        }
      }
    }
  }
  const seconds = (Date.now() - manyAt.started) / 1000;
  manyAt = null;
  busy = false;
  el('go').disabled = false;
  veilSay();
  for (const it of items) if (it.state === 'waiting' && stoppedAt !== null && !it.note) it.note = 'Not started';
  showQueue();

  const tally = (k) => items.filter((it) => it.result === k).length;
  const fitted = tally('fitted');
  const skipped = tally('skipped');
  const over = tally('over');
  const failed = tally('failed');
  const tried = fitted + skipped + over + failed;

  if (stoppedAt === null && failed === items.length) {
    run.failed(`None of the ${items.length} files could be fitted. The list says why for each.`);
    note();
    inView();
    return;
  }

  const parts = [];
  if (fitted || (!skipped && !over && !failed)) parts.push(`${fitted} fitted`);
  if (skipped) parts.push(`${skipped} already small enough`);
  if (over) parts.push(`${over} could not get under ${human(target)}`);
  if (failed) parts.push(`${failed} could not be read or fitted`);
  let title;
  if (stoppedAt !== null && !tried) title = `Stopped. None of the ${items.length} files were changed.`;
  else if (stoppedAt !== null) title = `Stopped after ${tried} of ${items.length}. ${parts.join(', ')}.`;
  else if (skipped === items.length) title = `All ${items.length} already fit under ${human(target)}.`;
  else title = `Done. ${parts.join(', ')}.`;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const changed = items.filter((it) => it.out && !it.copied);
  const written = items.filter((it) => it.out);
  const before = changed.reduce((n, it) => n + it.before, 0);
  const after = changed.reduce((n, it) => n + it.after, 0);
  const detail = changed.length ? `${human(before)} to ${human(after)} in ${inWords(seconds)}` : '';
  const folders = [...new Set(written.map((it) => it.folder).filter(Boolean))];
  const besideCount = written.filter((it) => !it.folder).length;
  const nameOf = (p) => p.split(/[\\/]/).pop();
  const files = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;
  let where = '';
  if (folders.length === 1 && !besideCount) where = `Saved ${files(written.length)} in ${nameOf(folders[0])}`;
  else if (folders.length > 1 && !besideCount) where = `Saved ${files(written.length)} in ${folders.length} new folders beside the originals`;
  else if (folders.length) where = `Saved ${files(written.length - besideCount)} in ${folders.length === 1 ? nameOf(folders[0]) : `${folders.length} new folders`}, ${besideCount} next to ${besideCount === 1 ? 'its original' : 'their originals'}`;
  else if (written.length) where = 'Saved next to each original';
  if (where && stoppedAt !== null) where += '. The rest were left as they were.';
  finished({
    title,
    detail,
    where,
    // Show me the file: the results folder when they all went into one.
    file: folders.length === 1 && !besideCount ? folders[0] : made,
    folder: folders.length === 1 && !besideCount,
    over: over > 0,
  });
}

el('go').addEventListener('click', () => (batch ? compressMany() : compress()));

drawTargets();
