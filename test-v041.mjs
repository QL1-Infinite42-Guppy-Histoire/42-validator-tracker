#!/usr/bin/env node
// v0.4.1 regression tests: the bridge-out totals chart is split into DEPTH
// segments (validator itself / depth-1 related / depth-2+ related).
//  (1) Data: every stored event carries actorDepth; every bridge-out event
//      has a NUMERIC actorDepth, equal to an independent derivation from
//      watchlist.json (validator=0, explicit entry depth, original related=1,
//      anything else=null).
//  (2) Chart rule, recomputed independently from events.jsonl (count-once:
//      self -> own validator name, else FIRST related validator name;
//      segments by watchlist-derived depth): segment sums equal the grand
//      total; the same computation over feed.json (the chart's input —
//      bridge-outs are pinned into the feed) gives identical results.
//  (3) Rendering (index.html + en.html, real page code in a vm): since
//      v0.4.2 the chart renders the collector's pre-aggregated
//      feed.stats.bridge (per-validator attribution, all 23 validators) —
//      header deduplicated total + segment totals, legend, one stacked
//      bar per validator whose widths sum to its share, breakdown lines
//      listing exactly the non-zero segments. (The count-once grouping
//      of (2) now serves only as the independent recomputation of the
//      DEDUPLICATED total and segment totals.)
//  (4) Home portals: grand total + the three segment totals on the chart card.
//  (5) Contract audit + closure repair: the v0.4.1 audit/repair facts
//      (0xf2ec...f015 is a bridge-type CONTRACT, not a wallet; its
//      correction record) plus the v0.4.2 full-census facts — every
//      contract is out of the person tiers with NO exceptions (the
//      0x71b1...30e0 LP-holder contract included), the EOA-only repair
//      removed 49 entries and purged 11,697 events, and the corrected
//      totals are on record in eoa-repair-report.json.
// Run: node test-v041.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
const watchlist = JSON.parse(read('watchlist.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const EPS = 0.011;
const near = (a, b) => Math.abs(a - b) <= EPS;
const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- (1) actorDepth data ----------
const ent = new Map(watchlist.entries.map((e) => [e.address.toLowerCase(), e]));
const deriveDepth = (addr) => {
  const en = ent.get(String(addr).toLowerCase());
  if (!en) return null;
  if (en.tier === 'validator') return 0;
  if (en.depth != null) return en.depth;
  if (en.tier === 'related') return 1;
  return null;
};
check('every stored event carries the actorDepth key', events.every((e) => 'actorDepth' in e));
check('stored actorDepth matches the watchlist derivation on every event', events.every((e) => e.actorDepth === deriveDepth(e.actor)));
const storedBO = events.filter((e) => e.type === 'bridge-out');
check('every bridge-out event has a numeric actorDepth', storedBO.length > 0 && storedBO.every((e) => typeof e.actorDepth === 'number'), `${storedBO.length} bridge-outs`);
const feedBO = feed.events.filter((e) => e.type === 'bridge-out');
check('every feed bridge-out event has a numeric actorDepth', feedBO.every((e) => typeof e.actorDepth === 'number'));

// ---------- (2) chart rule recomputation ----------
const amtOf = (e) => parseFloat(String((e.amount && e.amount.amount) || '0').replace(/,/g, '')) || 0;
const segOfDepth = (d) => (d <= 0 ? 0 : d === 1 ? 1 : 2);
function chartRule(evs) {
  const outs = evs.filter((e) => e.type === 'bridge-out' && e.actorTier !== 'estimated');
  const groups = new Map(); const segTot = [0, 0, 0]; let total = 0;
  for (const ev of outs) {
    const a = amtOf(ev); total += a;
    const s = segOfDepth(deriveDepth(ev.actor)); segTot[s] += a;
    let name;
    if (ev.actorTier === 'validator' && ev.actorLabel) name = ev.actorLabel;
    else { const rel = ev.actorValidators || []; name = rel.length ? rel[0] : (ev.actorLabel || ('0x…' + ev.actor.slice(-4).toUpperCase())); }
    const g = groups.get(name) || { seg: [0, 0, 0], sum: 0, n: 0 };
    g.seg[s] += a; g.sum += a; g.n += 1; groups.set(name, g);
  }
  return { outs, total, segTot, groups };
}
const R = chartRule(events);
check('chart rule: segment sums equal the grand total', near(R.segTot[0] + R.segTot[1] + R.segTot[2], R.total), `total ${fmt(R.total)} = ${fmt(R.segTot[0])} + ${fmt(R.segTot[1])} + ${fmt(R.segTot[2])}`);
check('chart rule: per-name segment sums equal per-name totals', [...R.groups.values()].every((g) => near(g.seg[0] + g.seg[1] + g.seg[2], g.sum)));
check('chart rule: per-name totals sum to the grand total', near([...R.groups.values()].reduce((t, g) => t + g.sum, 0), R.total));
check('chart rule: every bridge-out is attributed (no address fallback names)', [...R.groups.keys()].every((k) => !k.includes('…')), [...R.groups.keys()].join(', '));
const RF = chartRule(feed.events);
check('feed parity: feed bridge-outs give the same grand total', near(RF.total, R.total), `${fmt(RF.total)} vs ${fmt(R.total)}`);
check('feed parity: feed segment totals match', R.segTot.every((v, i) => near(v, RF.segTot[i])));
check('feed parity: feed per-name groups match', RF.groups.size === R.groups.size && [...R.groups.entries()].every(([k, g]) => { const h = RF.groups.get(k); return h && near(h.sum, g.sum) && h.seg.every((v, i) => near(v, g.seg[i])); }));

// spot facts under the (deduplicated) chart recomputation. NOTE: the
// v0.4.1 count-once spot fact "Metal Raptor has no group" still holds
// for the deduplicated grouping (every MR-linked shared wallet's first
// name is another validator); the RENDERED chart since v0.4.2 uses
// per-validator attribution instead — see (3).
const mr = R.groups.get('Metal Raptor');
check('spot: no count-once group for Metal Raptor (shared wallets attribute to earlier first names)', !mr, mr ? `unexpected ${fmt(mr.sum)}` : 'absent');
const ds = R.groups.get('DRIVESTATS');
check('spot: DRIVESTATS has no bridge-out group after v0.5.2 (its only depth-1 bridge-out wallet, the 613.05 USDT one, was a one-off contact — demoted to candidate and its events purged)', !ds, ds ? `unexpected ${fmt(ds.sum)}` : 'absent');
const l8 = R.groups.get('light888');
check('spot: light888 merges self + depth-1 into one group', !!l8 && l8.seg[0] > 0 && l8.seg[1] > 0 && near(l8.seg[2], 0), l8 ? `self ${fmt(l8.seg[0])} / d1 ${fmt(l8.seg[1])}` : 'missing');

// ---------- (3) page rendering ----------
const JA = /[぀-ヿ一-鿿]/;
function loadPage(file) {
  const html = read(file);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', style: {}, addEventListener() {}, appendChild(c) { this.options.push(c); } });
  const sandbox = { document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl() }, fetch: async () => ({ json: async () => ({ status: {}, validators: [], events: [] }) }), setInterval() {}, console, location: { hash: '' } };
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;globalThis.__api={renderBridgeChart, bridgeSeg, setFeed:(f)=>{FEED=f;}};', sandbox);
  return { html, els, api: sandbox.__api };
}
const stripTags = (s) => s.replace(/<[^>]*>/g, '');
const normName = (s) => stripTags(s).replace(' (Rioshi)', '');
function parseRows(chartHtml) {
  return chartHtml.split('<div class="bchart-row">').slice(1).map((part) => {
    const name = normName(part.match(/<div class="bchart-name">([\s\S]*?)<\/div>/)[1]);
    const segs = [...part.matchAll(/<div class="bchart-seg seg(\d)" style="width:([\d.]+)%"><\/div>/g)].map((m) => ({ seg: Number(m[1]), width: parseFloat(m[2]) }));
    const amt = parseFloat(part.match(/<div class="bchart-amt">([\d,]+\.\d{2}) USDT/)[1].replace(/,/g, ''));
    const brk = stripTags(part.match(/<div class="bchart-break">([\s\S]*?)<\/div>/)[1]);
    const brkAmts = [...brk.matchAll(/([\d,]+\.\d{2}) USDT/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    return { name, segs, amt, brk, brkAmts };
  });
}
async function renderChart(file) {
  const { html, els, api } = loadPage(file);
  await new Promise((r) => setTimeout(r, 200)); // let the page's own load() settle on the empty stub feed
  api.setFeed(feed);
  api.renderBridgeChart();
  return { html, chart: els['bridgeChart'].innerHTML };
}
// v0.4.2: rendering consumes feed.stats.bridge (per-validator bars).
const S = feed.stats.bridge;
const statByName = new Map(S.perValidator.map((g) => [g.moniker, g]));
const maxStat = Math.max(...S.perValidator.map((g) => g.total));
for (const [file, labels, otherLabels] of [
  ['index.html', ['本人', '1段目の関連'], ['the validator itself', 'depth-1 related', 'depth-2+ related', '2段目以降の関連']],
  ['en.html', ['the validator itself', 'depth-1 related'], ['本人', '1段目の関連', '2段目以降の関連', 'depth-2+ related']],
]) {
  const { html, chart } = await renderChart(file);
  const tag = file === 'index.html' ? 'JP' : 'EN';
  check(`${tag}: legend lists the two depth segments (v0.5.3: depth-2+ segment retired)`, chart.includes('bchart-legend') && labels.every((l) => chart.includes(l)));
  check(`${tag}: no foreign-language segment labels in the chart`, !otherLabels.some((l) => chart.includes(l)));
  if (tag === 'EN') check('EN: chart fragment has no Japanese', !JA.test(chart), (chart.match(/.{0,30}[぀-ヿ一-鿿]+.{0,30}/)?.[0] ?? ''));
  const headTotal = parseFloat(chart.match(/<div class="bchart-total">[^<]*?([\d,]+\.\d{2}) USDT/)[1].replace(/,/g, ''));
  check(`${tag}: header deduplicated total matches the independent recomputation`, near(headTotal, R.total) && near(headTotal, S.total), `${fmt(headTotal)} vs ${fmt(R.total)}`);
  const segHead = stripTags(chart.match(/<div class="bchart-segtotal">([\s\S]*?)<\/div>/)[1]);
  const segHeadAmts = [...segHead.matchAll(/([\d,]+\.\d{2}) USDT/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  check(`${tag}: header segment totals match recomputation (non-zero segments only)`, segHeadAmts.length === R.segTot.filter((v) => v > 0).length && segHeadAmts.every((v, i) => near(v, R.segTot.filter((x) => x > 0)[i])), segHead);
  const rows = parseRows(chart);
  check(`${tag}: one bar per validator (all 23, zero bars included)`, rows.length === S.perValidator.length && rows.length === 23, `${rows.length} rows`);
  let rowsOk = true, widthsOk = true;
  for (const row of rows) {
    const g = statByName.get(row.name);
    if (!g || !near(row.amt, g.total)) { rowsOk = false; break; }
    const expectSegs = g.seg.map((v, i) => (v > 0 ? i : null)).filter((x) => x !== null);
    if (row.segs.length !== expectSegs.length || !row.segs.every((s) => expectSegs.includes(s.seg))) { rowsOk = false; break; }
    if (row.brkAmts.length !== expectSegs.length || !expectSegs.every((s, j) => near(row.brkAmts[j], g.seg[s]))) { rowsOk = false; break; }
    const wsum = row.segs.reduce((t, s) => t + s.width, 0);
    if (Math.abs(wsum - (g.total / maxStat) * 100) > 0.6) widthsOk = false;
  }
  check(`${tag}: every bar's segments + breakdown match the collector aggregation`, rowsOk);
  check(`${tag}: stacked segment widths sum to the bar's share of the max`, widthsOk);
  const mrRow = rows.find((r) => r.name === 'Metal Raptor');
  check(`${tag}: Metal Raptor renders a ZERO bar under the final scope (no self / depth-1 / evidence-backed depth-2+ bridge-outs left)`, !!mrRow && near(mrRow.amt, 0) && mrRow.segs.length === 0 && near(statByName.get('Metal Raptor').total, 0), mrRow ? `${fmt(mrRow.amt)}` : 'missing');
  const zeroRow = rows.find((r) => r.name === 'Xenia');
  check(`${tag}: zero-activity validators still render a 0 bar`, !!zeroRow && near(zeroRow.amt, statByName.get('Xenia').total) && zeroRow.segs.length === 0);
  const l8Rows = rows.filter((r) => r.name === 'light888');
  check(`${tag}: light888 renders as ONE bar (self + depth-1)`, l8Rows.length === 1 && l8Rows[0].segs.length === 2 && l8Rows[0].segs.some((s) => s.seg === 0) && l8Rows[0].segs.some((s) => s.seg === 1));
  check(`${tag}: definition text states bars do not sum to the grand total`, tag === 'JP' ? html.includes('棒の合計は全体総額と一致しません') : html.includes('the bars do not add up to the grand total'));
  check(`${tag}: definition text states contracts are judged by bytecode only / shared wallets stay personal`, tag === 'JP' ? html.includes('共有の財布というだけでは仕組み系にしません') : html.includes('never treated as infrastructure just for being a shared wallet'));
}

// ---------- (4) home portals ----------
for (const [file, segPrefix] of [['home.html', '本人'], ['home-en.html', 'Itself']]) {
  const html = read(file);
  check(`${file}: chart card has the segment line element`, html.includes('id="c-bridgeseg"'));
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', style: {}, addEventListener() {}, appendChild(c) { this.options.push(c); } });
  const sandbox = { document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl() }, fetch: async () => ({ json: async () => feed }), setInterval() {}, console, location: { hash: '' } };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  await new Promise((r) => setTimeout(r, 200));
  check(`${file}: portal grand total matches`, els['c-bridgetotal']?.textContent === fmt(R.total) + ' USDT', els['c-bridgetotal']?.textContent);
  const segText = els['c-bridgeseg']?.textContent || '';
  const segAmts = [...segText.matchAll(/([\d,]+\.\d{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  check(`${file}: portal segment totals match`, segText.startsWith(segPrefix) && segAmts.length === 3 && segAmts.every((v, i) => near(v, R.segTot[i])), segText);
}

// ---------- (5) contract audits + closure repairs (v0.4.1 record + v0.4.2 full census) ----------
const audit = JSON.parse(read('contract-audit.json'));
const repair = JSON.parse(read('closure-repair-report.json'));
const eoaRep = JSON.parse(read('eoa-repair-report.json'));
const auditCore = Object.entries(audit.results).filter(([, r]) => r.decision === 'core').map(([a]) => a);
// v0.4.2 census: binary decisions only; every CURRENT person-tier entry
// carries an 'eoa' verdict; 150 contracts in total.
check('audit (v0.4.2): decisions are binary — eoa or core, nothing else', Object.values(audit.results).every((r) => r.decision === 'eoa' || r.decision === 'core'));
check('audit (v0.4.2): 150 addresses classified core (contracts)', auditCore.length === 150, String(auditCore.length));
check('audit (v0.4.2): every current related/estimated entry was code-checked and is an EOA', watchlist.entries.filter((e) => e.tier === 'related' || e.tier === 'estimated').every((e) => audit.results[e.address]?.decision === 'eoa'));
check('audit (v0.4.2): 0x71b1...30e0 (LP-holder contract) is core now — the v0.4.1 stay-related exception is gone', audit.results['0x71b138382598fbc4b890d2d20a14f9dedb1430e0']?.decision === 'core' && ent.get('0x71b138382598fbc4b890d2d20a14f9dedb1430e0')?.tier === 'core');
const f015 = ent.get('0xf2ecb173b63699c49ace3faae80af5ce677af015');
check('0xf2ec...f015 stays core tier with the bridge-contract label', f015?.tier === 'core' && f015?.isCore === true && f015?.label === 'ブリッジ系コントラクト', `${f015?.tier}/${f015?.label}`);
check('probes: the two big via-parents 0x2fcfc230... / 0xbf2bb17f... are EOAs (bytecode fact from the census)', audit.results['0x2fcfc23071e355aa75a6373d779bf5e220b8ecaf']?.decision === 'eoa' && audit.results['0xbf2bb17f408521607cf7e79798d0d0ab6be5603a']?.decision === 'eoa');
check('probe outcomes: 0x2fcfc230... stays related (depth-1 original); 0xbf2bb17f... was depth-2 and is governed by the evidence gate instead', ent.get('0x2fcfc23071e355aa75a6373d779bf5e220b8ecaf')?.tier === 'related');
check('no audit-core address remains in the related/estimated tiers', auditCore.every((a) => !ent.has(a) || ent.get(a)?.tier === 'core'));
check('no audit-core address keeps relatedValidators attribution', auditCore.every((a) => !(ent.get(a)?.relatedValidators ?? []).length));
const auditCoreSet = new Set(auditCore);
const autoEntries = watchlist.entries.filter((e) => e.autoAdded);
check('no auto-added entry was routed via an audit-core contract', autoEntries.every((e) => !auditCoreSet.has(e.via?.address)), autoEntries.find((e) => auditCoreSet.has(e.via?.address))?.address);
check('no auto-added entry hangs below 0xf2ec...f015', autoEntries.every((e) => e.via?.address !== '0xf2ecb173b63699c49ace3faae80af5ce677af015'));
// v0.4.1 repair record (historical, unchanged file)
check('v0.4.1 repair removed 47 closure entries', repair.removedEntries.length === 47 && repair.removedEntries.every((r) => !ent.has(r.address)), String(repair.removedEntries.length));
check('v0.4.1 chart before/after recorded: 19,113.43 -> 16,074.08 (the whole delta in depth>=2)',
  near(repair.chartBefore.total, 19113.43) && near(repair.chartAfter.total, 16074.08)
  && near(repair.chartBefore.seg[2] - repair.chartAfter.seg[2], repair.chartBefore.total - repair.chartAfter.total)
  && near(repair.chartBefore.seg[0], repair.chartAfter.seg[0]) && near(repair.chartBefore.seg[1], repair.chartAfter.seg[1]),
  `${repair.chartBefore.total} -> ${repair.chartAfter.total}`);
check('v0.4.1 Metal Raptor chart group: 3,886.01 before -> no count-once group after',
  near(repair.chartBefore.metalRaptor.total, 3886.01) && near(repair.chartAfterAtRepair.metalRaptor.total, 846.66)
  && repair.chartAfter.metalRaptor === null,
  `atRepair ${JSON.stringify(repair.chartAfterAtRepair.metalRaptor)} final ${JSON.stringify(repair.chartAfter.metalRaptor)}`);
// v0.4.2 EOA-only repair record
const removedSet = new Set(eoaRep.closureRemoved.map((r) => r.address));
const movedSet = new Set(eoaRep.contractsMovedToCore.map((c) => c.address));
check('v0.4.2 repair moved 29 person-tier contracts to core (27 related + 2 estimated)', eoaRep.contractsMovedToCore.length === 29 && eoaRep.contractsMovedToCore.filter((c) => c.formerTier === 'related').length === 27 && eoaRep.contractsMovedToCore.filter((c) => c.formerTier === 'estimated').length === 2);
check('v0.4.2 repair removed 49 closure entries, none still in the watchlist', eoaRep.closureRemoved.length === 49 && eoaRep.closureRemoved.every((r) => !ent.has(r.address)), String(eoaRep.closureRemoved.length));
check('v0.4.2 repair purged 11,697 events (contracts 3,228 / removed entries 5,027 / permanently excluded 3,442)', eoaRep.eventsPurged.total === 11697 && eoaRep.eventsPurged.contractActors === 3228 && eoaRep.eventsPurged.removedEntries === 5027 && eoaRep.eventsPurged.excludedActors === 3442, JSON.stringify(eoaRep.eventsPurged));
check('v0.4.2 repair removed exactly 1 permanently excluded entry (recorded as a count only)', eoaRep.excludedEntriesRemoved === 1);
check('no stored event keeps a removed or contract-moved actor (except pair-created chain news re-derived without attribution)',
  events.every((e) => !(removedSet.has(e.actor) || movedSet.has(e.actor)) || e.type === 'pair-created'),
  events.find((e) => (removedSet.has(e.actor) || movedSet.has(e.actor)) && e.type !== 'pair-created')?.id);
check('pair-created events of removed/moved creators carry no tier attribution',
  events.filter((e) => e.type === 'pair-created' && (removedSet.has(e.actor) || movedSet.has(e.actor))).every((e) => e.actorTier == null));
check('EOA repair record: watchlist shrank 413 -> 363 with tiers 23/183/153/4 at that stage', eoaRep.before.watchlistTotal === 413 && eoaRep.after.watchlistTotal === 363 && eoaRep.after.tiers.related === 183 && eoaRep.after.tiers.core === 153 && eoaRep.after.tiers.estimated === 4);
check('v0.4.2 chart before/after (deduplicated): 16,074.08 -> 14,104.47, delta entirely in depth>=2', near(eoaRep.before.bridge.total, 16074.08) && near(eoaRep.after.bridge.total, 14104.47) && near(eoaRep.before.bridge.segTotals[0], eoaRep.after.bridge.segTotals[0]) && near(eoaRep.before.bridge.segTotals[1], eoaRep.after.bridge.segTotals[1]) && eoaRep.after.bridge.segTotals[2] < eoaRep.before.bridge.segTotals[2], `${eoaRep.before.bridge.total} -> ${eoaRep.after.bridge.total}`);
const tightRep = JSON.parse(read('tightening-report.json'));
check('current recomputation total equals the v0.5.3 total (evidence-tier senders removed; no new bridge-outs since)', near(R.total, 6419.27), `${fmt(R.total)} vs 6,419.27`);

// ---------- (6) section order (user reorder, shipped in v0.4.1) ----------
// Coloured special sections on top (prelist, snipes, bridge-out, totals
// chart, notable), plain data sections below (LP, dormant, new faces, NEW
// PAIRS, feed, staking, validators). Anchors unchanged.
const ORDER = ['sec-prelist', 'sec-snipes', 'sec-bridge', 'sec-bridgechart', 'sec-trades', 'sec-tradesnf', 'sec-trading', 'sec-lp', 'sec-dormant', 'sec-newfaces', 'sec-newpairs', 'sec-feed', 'sec-staking', 'sec-validators'];
const seqOf = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
for (const file of ['index.html', 'en.html']) {
  const html = read(file);
  check(`${file}: section order is coloured-on-top with New Pairs in the plain group`,
    JSON.stringify(seqOf(html, /<section[^>]* id="(sec-[a-z]+)"/g)) === JSON.stringify(ORDER),
    seqOf(html, /<section[^>]* id="(sec-[a-z]+)"/g).join(','));
  check(`${file}: topnav link order matches the section order`,
    JSON.stringify(seqOf(html, /href="#(sec-[a-z]+)"/g)) === JSON.stringify(ORDER));
}
for (const [file, target] of [['home.html', 'index.html'], ['home-en.html', 'en.html']]) {
  const html = read(file);
  check(`${file}: portal card order matches the section order`,
    JSON.stringify(seqOf(html, new RegExp(`href="${target.replace('.', '\\.')}#(sec-[a-z]+)"`, 'g'))) === JSON.stringify(ORDER),
    seqOf(html, new RegExp(`href="${target.replace('.', '\\.')}#(sec-[a-z]+)"`, 'g')).join(','));
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
