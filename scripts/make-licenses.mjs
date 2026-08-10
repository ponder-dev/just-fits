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
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  pre.notices { white-space:pre-wrap; font:inherit; color:#c3c8d8; }
  details { border:1px solid #2c2f3d; border-radius:9px; margin:8px 0; background:#191b24; }
  summary { padding:9px 14px; cursor:pointer; font-weight:600; }
  details pre { margin:0; padding:0 14px 14px; max-height:340px; overflow:auto;
                white-space:pre-wrap; font:11px/1.5 ui-monospace, Menlo, monospace; color:#9aa0b4; }
</style></head>
<body>
<h1>Licences and credits</h1>
<pre class="notices">${esc(notices)}</pre>
<h2>Full licence texts</h2>
${sections.join('\n')}
</body></html>
`;

await fs.writeFile(path.join(root, 'src/renderer/licenses.html'), html);
console.log(`src/renderer/licenses.html written, ${files.length} licence texts`);
