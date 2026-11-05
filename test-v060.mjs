#!/usr/bin/env node
// v0.6.0 regression test: the ⭐ Notable section is replaced by
// 💱 Trading + 💱 Trading (excluding small FISH sells), plus a
// 📈 Trading summary (per-period, per-token buy/sell aggregation).
//  (1) All 8 tracker pages: no sec-alerts / alerts container / notable
//      badge left; the three new sections exist in order (after
//      sec-bridgechart, before sec-lp) and in the nav; the filtered
//      section's rule text (threshold 10 + live excluded count) is
//      wired; the summary's definition states the FISH exclusion.
//  (2) VM render (JP + EN trackers, real feed): the Trading list is
//      exactly the feed's swap-buy/swap-sell events (newest first);
//      the filtered list is the same minus small FISH sells (received
//      amount < 10 in the received currency); the rule element shows
//      the recomputed excluded count; the summary renders one table
//      per period and count-based pies matching feed.stats.trading.
//  (3) feed.stats.trading agrees with the collector's
//      computeTradingStats AND with an independent recomputation from
//      events.jsonl; FISH never appears as a token; every token is on
//      the display whitelist.
//  (4) Threshold rationale re-verified on the full history: FISH sells
//      are overwhelmingly small (median ≈ 2.5; >= 95% receive under 10).
//  (5) Home (JP, VM): the two new portal cards show the recomputed
//      counts.
// Run: node test-v060.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { computeTradingStats } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const TRACKERS = ['index.html', 'en.html', 'zh.html', 'es.html', 'hi.html', 'ar.html', 'pt.html', 'fr.html'];
const feed = JSON.parse(read('feed.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const isSmallFishSell = (ev) => ev.type === 'swap-sell' && ev.sold && ev.sold.symbol === 'FISH' && ev.bought && parseFloat(ev.bought.amount) < 10;
const byRecency = (a, b) => (b.block - a.block) || ((b.logIndex ?? -1) - (a.logIndex ?? -1)) || (b.ts - a.ts);
const trades = feed.events.filter((ev) => (ev.type === 'swap-buy' || ev.type === 'swap-sell') && ev.actorTier !== 'estimated').sort(byRecency);
const fishSmall = trades.filter(isSmallFishSell);
const tradesNf = trades.filter((ev) => !isSmallFishSell(ev));
check('feed carries trades to display', trades.length > 100, `${trades.length} trades, ${fishSmall.length} small FISH sells, ${tradesNf.length} after filter`);

// ---------- (1) static page checks ----------
const FISH_EXCLUDED = {
  'index.html': 'FISH は除いて集計しています', 'en.html': 'FISH is excluded from this summary',
  'zh.html': '本汇总不含 FISH', 'es.html': 'FISH está excluido de este resumen',
  'hi.html': 'इस सारांश में FISH शामिल नहीं है', 'ar.html': 'FISH مستثنى من هذا الملخص',
  'pt.html': 'O FISH está excluído deste resumo', 'fr.html': 'Le FISH est exclu de ce récapitulatif',
};
for (const f of TRACKERS) {
  const html = read(f);
  check(`${f}: no alerts section/container/rule left`, !html.includes('id="sec-alerts"') && !html.includes('id="alerts"') && !html.includes('alertRule') && !html.includes("getElementById('alerts')"));
  check(`${f}: no notable badge left`, !html.includes('badge notable') && !html.includes('${notable'));
  const idx = ['sec-bridgechart', 'sec-trades', 'sec-tradesnf', 'sec-trading', 'sec-lp'].map((id) => html.indexOf(`id="${id}"`));
  check(`${f}: new sections present, in order`, idx.every((v, i) => v > -1 && (i === 0 || v > idx[i - 1])), idx.join(','));
  check(`${f}: nav links to all three new sections`, html.includes('href="#sec-trades"') && html.includes('href="#sec-tradesnf"') && html.includes('href="#sec-trading"'));
  check(`${f}: filtered rule wired (threshold 10 [42] / 10 USDT + count slot)`, html.includes("getElementById('tradesNfRule')") && html.includes('10 [42]') && html.includes('10 USDT') && html.includes('fishSmall.length'));
  check(`${f}: summary definition states the FISH exclusion`, html.includes(FISH_EXCLUDED[f]));
  check(`${f}: summary reads feed.stats.trading`, html.includes('stats.trading'));
}

// ---------- (2) VM render ----------
function runPage(file) {
  const html = read(file);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', checked: true, style: {}, classList: { add() {}, toggle() {} }, addEventListener() {}, appendChild(c) { this.options.push(c); }, querySelector: () => null });
  const sandbox = {
    document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl(), querySelector: () => null, querySelectorAll: () => [] },
    fetch: async () => ({ json: async () => feed }),
    setInterval() {}, console, location: { hash: '', search: '' },
  };
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;globalThis.__api={applyFilters, renderTrading}; globalThis.__setFeed=(f)=>{FEED=f;};', sandbox);
  return { api: sandbox.__api, setFeed: sandbox.__setFeed, els };
}
// Each rendered card links its tx hash twice (headline + tx link);
// collapse consecutive duplicates to get the card sequence.
const hashesOf = (html) => [...html.matchAll(/0x[0-9a-f]{64}/g)].map((m) => m[0]).filter((h, i, a) => i === 0 || h !== a[i - 1]);
for (const f of ['index.html', 'en.html']) {
  const { api, setFeed, els } = runPage(f);
  setFeed(feed);
  api.applyFilters('all');
  api.renderTrading();
  const tHtml = els.trades.innerHTML;
  const nfHtml = els.tradesNofish.innerHTML;
  check(`${f}: trading list renders the first ${Math.min(100, trades.length)} trades in order`, JSON.stringify(hashesOf(tHtml)) === JSON.stringify(trades.slice(0, 100).map((e) => e.txHash.toLowerCase())), `${hashesOf(tHtml).length} cards`);
  check(`${f}: filtered list renders the first ${Math.min(100, tradesNf.length)} filtered trades in order`, JSON.stringify(hashesOf(nfHtml)) === JSON.stringify(tradesNf.slice(0, 100).map((e) => e.txHash.toLowerCase())), `${hashesOf(nfHtml).length} cards`);
  check(`${f}: no small FISH sell card in the filtered list`, trades.slice(0, 100).filter(isSmallFishSell).every((e) => !nfHtml.includes(e.txHash)));
  check(`${f}: rule text shows threshold + recomputed excluded count (${fishSmall.length})`, els.tradesNfRule.textContent.includes('10 [42]') && els.tradesNfRule.textContent.includes('10 USDT') && els.tradesNfRule.textContent.includes(String(fishSmall.length)), els.tradesNfRule.textContent.slice(-40));
  const tg = els.trading.innerHTML;
  const T = feed.stats.trading;
  const expectedPies = ['24h', '7d', '30d'].reduce((n, k) => n + (T[k].buyTotal > 0 ? 1 : 0) + (T[k].sellTotal > 0 ? 1 : 0), 0);
  check(`${f}: summary renders 3 period tables`, (tg.match(/<table class="staking">/g) || []).length === 3);
  check(`${f}: summary renders count-based pies (${expectedPies})`, (tg.match(/<svg class="pie"/g) || []).length === expectedPies, `${(tg.match(/<svg class="pie"/g) || []).length}`);
  check(`${f}: summary shows the 30d totals (buy ${T['30d'].buyTotal} / sell ${T['30d'].sellTotal})`, tg.includes(`(${T['30d'].buyTotal})`) && tg.includes(`(${T['30d'].sellTotal})`));
  check(`${f}: summary has no FISH row`, !tg.includes('<td><b>FISH</b></td>'));
}

// ---------- (3) trading aggregation: collector + independent recomputation ----------
const nowMs = Date.parse(feed.generatedAt);
const direct = computeTradingStats(events, nowMs);
const canon = (t) => JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, w]) => [k, { tokens: Object.fromEntries(Object.entries(w.tokens).sort(([a], [b]) => a.localeCompare(b))), buyTotal: w.buyTotal, sellTotal: w.sellTotal }])));
check('computeTradingStats(events, feed.generatedAt) == feed.stats.trading', canon(direct) === canon(feed.stats.trading));

