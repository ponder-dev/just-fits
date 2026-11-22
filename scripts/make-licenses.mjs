// Generates src/renderer/licenses.html from the files we actually ship.
//
//   node scripts/make-licenses.mjs
//
// Built from THIRD-PARTY-NOTICES.md and licenses/*.txt rather than from a copy
// of them, so the text shown inside the app is always the text on disk. Run it
// after changing either. Just JPEG does the same thing inside its bundle step;
// this app has no bundler, so it is its own script and the output is committed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { render } = createRequire(import.meta.url)('./markdown.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The kit it is built with, said on the page (decided 2026-11-20).
const kitVersion = JSON.parse(await fs.readFile(path.join(root, 'kit.lock'), 'utf8')).kit;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const notices = await fs.readFile(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
const dir = path.join(root, 'licenses');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.txt')).sort();

const sections = [];
for (const file of files) {
  const text = await fs.readFile(path.join(dir, file), 'utf8');
  sections.push(
    `<details><summary>${esc(file.replace(/\.txt$/, ''))}</summary><pre>${esc(text)}</pre></details>`,
  );
}

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Licences and credits</title>
<style>
  body { margin:0; padding:28px 34px; background:#12131a; color:#eceef5;
         font:13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:14px; margin:26px 0 6px; }
  .notices { color:#c3c8d8; }
  .notices h2 { font-size:14px; margin:26px 0 6px; color:#eceef5; }
  .notices h3 { font-size:13px; margin:18px 0 4px; color:#eceef5; }
  .notices h2:first-child { font-size:15px; margin-top:0; }
  .notices p, .notices ul, .notices ol { margin:6px 0; }
  .notices li { margin:3px 0; }
  .notices code { font:11.5px ui-monospace, Menlo, monospace; background:#191b24; padding:1px 4px; border-radius:4px; }
  .notices pre.code { background:#191b24; border:1px solid #2c2f3d; border-radius:9px; padding:10px 14px; overflow:auto; font:11.5px/1.5 ui-monospace, Menlo, monospace; }
  .notices hr { border:0; border-top:1px solid #2c2f3d; margin:20px 0; }
  .notices table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12px; }
  .notices th, .notices td { border:1px solid #2c2f3d; padding:6px 9px; text-align:left; vertical-align:top; }
  .notices th { background:#191b24; }
  details { border:1px solid #2c2f3d; border-radius:9px; margin:8px 0; background:#191b24; }
  summary { padding:9px 14px; cursor:pointer; font-weight:600; }
  details pre { margin:0; padding:0 14px 14px; max-height:340px; overflow:auto;
                white-space:pre-wrap; font:11px/1.5 ui-monospace, Menlo, monospace; color:#9aa0b4; }
</style></head>
<body>
<h1>Licences and credits</h1>
<p>Built with the PonderDev kit ${kitVersion}, the parts every Just tool shares.</p>
<div class="notices">${render(notices)}</div>
<h2>Full licence texts</h2>
${sections.join('\n')}
</body></html>
`;

await fs.writeFile(path.join(root, 'src/renderer/licenses.html'), html);
console.log(`src/renderer/licenses.html written, ${files.length} licence texts`);
