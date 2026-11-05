#!/usr/bin/env node
// v0.4.3 regression test: the version BADGE at the top right of the
// header (next to the language switcher) exists on all 4 pages, and
// every CURRENT-version display across the site (badge, page titles,
// intro line, footer "Version:" line, README current-version line)
// agrees on the same version — the one this release ships.
// Historical mentions (changelog entries, dated snapshots such as
// "v0.4.2 時点") are NOT current-version displays and are excluded.
// Run: node test-v043.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');

const EXPECTED = 'v0.4.3';
const pages = {
  'index.html': read('index.html'),
  'en.html': read('en.html'),
  'home.html': read('home.html'),
  'home-en.html': read('home-en.html'),
};
const readme = read('README.md');

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

// --- (1) the badge: present once per page, styled, inside the header
//         next to the language switcher (after .langsw, before </header>)
for (const [name, html] of Object.entries(pages)) {
  const badge = `<span class="verbadge">${EXPECTED}</span>`;
  check(`${name}: version badge ${EXPECTED} present exactly once`, html.split(badge).length - 1 === 1);
  check(`${name}: .verbadge pill CSS defined`, html.includes('.verbadge{'));
  const iLang = html.indexOf('class="langsw"');
  const iBadge = html.indexOf(badge);
  const iHeadEnd = html.indexOf('</header>');
  check(`${name}: badge sits in the header next to the language switcher`,
    iLang >= 0 && iBadge > iLang && (iHeadEnd < 0 || iBadge < iHeadEnd),
    `langsw@${iLang} badge@${iBadge} headerEnd@${iHeadEnd}`);
}

// --- (2) every current-version display agrees
const displays = {}; // label -> version string found
for (const [name, html] of Object.entries(pages)) {
  const m = html.match(/<span class="verbadge">(v[\d.]+)<\/span>/);
  displays[`${name} badge`] = m && m[1];
  const f = html.match(/(?:バージョン：|Version: )<b>(v[\d.]+)<\/b>/);
  displays[`${name} footer`] = f && f[1];
}
const tJp = pages['index.html'].match(/<title>[^<]*?(v[\d.]+)<\/title>/);
displays['index.html title'] = tJp && tJp[1];
const tEn = pages['en.html'].match(/<title>[^<]*?(v[\d.]+)<\/title>/);
displays['en.html title'] = tEn && tEn[1];
const iJp = pages['index.html'].match(/Cosmos側・(v[\d.]+)）/);
displays['index.html intro'] = iJp && iJp[1];
const iEn = pages['en.html'].match(/Cosmos side, (v[\d.]+)\)/);
displays['en.html intro'] = iEn && iEn[1];
const r = readme.match(/現在のバージョン：(v[\d.]+)/);
displays['README current version'] = r && r[1];

for (const [label, v] of Object.entries(displays)) {
  check(`display agrees: ${label}`, v === EXPECTED, String(v));
}
const distinct = new Set(Object.values(displays));
check('all current-version displays agree with each other', distinct.size === 1 && distinct.has(EXPECTED), [...distinct].join(','));

process.exit(fails ? 1 : 0);
