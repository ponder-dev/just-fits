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
  const win = new BrowserWindow({
    width: 720, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) problems.push('console: ' + message);
  });
  win.webContents.on('preload-error', (_e, file, err) => {
    problems.push(`preload ${file}: ${err.message}`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const checks = await win.webContents.executeJavaScript(`(() => ({
    bridge: typeof window.fits === 'object' && typeof window.fits.fit === 'function',
    pathFor: typeof window.fits.pathFor === 'function',
    targets: document.querySelectorAll('#target option').length,
    groups: document.querySelectorAll('#target optgroup').length,
    aim: document.getElementById('aim').textContent,
    goDisabled: document.getElementById('go').disabled,
    styled: getComputedStyle(document.body).backgroundColor,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    dropVisible: !document.getElementById('drop').hidden,
    poweredBy: document.getElementById('site').innerText.trim(),
    hasLicences: !!document.getElementById('licences'),
  }))()`);

  if (!checks.bridge) problems.push('preload did not expose window.fits');
  if (!checks.pathFor) problems.push('pathFor missing, drag and drop would break');
  if (checks.targets < 10) problems.push(`expected the full preset list, saw ${checks.targets}`);
  if (checks.groups < 3) problems.push(`presets should be grouped, saw ${checks.groups} groups`);
  if (!/aiming for/.test(checks.aim)) problems.push('no target is shown on load: ' + checks.aim);
  if (!checks.goDisabled) problems.push('Compress should start disabled, with no file chosen');
  if (checks.styled === 'rgba(0, 0, 0, 0)') problems.push('stylesheet did not apply, check the CSP');
  if (!checks.dropVisible) problems.push('the drop zone is not showing');
  if (!/^Powered by PonderDev$/.test(checks.poweredBy)) problems.push('footer credit is wrong: ' + checks.poweredBy);
  if (!checks.hasLicences) problems.push('no licences link, which the GPL notices need');
  if (!fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'licenses.html'))) {
    problems.push('licenses.html missing, run: node scripts/make-licenses.mjs');
  }

  // A file that is not a video, through the real probe handler: the window
  // should name it in a sentence, not show ffprobe's line with the whole path.
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-window-')), 'not-a-video.mp4');
  fs.writeFileSync(bad, 'hello');
  const failed = await win.webContents.executeJavaScript(`(async () => {
    await take(${JSON.stringify(bad)});
    const e = document.getElementById('error');
    return { shown: !e.hidden, text: e.textContent };
  })()`);
  fs.rmSync(path.dirname(bad), { recursive: true, force: true });
  if (!failed.shown) problems.push('a file that is not a video showed no error');
  if (failed.text !== 'not-a-video.mp4 is not a video or picture that Just Fits can read.') {
    problems.push('a bad file should be named in a plain sentence, saw: ' + failed.text);
  }

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

setTimeout(() => { console.error('timed out'); app.exit(2); }, 30000);
