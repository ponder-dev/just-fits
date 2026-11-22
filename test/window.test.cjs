'use strict';

/*
 * Boots the real window offscreen and checks it renders.
 *
 *   electron test/window.test.cjs [screenshot.png]
 *
 * Catches the things a node test cannot: a preload that fails to expose its
 * bridge, a renderer that throws on load, a Content Security Policy that
 * blocks its own stylesheet.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const binaries = require('../src/binaries.cjs');

// Clean-up never throws: on Windows a folder the app still holds (one just
// dropped on the window, say) cannot be deleted yet, and a throw here left
// the test waiting on its own time limit instead of finishing.
function tidy(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left for the system's temp clean-up */ }
}
// Anything thrown and not caught ends the test at once, saying what, instead
// of leaving it to wait on its time limit.
process.on('unhandledRejection', (err) => { console.error('\n  window test: ' + ((err && err.stack) || err)); app.exit(1); });

// The real handlers, so this checks the window against what main actually
// provides rather than against a stub written to make the test pass. Set
// before the require so main registers nothing and opens no window itself.
process.env.JUST_TEST_NO_WINDOW = '1';
require('../src/main.cjs').registerHandlers();

const shot = process.argv[2];
const problems = [];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // The kit's frame, as main gives every window (the kit check makes sure it does).
  const { frame, dress } = require('../src/kit/window.cjs');
  const win = new BrowserWindow({
    ...frame(),
    width: 720, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  dress(win);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) problems.push('console: ' + message);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    problems.push(`preload ${file}: ${err.message}`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // Seen means laid out on screen: a control inside something hidden has no
  // offsetParent.
  const seen = `const seen = (n) => !!n && !!n.offsetParent;`;

  const checks = await win.webContents.executeJavaScript(`(() => { ${seen} return {
    bridge: typeof window.fits === 'object' && typeof window.fits.fit === 'function',
    pathFor: typeof window.fits.pathFor === 'function',
    kit: typeof window.Kit === 'object' && typeof window.Kit.VERSION === 'string',
    targets: document.querySelectorAll('#target option').length,
    groups: document.querySelectorAll('#target optgroup').length,
    aim: document.getElementById('aim').textContent,
    styled: getComputedStyle(document.body).backgroundColor,
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    name: document.querySelector('#start h1').textContent,
    line: document.querySelector('#start .sub').textContent,
    zone: seen(document.querySelector('#start .k-zone')),
    say: document.querySelector('#start .k-zone-say').textContent,
    browse: seen(document.getElementById('browse')) && document.getElementById('browse').textContent,
    targetSeen: seen(document.getElementById('target')),
    goSeen: seen(document.getElementById('go')),
    fileSeen: seen(document.querySelector('#start .k-file')),
    promise: document.querySelector('#footer > span').textContent,
    poweredBy: document.getElementById('site').innerText.trim(),
    hasLicences: !!document.getElementById('licences'),
  }; })()`);

  if (!checks.bridge) problems.push('preload did not expose window.fits');
  if (!checks.pathFor) problems.push('pathFor missing, drag and drop would break');
  if (!checks.kit) problems.push('the kit did not load, check kit/kit.js and the CSP');
  if (checks.targets < 10) problems.push(`expected the full preset list, saw ${checks.targets}`);
  if (checks.groups < 3) problems.push(`presets should be grouped, saw ${checks.groups} groups`);
  if (!/^Aiming for \d/.test(checks.aim)) problems.push('no target is aimed at on load: ' + checks.aim);
  if (checks.styled === 'rgba(0, 0, 0, 0)') problems.push('stylesheet did not apply, check the CSP');
  // The window paints backgroundColor before the page does, so the two have
  // to be the same colour or the window flashes as it opens.
  const painted = '#' + win.getBackgroundColor().replace('#', '').slice(-6).toLowerCase();
  if (painted !== checks.bg.toLowerCase()) problems.push(`the window's backgroundColor ${painted} is not the page's --bg ${checks.bg}`);
  // Before a file: the start screen and nothing else.
  if (checks.name !== 'Just Fits' || checks.line !== 'Makes a file small enough to send.') problems.push(`start screen heading is wrong: ${checks.name} / ${checks.line}`);
  if (!checks.zone) problems.push('the drop zone is not showing');
  if (checks.say !== 'Drop videos, pictures or a folder here') problems.push('drop zone sentence is wrong: ' + checks.say);
  if (checks.browse !== 'Choose a file') problems.push('the choose button is not showing: ' + checks.browse);
  if (checks.targetSeen || checks.goSeen || checks.fileSeen) problems.push('before a file, only the start screen should show (target, Compress or a file row is showing)');
  if (checks.promise !== 'Nothing is uploaded, and your originals are never touched.') problems.push('footer promise is wrong: ' + checks.promise);
  if (!/^Powered by PonderDev$/.test(checks.poweredBy)) problems.push('footer credit is wrong: ' + checks.poweredBy);
  if (!checks.hasLicences) problems.push('no licences link, which the GPL notices need');
  if (!fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'licenses.html'))) {
    problems.push('licenses.html missing, run: node scripts/make-licenses.mjs');
  }

  // The skill line under the drop zone: Copy skill hands the app's own
  // SKILL.md, read by main, to the page's clipboard, and What's this? has a way
  // to the page. An offscreen window is never focused, and the clipboard
  // refuses an unfocused page, so the write is caught in the page instead of
  // landing on this machine's clipboard.
  const skillFile = fs.readFileSync(path.join(__dirname, '..', 'agents', 'skills', 'justfits', 'SKILL.md'), 'utf8');
  const skill = await win.webContents.executeJavaScript(`(async () => { ${seen}
    const line = document.querySelector('#start .k-skill');
    const buttons = line ? [...line.querySelectorAll('button')] : [];
    const copy = buttons.find((b) => b.textContent === 'Copy skill');
    let written = null;
    navigator.clipboard.writeText = async (t) => { written = t; };
    const out = {
      line: seen(line) && line.textContent,
      bridge: typeof window.fits.skillText === 'function' && typeof window.fits.openHowItWorks === 'function',
      text: await window.fits.skillText(),
    };
    if (copy) { copy.click(); await new Promise((r) => setTimeout(r, 300)); out.copied = copy.textContent; }
    out.written = written;
    return out;
  })()`);
  if (!skill.bridge) problems.push('the bridge has no skillText or openHowItWorks');
  if (!skill.line || !/^Use it with your assistant.*Copy skill.*What's this\?$/.test(skill.line)) problems.push('the skill line is not under the drop zone: ' + skill.line);
  if (skill.text !== skillFile) problems.push('skillText did not return the shipped SKILL.md');
  if (skill.copied !== 'Copied' || skill.written !== skillFile) problems.push(`Copy skill did not copy SKILL.md (button said ${skill.copied})`);

  // A picture, through the real probe handler: it lands in the file row and
  // only then do the settings and Compress come in. At 10 MB it already fits,
  // which the done card says without offering a file to show; Start again goes
  // back to the start screen.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-'));
  const png = path.join(dir, 'dot.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const landed = await win.webContents.executeJavaScript(`(async () => { ${seen}
    await take(${JSON.stringify(png)});
    const out = {
      landed: document.getElementById('start').classList.contains('landed'),
      zone: seen(document.querySelector('#start .k-zone')),
      name: document.querySelector('#start .k-file-name').textContent,
      facts: document.querySelector('#start .k-file-facts').textContent,
      icon: document.querySelector('#start .k-file > svg').dataset.icon,
      target: seen(document.getElementById('target')),
      go: seen(document.getElementById('go')) && !document.getElementById('go').disabled,
      aim: seen(document.getElementById('aim')),
    };
    document.getElementById('go').click();
    await new Promise((r) => setTimeout(r, 50));
    out.state = document.getElementById('run').dataset.state;
    out.title = document.querySelector('#run .k-run-done-title').textContent;
    out.done = seen(document.querySelector('#run .k-run-done'));
    out.reveal = seen(document.getElementById('reveal'));
    out.noteAfter = document.getElementById('aim').textContent;
    document.getElementById('again').click();
    out.backToStart = !document.getElementById('start').classList.contains('landed') && seen(document.querySelector('#start .k-zone')) && !seen(document.getElementById('go'));
    return out;
  })()`);
  if (!landed.landed || landed.zone) problems.push('a picture did not replace the drop zone with the file row');
  if (landed.icon !== 'photo') problems.push('a picture should show the photo icon in the file row, saw ' + landed.icon);
  if (landed.name !== 'dot.png' || !/^\d+ (KB|MB) · 1x1$/.test(landed.facts)) problems.push(`file row is wrong: ${landed.name} / ${landed.facts}`);
  if (!landed.target || !landed.go || !landed.aim) problems.push('after a file, the target, the estimate and an enabled Compress should show');
  if (landed.state !== 'done' || !landed.done || landed.title !== 'That already fits.') problems.push(`a file under the limit should say it already fits, saw ${landed.state}: ${landed.title}`);
  if (landed.reveal) problems.push('"Show me the file" shows when no file was made');
  if (landed.noteAfter) problems.push('the estimate stayed above the button beside the done card: ' + landed.noteAfter);
  if (!landed.backToStart) problems.push('Start again did not go back to the start screen');

  // A file that is not a video, through the real probe handler: the window
  // should name it in a sentence, not show ffprobe's line with the whole path,
  // and stay on (or go back to) the start screen.
  const bad = path.join(dir, 'not-a-video.mp4');
  fs.writeFileSync(bad, 'hello');
  const failed = await win.webContents.executeJavaScript(`(async () => { ${seen}
    await take(${JSON.stringify(png)});
    await take(${JSON.stringify(bad)});
    const e = document.querySelector('#start .k-error');
    return { shown: seen(e), text: e.textContent, landed: document.getElementById('start').classList.contains('landed'), go: seen(document.getElementById('go')) };
  })()`);
  tidy(dir);
  if (!failed.shown) problems.push('a file that is not a video showed no error');
  if (failed.text !== 'not-a-video.mp4 is not a video or picture that Just Fits can read.') {
    problems.push('a bad file should be named in a plain sentence, saw: ' + failed.text);
  }
  if (failed.landed || failed.go) problems.push('after a bad file, the previous file and Compress were left showing');

  // A drop anywhere in the window goes to the same intake as the button. A
  // file made in the page has no path on disk, so the intake says so, which
  // shows the drop reached it; the veil is gone once the drop is in. (The veil
  // is fixed, which has no offsetParent, so it is read by hidden.)
  const dropped = await win.webContents.executeJavaScript(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'made-up.mp4', { type: 'video/mp4' }));
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    const veil = !document.querySelector('.k-veil').hidden;
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { veil, after: !document.querySelector('.k-veil').hidden, text: document.querySelector('#start .k-error').textContent };
  })()`);
  if (!dropped.veil || dropped.after) problems.push(`the drag veil should show while a file is held and go on the drop (${dropped.veil}, ${dropped.after})`);
  if (dropped.text !== 'Could not tell where that file is. Try "Choose a file" instead.') problems.push('a drop on the window did not reach the intake: ' + dropped.text);

  // A real folder dropped on the window, through Chromium's own drop path
  // (the same one a drag from Finder, Explorer or a Linux file manager takes),
  // so the path comes from the bridge as it would for a person. The folder
  // comes in whole: its name on the file row, what is in it beside.
  const dropDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-')), 'Dropped folder');
  fs.mkdirSync(dropDir);
  execFileSync(binaries.resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', path.join(dropDir, 'still.png')]);
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.sendCommand('Input.dispatchDragEvent', { type, x: 360, y: 300, data: { items: [], files: [dropDir], dragOperationsMask: 1 } });
  }
  cdp.detach();
  const droppedFolder = await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 50 && !document.getElementById('start').classList.contains('landed'); i++) await new Promise((r) => setTimeout(r, 100));
    return {
      name: document.querySelector('#start .k-file-name').textContent,
      facts: document.querySelector('#start .k-file-facts').textContent,
      error: document.querySelector('#start .k-error').textContent,
    };
  })()`);
  tidy(path.dirname(dropDir));
  if (droppedFolder.name !== 'Dropped folder' || !/^1 picture · \d+(\.\d)? (KB|MB)$/.test(droppedFolder.facts) || droppedFolder.error) {
    problems.push('a folder dropped on the window did not come in: ' + JSON.stringify(droppedFolder));
  }

  // A folder, fitted end to end: a short video and a picture are each fitted
  // to the same small target beside their originals, a file that only looks
  // like a video gets a failed row with its reason, a Mac's AppleDouble file
  // and Just Fits' own earlier result are passed over, and the done card says
  // how it went.
  const ffmpeg = binaries.resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]);
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-')), 'Beach day');
  fs.mkdirSync(path.join(folder, 'more'), { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '1', '-c:v', 'libx264', '-b:v', '3000k', '-pix_fmt', 'yuv420p', path.join(folder, 'clip.mp4')]);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200',
    '-frames:v', '1', path.join(folder, 'more', 'still.png')]);
  fs.writeFileSync(path.join(folder, 'notes.mp4'), 'not a video');
  fs.writeFileSync(path.join(folder, '._clip.mp4'), 'resource fork');
  fs.copyFileSync(path.join(folder, 'clip.mp4'), path.join(folder, 'old-fits.mp4'));
  // already under the target: copied into the results folder as it is
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64',
    '-frames:v', '1', path.join(folder, 'tiny.png')]);
  // A short window (an 800x600 screen leaves about 520 for the page): with a
  // folder in, the settings run past the fold, and Compress stays in view at
  // the foot instead of going below it (decided 2026-11-20).
  {
    const was = win.getContentSize();
    const least = win.getMinimumSize();
    win.setMinimumSize(320, 320);
    win.setContentSize(720, 520);
    await new Promise((r) => setTimeout(r, 300));
    const small = await win.webContents.executeJavaScript(`(async () => {
      await intake([${JSON.stringify(folder)}]);
      await new Promise((r) => setTimeout(r, 200));
      const app = document.getElementById('app') || document.scrollingElement;
      const b = document.getElementById('go').getBoundingClientRect();
      const box = (document.getElementById('app') || document.body).getBoundingClientRect();
      return { bottom: Math.round(b.bottom), top: Math.round(b.top), view: Math.round(Math.min(innerHeight, box.bottom)), scrolls: app.scrollHeight > app.clientHeight };
    })()`);
    win.setMinimumSize(...least);
    win.setContentSize(...was);
    if (!small.scrolls) problems.push('the short-window check did not make the settings run past the fold: ' + JSON.stringify(small));
    if (small.bottom > small.view || small.top < 0) problems.push('in a short window Compress is out of view: ' + JSON.stringify(small));
  }

  const many = await win.webContents.executeJavaScript(`(async () => { ${seen}
    await intake([${JSON.stringify(folder)}]);
    const out = {
      name: document.querySelector('#start .k-file-name').textContent,
      facts: document.querySelector('#start .k-file-facts').textContent,
      go: seen(document.getElementById('go')) && !document.getElementById('go').disabled,
    };
    const custom = document.getElementById('custom');
    custom.value = '0.1';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('go').click();
    // nothing measured yet: the bar sweeps rather than sitting at nothing
    out.sweep = document.querySelector('#run .k-run-bar').classList.contains('unknown');
    await new Promise((r) => setTimeout(r, 50));
    out.working = document.querySelector('#run .k-run-what').textContent;
    for (let i = 0; i < 600 && document.getElementById('run').dataset.state === 'working'; i++) await new Promise((r) => setTimeout(r, 100));
    out.state = document.getElementById('run').dataset.state;
    out.rows = [...document.querySelectorAll('#run .k-run-queue li')].map((li) => [li.dataset.q, li.querySelector('.k-q-name').textContent, (li.querySelector('.k-q-note') || {}).textContent || '']);
    out.title = document.querySelector('#run .k-run-done-title').textContent;
    out.detail = document.querySelector('#run .k-run-done-detail').textContent;
    out.where = document.querySelector('#run .k-run-done-where').textContent;
    out.reveal = seen(document.getElementById('reveal'));
    out.revealText = document.getElementById('reveal').textContent;
    out.queueSeen = seen(document.querySelector('#run .k-run-queue'));
    return out;
  })()`);
  const list = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort() : [];
  const results = folder + ' (fitted)';
  const made = list(results);
  const untouched = list(folder);
  if (many.name !== 'Beach day' || !/^1 video, 2 pictures, 1 it cannot read · \d+(\.\d)? (KB|MB)$/.test(many.facts)) problems.push(`a folder's file row is wrong: ${many.name} / ${many.facts}`);
  if (!many.go) problems.push('a folder in should bring in an enabled Compress');
  if (!many.sweep) problems.push('before anything is measured the bar should sweep (in progress), not sit at nothing');
  if (!/^Fitting 1 of 4$/.test(many.working)) problems.push('a batch run should say which file of how many: ' + many.working);
  if (many.state !== 'done') problems.push('the folder run did not finish: ' + many.state);
  const want = [
    ['done', 'clip.mp4', /^\d+(\.\d)? (KB|MB) to \d+ KB$/],
    ['done', 'still.png', /^\d+(\.\d)? (KB|MB) to \d+ KB$/],
    ['failed', 'notes.mp4', /^Not a video or picture Just Fits can read$/],
    ['done', 'tiny.png', /^Already small enough, copied in$/],
  ];
  const rowsOk = many.rows.length === 4 && want.every(([q, name, note], i) => many.rows[i][0] === q && many.rows[i][1] === name && note.test(many.rows[i][2]));
  if (!rowsOk || !many.queueSeen) problems.push('the queue rows are wrong: ' + JSON.stringify(many.rows));
  if (many.title !== 'Done. 2 fitted, 1 already small enough, 1 could not be read or fitted.') problems.push('the folder done line is wrong: ' + many.title);
  if (!/^\d+(\.\d)? (KB|MB) to \d+ KB in \d+ seconds?$/.test(many.detail)) problems.push('the folder detail line is wrong: ' + many.detail);
  // A folder's results go into a new folder beside it, named for what was
  // done, its subfolders mirrored and the folder itself untouched (decided
  // 2026-11-20); Show me the folder opens it.
  if (many.where !== 'Saved 3 files in Beach day (fitted)' || !many.reveal || many.revealText !== 'Show me the folder') problems.push(`the folder where line or Show me the folder is wrong: ${many.where} / ${many.reveal} / ${many.revealText}`);
  if (made.join(',') !== 'clip-fits.mp4,more,more/still-fits.jpg,tiny-fits.png') problems.push('the results folder should hold clip-fits.mp4, more/still-fits.jpg and tiny-fits.png: ' + made.join(', '));
  if (untouched.join(',') !== '._clip.mp4,clip.mp4,more,more/still.png,notes.mp4,old-fits.mp4,tiny.png') problems.push('the folder itself was changed: ' + untouched.join(', '));

  // The same folder again: a new results folder, never into the first; and
  // the setting shows only with a folder in, saying where they go.
  const again2 = await win.webContents.executeJavaScript(`(async () => { ${seen}
    document.getElementById('again').click();
    await intake([${JSON.stringify(folder)}]);
    const out = { field: seen(document.getElementById('where-field')), hint: document.getElementById('where-hint').textContent, ticked: document.getElementById('beside').checked };
    document.getElementById('go').click();
    for (let i = 0; i < 600 && document.getElementById('run').dataset.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    out.where = document.querySelector('#run .k-run-done-where').textContent;
    return out;
  })()`);
  if (!again2.field || again2.ticked || again2.hint !== 'Otherwise they go in a new folder beside it, Beach day (fitted), and the folder itself is left as it is.') problems.push('the Save next to the originals setting is wrong with a folder in: ' + JSON.stringify(again2));
  if (again2.where !== 'Saved 3 files in Beach day (fitted) 2' || list(results + ' 2').join(',') !== 'clip-fits.mp4,more,more/still-fits.jpg,tiny-fits.png') problems.push('a second run should go into Beach day (fitted) 2: ' + again2.where + ' / ' + list(results + ' 2').join(', '));

  // Save next to the originals instead: each result beside its original as
  // name-fits, as before; the choice is kept for next time.
  const beside = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('again').click();
    await intake([${JSON.stringify(folder)}]);
    const box = document.getElementById('beside');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const hint = document.getElementById('where-hint').textContent;
    document.getElementById('go').click();
    for (let i = 0; i < 600 && document.getElementById('run').dataset.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    const where = document.querySelector('#run .k-run-done-where').textContent;
    const reveal = document.getElementById('reveal').textContent;
    document.getElementById('again').click();
    const kept = settings.get('beside');
    settings.set('beside', false);
    return { hint, where, reveal, kept };
  })()`);
  const besideMade = list(folder);
  tidy(path.dirname(folder));
  if (beside.where !== 'Saved next to each original' || beside.reveal !== 'Show me the file' || !beside.kept || beside.hint !== 'Each one is saved beside its original, as name-fits.') problems.push('Save next to the originals is wrong: ' + JSON.stringify(beside));
  for (const f of ['clip-fits.mp4', 'more/still-fits.jpg']) if (!besideMade.includes(f)) problems.push(`${f} was not saved beside its original: ${besideMade.join(', ')}`);
  if (besideMade.includes('old-fits-fits.mp4') || besideMade.includes('notes-fits.mp4') || besideMade.includes('tiny-fits.png')) problems.push('an earlier result or an unreadable file was fitted: ' + besideMade.join(', '));

  const problemsBeforeCancel = problems.length;
  // Cancel stops a folder run at once (decided 2026-11-20): the video being
  // fitted is stopped, no half-written result is left, and nothing after it
  // starts. Start again first, so the run part is back to the start.
  await win.webContents.executeJavaScript(`document.getElementById('again').click()`);
  const folder2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-')), 'Stop me');
  fs.mkdirSync(folder2);
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4000k', '-pix_fmt', 'yuv420p', path.join(folder2, 'a-long.mp4')]);
  for (const n of ['b.png', 'c.png']) execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200',
    '-frames:v', '1', path.join(folder2, n)]);
  const stop = await win.webContents.executeJavaScript(`(async () => {
    await intake([${JSON.stringify(folder2)}]);
    const custom = document.getElementById('custom');
    custom.value = '0.1';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('go').click();
    await new Promise((r) => setTimeout(r, 400));
    const before = document.getElementById('run').dataset.state;
    const t0 = Date.now();
    document.getElementById('cancel').click();
    for (let i = 0; i < 100 && document.getElementById('run').dataset.state === 'working'; i++) await new Promise((r) => setTimeout(r, 50));
    return {
      before,
      ms: Date.now() - t0,
      state: document.getElementById('run').dataset.state,
      title: document.querySelector('#run .k-run-done-title').textContent,
      rows: [...document.querySelectorAll('#run .k-run-queue li')].map((li) => [li.dataset.q, li.querySelector('.k-q-name').textContent, (li.querySelector('.k-q-note') || {}).textContent || '']),
    };
  })()`);
  const left = fs.readdirSync(folder2).sort();
  const beside2 = fs.readdirSync(path.dirname(folder2)).sort();
  tidy(path.dirname(folder2));
  if (beside2.join(',') !== 'Stop me') problems.push('a stopped run left a results folder behind: ' + beside2.join(', '));
  if (stop.before !== 'working') problems.push('the long folder run had already ended before Cancel: ' + stop.before);
  if (stop.state !== 'done' || stop.ms > 3000) problems.push(`Cancel did not stop the folder run at once: ${stop.state} after ${stop.ms} ms`);
  if (stop.title !== 'Stopped. None of the 3 files were changed.') problems.push('the stopped line is wrong: ' + stop.title);
  // the video that was being fitted says it was stopped, not that it never started; the rest never started
  const rowsSay = stop.rows.map((r) => r[1] + ': ' + r[2]).join(' / ');
  if (!(stop.rows.length === 3 && stop.rows.every((r) => r[0] === 'waiting')) || rowsSay !== 'a-long.mp4: Stopped part way, nothing kept / b.png: Not started / c.png: Not started') problems.push('after Cancel the rows are wrong: ' + JSON.stringify(stop.rows));
  if (left.join(',') !== 'a-long.mp4,b.png,c.png') problems.push('Cancel left something behind: ' + left.join(', '));
  // Named in the output, so a reader of the log can see this case was run and how it went.
  console.log(`${problems.length === problemsBeforeCancel ? 'ok' : 'not ok'} - Cancel stops a folder run at once: the file being fitted is left as it was, nothing is kept half-written, no more are started`);

  // Windows and Linux pickers cannot take files and folders in one, so there
  // the start screen has Choose a folder; a Mac's picker takes both.
  const folderButton = await win.webContents.executeJavaScript(`(() => { const b = document.getElementById('browse-folder'); return b ? b.textContent : null; })()`);
  if (process.platform === 'darwin' ? folderButton !== null : folderButton !== 'Choose a folder') problems.push(`Choose a folder on ${process.platform}: ${folderButton}`);
  // Once a folder is in, the file row changes it the same two ways there
  // (Change file, Change folder), so a folder can be swapped for another
  // folder without Start again; a Mac keeps the one Change.
  const row = await win.webContents.executeJavaScript(`(() => {
    const seen = (n) => !!n && !!n.offsetParent;
    const c = document.getElementById('change'), f = document.getElementById('change-folder');
    return { change: seen(c) && c.textContent, folder: f ? seen(f) && f.textContent : null };
  })()`);
  if (process.platform === 'darwin' ? (row.change !== 'Change' || row.folder !== null) : (row.change !== 'Change file' || row.folder !== 'Change folder')) problems.push(`the file row's change buttons on ${process.platform}: ${JSON.stringify(row)}`);

  // A drop while a file is being fitted is refused: no veil is drawn for it
  // (the kit's `when`), so a drop is never taken and then ignored.
  const busyDrop = await win.webContents.executeJavaScript(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'made-up.mp4', { type: 'video/mp4' }));
    const veilOn = () => !document.querySelector('.k-veil').hidden;
    start.error('');
    busy = true;
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    const during = veilOn();
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    const out = { during, error: document.querySelector('#start .k-error').textContent };
    busy = false;
    document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    out.idle = veilOn();
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    return out;
  })()`);
  if (busyDrop.during) problems.push('the drag veil showed while a file was being fitted');
  if (!busyDrop.idle) problems.push('the drag veil did not come back once the run was over');
  if (busyDrop.error) problems.push('a drop during a run was taken: ' + busyDrop.error);

  // A failed card belonged to the old limit: changing the target clears it,
  // as it does a done card.
  const failedCard = await win.webContents.executeJavaScript(`(async () => {
    run.failed('Something went wrong');
    const before = document.getElementById('run').dataset.state;
    const select = document.getElementById('target');
    select.value = TARGETS[1].id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = TARGETS[0].id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: document.getElementById('run').dataset.state };
  })()`);
  if (failedCard.before !== 'failed' || failedCard.after !== 'idle') problems.push('a new target should clear a failed card: ' + JSON.stringify(failedCard));

  // The title strip: under the traffic lights on a Mac; on Windows and Linux
  // the app's own dark title bar, the system buttons' height, with the
  // window's name in it (the kit's frame, decided 2026-11-20).
  const strip = await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.titlebar'); const n = t && t.querySelector('.k-titlebar-name');
    return t ? { h: t.offsetHeight, name: n ? n.textContent : null, title: document.title, drag: getComputedStyle(t).webkitAppRegion || getComputedStyle(t).getPropertyValue('-webkit-app-region') } : null; })()`);
  if (process.platform === 'darwin') { if (!strip || strip.h !== 28 || strip.name !== null) problems.push(`the title strip on a Mac: ${JSON.stringify(strip)}`); }
  else if (!strip || strip.h !== 32 || strip.name !== strip.title || !strip.title) problems.push(`the title bar on ${process.platform}: ${JSON.stringify(strip)}`);

  // The window says a too-long video in the command line's words.
  const longDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-'));
  const longClip = path.join(longDir, 'long.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '3000k', '-pix_fmt', 'yuv420p', longClip]);
  const longRun = await win.webContents.executeJavaScript(`window.fits.fit(${JSON.stringify(longClip)}, 40000)`);
  tidy(longDir);
  if (!/^This is too long for that size: expect a small, blurry picture/.test(longRun.note || '')) problems.push('a too-long video should come back with the shared note: ' + JSON.stringify(longRun.note));

  // The Done card says where the output went, since there is no Save window.
  const where = await win.webContents.executeJavaScript(`[
    whereText('C:\\\\Users\\\\pnd\\\\Documents\\\\Desk\\\\long-fits.mp4'),
    whereText('C:\\\\long-fits.mp4'),
    whereText('/media/me/Movies/clip-fits.mp4'),
  ]`);
  const expected = [
    'Saved as long-fits.mp4, next to the original in C:\\Users\\pnd\\Documents\\Desk',
    'Saved as long-fits.mp4, next to the original in C:\\',
    'Saved as clip-fits.mp4, next to the original in /media/me/Movies',
  ];
  where.forEach((w, i) => { if (w !== expected[i]) problems.push(`Done card location: expected "${expected[i]}", saw "${w}"`); });

  if (shot) {
    fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  }

  console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'window ok: ' + JSON.stringify(checks));
  app.exit(problems.length ? 1 : 0);
});

setTimeout(() => { console.error('timed out'); app.exit(2); }, 90000);
