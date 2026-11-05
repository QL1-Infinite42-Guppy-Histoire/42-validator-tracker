#!/usr/bin/env node
// v0.5.3 regression test (rewritten from the v0.3.1 estimated-definition
// test): the estimated tier is RETIRED. The definition block, the "show
// estimated" toggle, the estimated badge/styles and every estimated
// wording must be GONE from all 16 pages, the watchlist must contain no
// estimated entries, and no stored event may carry the estimated tier.
// The site definition must now state the depth-1-only scope.
// Run: node test-estdef.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

// --- data truth ---
const w = JSON.parse(read('watchlist.json'));
const est = (w.entries || []).filter((e) => e.tier === 'estimated');
check('watchlist estimated total = 0 (tier retired in v0.5.3)', est.length === 0, String(est.length));
check('watchlist summary estimated = 0', w.summary.estimated === 0, String(w.summary.estimated));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
check('no stored event has an estimated actor', events.every((e) => e.actorTier !== 'estimated'), String(events.filter((e) => e.actorTier === 'estimated').length));

// --- every page: estimated UI is gone ---
const TRACKERS = ['index.html', 'en.html', 'zh.html', 'es.html', 'hi.html', 'ar.html', 'pt.html', 'fr.html'];
const HOMES = ['home.html', 'home-en.html', 'home-zh.html', 'home-es.html', 'home-hi.html', 'home-ar.html', 'home-pt.html', 'home-fr.html'];
for (const f of [...TRACKERS, ...HOMES]) {
  const html = read(f);
  check(`${f}: no estimated-def block or deep-link`, !html.includes('estimated-def'));
  check(`${f}: no fEstimated toggle`, !html.includes('fEstimated'));
  check(`${f}: no estimated badge/style`, !html.includes('.badge.estimated') && !html.includes('.ev.estimated'));
  check(`${f}: version badge v0.6.0`, html.includes('<span class="verbadge">v0.6.0</span>'));
}
// JP/EN wording spot checks
const jp = read('index.html'), en = read('en.html');
check('index.html: 推定関連の定義 survives only as the v0.3.1 changelog mention', jp.split('推定関連の定義').length - 1 === 1 && jp.includes('推定関連の定義を「最新の動き」の欄'), String(jp.split('推定関連の定義').length - 1));
check('en.html: no estimated-relations definition wording', !en.includes('Definition: what "estimated relations" means'));
check('index.html: depth-1-only definition present', jp.includes('このサイトはバリデーター本人と、直接の取引で結ばれた関連アドレスだけを追います'));
check('en.html: depth-1-only definition present', en.includes('This site tracks only the validators themselves and the related addresses linked to them by direct transactions'));

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