const WHITELIST_NO_FISH = new Set(['42', 'USDT', 'CAT42', 'ZAP', 'FATHER', 'KET', 'BABY', 'QOM', 'MARVIN', 'O', 'PANIC', 'OSAK', 'FOXXEY', 'BFOXX', 'HAWK', 'CAW']);
for (const [key, spanMs] of [['24h', 86400e3], ['7d', 7 * 86400e3], ['30d', 30 * 86400e3]]) {
  const cutoffSec = Math.floor((nowMs - spanMs) / 1000);
  const tokens = {};
  let buyTotal = 0, sellTotal = 0;
  for (const e of events) {
    if (e.type !== 'swap-buy' && e.type !== 'swap-sell') continue;
    if (e.actorTier !== 'validator' && e.actorTier !== 'related') continue;
    if (!(e.ts > cutoffSec) || e.ts * 1000 > nowMs) continue;
    const leg = e.type === 'swap-buy' ? e.bought : e.sold;
    if (!leg || !leg.symbol || leg.symbol === 'FISH' || leg.whitelisted === false) continue;
    const amt = parseFloat(String(leg.amount ?? '0').replace(/,/g, '')) || 0;
    const t = (tokens[leg.symbol] ??= { buyN: 0, buyAmt: 0, sellN: 0, sellAmt: 0 });
    if (e.type === 'swap-buy') { t.buyN++; t.buyAmt += amt; buyTotal++; } else { t.sellN++; t.sellAmt += amt; sellTotal++; }
  }
  const got = feed.stats.trading[key];
  const syms = new Set([...Object.keys(tokens), ...Object.keys(got.tokens)]);
  let ok = got.buyTotal === buyTotal && got.sellTotal === sellTotal;
  for (const s of syms) {
    const a = tokens[s], b = got.tokens[s];
    const amtOk = (x, y) => Math.abs(x - y) <= Math.max(1e-4, Math.abs(y) * 1e-9); // relative: some token totals exceed 1e12
    if (!a || !b || a.buyN !== b.buyN || a.sellN !== b.sellN || !amtOk(a.buyAmt, b.buyAmt) || !amtOk(a.sellAmt, b.sellAmt)) ok = false;
  }
  check(`stats.trading.${key} matches independent recomputation (buy ${buyTotal} / sell ${sellTotal})`, ok);
  check(`stats.trading.${key}: FISH absent, all tokens whitelisted`, !('FISH' in got.tokens) && Object.keys(got.tokens).every((s) => WHITELIST_NO_FISH.has(s)), Object.keys(got.tokens).join(','));
}
check('reference level: 30d buys are in the expected range (>= 150)', feed.stats.trading['30d'].buyTotal >= 150, String(feed.stats.trading['30d'].buyTotal));
check('collector still flags bridge-out via notableReasons (data compat)', feed.events.some((e) => (e.notableReasons || []).includes('bridge-out')));

