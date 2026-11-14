'use strict';

/* The window. Holds no logic worth testing: the decisions live in plan.js. */

const MB = 1000 * 1000;

const el = (id) => document.getElementById(id);
let chosen = null;      // the file being worked on
let targetBytes = 10 * MB;
let busy = false;

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

function useTarget(t) {
  targetBytes = t.bytes;
  el('aim').textContent = `aiming for ${human(t.bytes)}`;
  el('why').textContent = t.note || '';
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
  targetBytes = mb * MB;
  el('aim').textContent = `aiming for ${human(targetBytes)}`;
  el('why').textContent = '';
});

/* --- picking a file ----------------------------------------------------- */

async function take(filePath) {
  if (busy) return;
  hide('error');
  hide('done');

  // A drop that carries no path (dragged from somewhere that is not a real
  // file on disk) would otherwise surface ffprobe's ": No such file" with no name.
  const r = filePath
    ? await window.fits.probe(filePath)
    : { ok: false, message: 'Could not tell where that file is. Try "choose a file" instead.' };
  if (!r.ok) {
    chosen = null;
    el('go').disabled = true;
    // Hide the previous file, so its name is not left beside an error about another.
    el('file').hidden = true;
    showInView('error', r.message);
    return;
  }

  chosen = { path: filePath, info: r.info };
  el('name').textContent = filePath.split(/[\\/]/).pop();
  el('facts').textContent = [
    human(r.info.bytes),
    r.info.width && `${r.info.width}x${r.info.height}`,
    r.info.kind === 'video' && r.info.durationSec && clock(r.info.durationSec),
    r.info.kind === 'video' && `${Math.round(r.info.fps)}fps`,
    r.info.kind === 'video' && (r.info.hasAudio ? 'with sound' : 'silent'),
  ].filter(Boolean).join('  ·  ');

  el('file').hidden = false;
  el('go').disabled = false;
}

const drop = el('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) take(window.fits.pathFor ? window.fits.pathFor(f) : f.path);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

el('browse').addEventListener('click', async () => {
  const f = await window.fits.pickFile();
  if (f) take(f);
});

/* --- the work ----------------------------------------------------------- */

function show(id, text) {
  const node = el(id);
  if (text !== undefined) node.textContent = text;
  node.hidden = false;
}
function hide(id) { el(id).hidden = true; }

// At 800x600 the window is short enough that progress, the result and errors
// all land below the fold, and a greyed button alone looks the same as nothing
// happening. So whatever the user is now waiting on, or has just got, scrolls
// into view.
function showInView(id, text) {
  show(id, text);
  el(id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

window.fits.onProgress((p) => {
  el('fill').style.width = Math.round(p.progress * 100) + '%';
  el('stage').textContent = p.stage;
  el('pct').textContent = Math.round(p.progress * 100) + '%';
  el('attempt').textContent = p.attempt > 0 ? `attempt ${p.attempt + 1}, aiming lower` : '';
});

el('go').addEventListener('click', async () => {
  if (!chosen || busy) return;

  if (chosen.info.bytes <= targetBytes) {
    el('result').textContent = 'That already fits.';
    el('result').classList.remove('over');
    el('detail').textContent = `${human(chosen.info.bytes)}, under the ${human(targetBytes)} limit. Nothing to do.`;
    el('reveal').hidden = true;
    el('where').textContent = '';
    showInView('done');
    return;
  }

  busy = true;
  el('go').disabled = true;
  hide('error');
  hide('done');
  el('fill').style.width = '0%';
  showInView('working');

  const r = await window.fits.fit(chosen.path, targetBytes);

  busy = false;
  el('go').disabled = false;
  hide('working');

  if (!r.ok) {
    if (!r.cancelled) showInView('error', r.message);
    return;
  }

  const saved = Math.round((1 - r.bytes / r.before) * 100);
  el('done').classList.toggle('over', Boolean(r.over));
  el('result').textContent = r.over
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
  el('detail').textContent = bits.join('  ·  ');

  el('where').textContent = whereText(r.path);
  el('reveal').hidden = false;
  el('reveal').onclick = () => window.fits.reveal(r.path);
  showInView('done');
});

el('cancel').addEventListener('click', () => window.fits.cancel());
el('site').addEventListener('click', () => window.fits.openSite());
el('licences').addEventListener('click', () => window.fits.openLicences());

drawTargets();
