#!/usr/bin/env node
// v0.3.1 regression test: the on-site DEFINITION of estimated relations
// (推定関連) must exist on both tracker pages, sit next to the "show
// estimated" toggle, state the three bases + handling rules + current
// counts, and those counts must match watchlist.json. Home pages must
// carry the one-line link to the definition.
// Run: node test-estdef.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
const jp = read('index.html'), en = read('en.html'), home = read('home.html'), homeEn = read('home-en.html');

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

// --- data truth: counts printed on the pages must match watchlist.json ---
const w = JSON.parse(read('watchlist.json'));
const est = (w.entries || []).filter((e) => e.tier === 'estimated');
const byBasis = {};
for (const e of est) byBasis[e.basisType] = (byBasis[e.basisType] || 0) + 1;
check('watchlist estimated total = 6', est.length === 6, String(est.length));
check('watchlist estimated pool = 5', byBasis.pool === 5, String(byBasis.pool || 0));
check('watchlist estimated shared = 1', byBasis.shared === 1, String(byBasis.shared || 0));
check('watchlist estimated 2hop = 0', !byBasis['2hop'], String(byBasis['2hop'] || 0));

// --- JP definition block ---
check('index.html: definition block exists', jp.includes('id="estimated-def"') && jp.includes('推定関連の定義'));
check('index.html: definition sits after the estimated toggle', jp.indexOf('id="fEstimated"') > -1 && jp.indexOf('id="estimated-def"') > jp.indexOf('id="fEstimated"'));
for (const [label, s] of [
  ['what it is (no confirmed direct transfer)', '直接お金を送り合った記録が確認できていない'],
  ['not a conclusion', '断定するものではありません'],
  ['basis 1 through-pool', 'プール経由の推定'],
  ['pool window 24h / 10%', '24時間以内・金額差10%以内'],
  ['score explained', 'スコア（近さの度合いを表す数値で、1に近いほど確からしい）'],
  ['basis shown on cards', 'カードに必ず文章で表示されます'],
  ['basis 2 shared counterparty', '共通の相手先'],
  ['shared = 2+ validators, not concluded related', '「関係者」とまでは断定できないため、推定の扱いにしています'],
  ['basis 3 2-hop', '2ホップ経由'],
  ['2-hop honestly none registered', 'この種別で新しく登録されたアドレスはありません'],
  ['handling: dashed + badge, toggle hides', '点線の枠と「推定」バッジ付きで表示され'],
  ['handling: special sections excluded', 'スナイプ速報・注目・インサイダー・ブリッジ出金とその総額グラフには推定を一切含めません'],
  ['counts stated', '推定関連は6件です（プール経由5件・共通の相手先1件'],
  ['counts dated as v0.4.1 snapshot', 'v0.4.1 時点'],
]) check(`index.html definition: ${label}`, jp.includes(s));

// --- EN definition block ---
check('en.html: definition block exists', en.includes('id="estimated-def"') && en.includes('Definition: what "estimated relations" means'));
check('en.html: definition sits after the estimated toggle', en.indexOf('id="fEstimated"') > -1 && en.indexOf('id="estimated-def"') > en.indexOf('id="fEstimated"'));
for (const [label, s] of [
  ['what it is (no confirmed direct transfer)', 'no direct transfer between that address and the validator has been confirmed'],
  ['not a conclusion', 'only a possibility, never a conclusion'],
  ['separate from confirmed', 'kept strictly separate from the confirmed related addresses'],
  ['basis 1 through-pool', '(1) Through-pool'],
  ['pool window 24h / 10%', 'within 24 hours and within 10% in amount'],
  ['score explained', 'a score (how close the match is; closer to 1 means more likely)'],
  ['basis shown on cards', 'the basis for each address is always written out on that address'],
  ['basis 2 shared counterparty', '(2) Shared counterparty'],
  ['shared = 2+ validators, not concluded related', 'cannot be concluded to be a "related party" of each of those validators'],
  ['basis 3 2-hop', '(3) 2-hop'],
  ['2-hop honestly none registered', 'no address has been newly registered under this type'],
  ['handling: dashed + badge, toggle hides', 'with a dashed border and an "Estimated" badge, and can be hidden'],
  ['handling: special sections excluded', 'never included in the Snipe Alerts, Notable, Insider Watch, or Bridge Withdrawals sections'],
  ['counts stated', '6 estimated addresses (5 through-pool, 1 shared counterparty)'],
  ['counts dated as v0.4.1 snapshot', 'as of v0.4.1'],
]) check(`en.html definition: ${label}`, en.includes(s));

// --- home pages: one-line link + version ---
check('home.html: link to definition', home.includes('href="index.html#estimated-def"') && home.includes('推定関連とは？'));
check('home-en.html: link to definition', homeEn.includes('href="en.html#estimated-def"') && homeEn.includes('What are estimated relations?'));
for (const [name, html] of [['index.html', jp], ['en.html', en], ['home.html', home], ['home-en.html', homeEn]]) {
  check(`${name}: version v0.4.1`, html.includes('v0.4.1'));
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