// ---------- (4) threshold rationale on the full history ----------
const fishSells = events.filter((e) => e.type === 'swap-sell' && e.sold && e.sold.symbol === 'FISH' && e.bought);
const byCur = (cur) => fishSells.filter((e) => e.bought.symbol === cur).map((e) => parseFloat(e.bought.amount)).sort((a, b) => a - b);
const median = (a) => a.length ? a[Math.floor(a.length / 2)] : 0;
const r42 = byCur('42'), rUsdt = byCur('USDT');
const share = (a) => a.length ? a.filter((v) => v < 10).length / a.length : 0;
check(`full-history FISH sells >= 1000 (got ${fishSells.length})`, fishSells.length >= 1000);
check(`[42]-received FISH sells: median ~2.5 (got ${median(r42).toFixed(3)}), >= 95% under 10 (got ${(share(r42) * 100).toFixed(1)}%)`, median(r42) > 2 && median(r42) < 3 && share(r42) >= 0.95, `${r42.length} sells`);
check(`USDT-received FISH sells: >= 98% under 10 (got ${(share(rUsdt) * 100).toFixed(1)}%)`, rUsdt.length >= 70 && share(rUsdt) >= 0.98, `${rUsdt.length} sells`);
check('rule excludes the overwhelming majority of FISH sells (>= 96%)', (r42.filter((v) => v < 10).length + rUsdt.filter((v) => v < 10).length) / fishSells.length >= 0.96);

// ---------- (5) home portal counts (JP, VM) ----------
{
  const html = read('home.html');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', checked: true, style: {}, classList: { add() {}, toggle() {} }, addEventListener() {}, appendChild(c) { this.options.push(c); }, querySelector: () => null });
  const sandbox = {
    document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl(), querySelector: () => null, querySelectorAll: () => [] },
    fetch: async () => ({ json: async () => feed }),
    setInterval() {}, console, location: { hash: '', search: '' },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await new Promise((r) => setTimeout(r, 100));
  check(`home.html: c-trades shows ${trades.length} 件`, els['c-trades'] && els['c-trades'].textContent === `${trades.length} 件`, els['c-trades']?.textContent);
  check(`home.html: c-tradesnf shows ${tradesNf.length} 件`, els['c-tradesnf'] && els['c-tradesnf'].textContent === `${tradesNf.length} 件`, els['c-tradesnf']?.textContent);
  const sum30 = feed.stats.trading['30d'].buyTotal + feed.stats.trading['30d'].sellTotal;
  check(`home.html: c-trading shows the 30d total ${sum30} 件`, els['c-trading'] && els['c-trading'].textContent === `${sum30} 件`, els['c-trading']?.textContent);
  check('home.html: cards link to the new sections', html.includes('href="index.html#sec-trades"') && html.includes('href="index.html#sec-tradesnf"') && html.includes('href="index.html#sec-trading"') && !html.includes('sec-alerts'));
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);
