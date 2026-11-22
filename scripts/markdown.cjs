'use strict';

/*
 * Just enough Markdown for THIRD-PARTY-NOTICES.md: headings, rules, paragraphs,
 * bullet and numbered lists, tables, fenced code, and `code`, **bold**, *italic*
 * and links within a line. Everything is escaped first. A link is written out as
 * its text and its address in brackets, never as a link: the licences window has
 * no network, and a click would take the window itself away from the page.
 */

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const blank = (l) => !l.trim();
  // A line that ends a paragraph. Only "1." starts a numbered list inside one
  // (as in Markdown itself), so "15 November\n2026. Publishers..." stays text.
  const special = (l) => /^(#{1,6} |---+$|```|\s*[-*] |\s*1\. |\|)/.test(l);
  const itemLine = /^\s*([-*]|\d+\.) /;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    let m;
    if (/^```/.test(line)) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre class="code">${esc(body.join('\n'))}</pre>`);
    } else if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
      i++;
    } else if (/^---+$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (/^\|/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i].replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()));
      const [head, , ...body] = rows;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
    } else if (/^\s*([-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const first = ordered ? Number(/^\s*(\d+)\./.exec(line)[1]) : 1;
      const items = [];
      while (i < lines.length && itemLine.test(lines[i])) {
        let text = lines[i].replace(itemLine, '');
        for (i++; i < lines.length && !blank(lines[i]) && !special(lines[i]) && !itemLine.test(lines[i]); i++) text += ' ' + lines[i].trim();
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(ordered ? `<ol${first === 1 ? '' : ` start="${first}"`}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else {
      let text = line.trim();
      for (i++; i < lines.length && !blank(lines[i]) && !special(lines[i]); i++) text += ' ' + lines[i].trim();
      out.push(`<p>${inline(text)}</p>`);
    }
  }
  return out.join('\n');
}

module.exports = { render, esc };
