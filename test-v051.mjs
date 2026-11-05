#!/usr/bin/env node
// v0.5.1 regression test: the header layout fix.
// Bug (v0.5.0, user screenshot): .head-row was a horizontal flex row
// (justify-content:space-between) containing the <h1> title and the
// .langsw language switcher. .langsw had white-space:nowrap, so with
// 8 languages its flex min-content width (~600px+) starved the h1;
// Japanese text (breakable between any two characters, min-content =
// 1 char) collapsed the title into a 1-character-wide vertical strip,
// and the switcher overflowed off the right edge (Português cut off).
// Fix asserted here for ALL 16 pages:
//   - .head-row stacks vertically (flex-direction:column): the title
//     always owns a full-width row, the switcher sits on its own row
//     below it — the title is no longer a flex-shrunk row sibling.
//   - .langsw is a wrapping flex container (flex-wrap:wrap) with no
//     white-space:nowrap and max-width:100%: it wraps to multiple
//     lines instead of overflowing horizontally.
//   - The switcher's individual items (language names, badge) are
//     short unbreakable tokens, so wrapping always succeeds at 360px.
// The managed headless Chromium in this environment refuses to start
// (WebGL domain policy), so the guarantee is structural: with the
// column stack + wrapping switcher there is no CSS mechanism left
// that can compress the title or force horizontal overflow from the
// header. Run: node test-v051.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');

const PAGES = ['index.html', 'en.html', 'zh.html', 'es.html', 'hi.html', 'ar.html', 'pt.html', 'fr.html',
  'home.html', 'home-en.html', 'home-zh.html', 'home-es.html', 'home-hi.html', 'home-ar.html', 'home-pt.html', 'home-fr.html'];

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const rule = (html, sel) => {
  const m = html.match(new RegExp('\\' + sel + '\\{([^}]*)\\}'));
  return m && m[1];
};

for (const name of PAGES) {
  const html = read(name);
  const hr = rule(html, '.head-row');
  check(`${name}: .head-row rule exists`, !!hr);
  check(`${name}: .head-row stacks vertically (title gets its own full-width row)`,
    !!hr && hr.includes('flex-direction:column'), hr || '');
  check(`${name}: .head-row is not a space-between row (title cannot be flex-shrunk by the switcher)`,
    !!hr && !hr.includes('space-between') && !hr.includes('flex-direction:row'), hr || '');
  const ls = rule(html, '.langsw');
  check(`${name}: .langsw rule exists`, !!ls);
  check(`${name}: .langsw wraps (flex-wrap:wrap, no nowrap, max-width:100%)`,
    !!ls && ls.includes('flex-wrap:wrap') && !ls.includes('white-space:nowrap') && ls.includes('max-width:100%'), ls || '');
  // structure: h1 and .langsw both live inside .head-row, title first
  const iRow = html.indexOf('class="head-row"');
  const iH1 = html.indexOf('<h1>', iRow);
  const iLang = html.indexOf('class="langsw"', iRow);
  const iRowEnd = html.indexOf('</div>', iLang);
  check(`${name}: title precedes switcher inside the stacked header row`,
    iRow >= 0 && iH1 > iRow && iLang > iH1 && iRowEnd > iLang,
    `row@${iRow} h1@${iH1} langsw@${iLang}`);
  // every switcher item is a short unbreakable token (wrapping can always break between items)
  const seg = html.slice(iLang, html.indexOf('</div>', iLang));
  const labels = [...seg.matchAll(/>([^<>|]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  const longest = Math.max(...labels.map((t) => [...t].length));
  check(`${name}: longest unbreakable switcher token is short (<= 12 chars)`, longest <= 12, labels.join(' / '));
  // badge still inside the switcher, in the header
  check(`${name}: version badge inside switcher`, seg.includes('class="verbadge"'));
  if (name.includes('ar')) {
    check(`${name}: RTL page keeps dir=rtl with the same stacked header`, html.includes('dir="rtl"'));
  }
}

process.exit(fails ? 1 : 0);
