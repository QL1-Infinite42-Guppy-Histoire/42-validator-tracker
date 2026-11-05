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
//  (3) Rendering (index.html + en.html, real page code in a vm): header
//      total + segment totals, legend, one stacked bar per name whose
//      segment widths sum to the bar total, per-row breakdown lines listing
//      exactly the non-zero segments. Spot facts: after the contract-audit
//      correction Metal Raptor has NO bar at all (the validator itself has
//      never bridged out, and every remaining MR-linked shared wallet
//      attributes to an earlier first validator); DRIVESTATS has a depth-1
//      segment of 613.05 USDT plus a depth-2+ segment; light888's self and
//      related money merge into ONE bar.
//  (4) Home portals: grand total + the three segment totals on the chart card.
//  (5) Contract audit + closure repair (added mid-release on the user's
//      discovery that 0xf2ec...f015 is a bridge-type CONTRACT, not a
//      wallet): audit-core addresses are out of the related tiers, no
//      closure entry routes via a contract, removed entries/events are
//      gone, and the chart's before/after correction is on record.
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

// spot facts under the chart rule
const mr = R.groups.get('Metal Raptor');
check('spot: Metal Raptor has NO bar after the audit correction (its v0.4.0 bar was entirely shared depth-2+ wallets routed via a bridge contract)', !mr, mr ? `unexpected ${fmt(mr.sum)}` : 'absent');
const ds = R.groups.get('DRIVESTATS');
check('spot: DRIVESTATS depth-1 segment is 613.05 USDT', !!ds && near(ds.seg[1], 613.05), ds ? `d1 ${fmt(ds.seg[1])}` : 'missing');
check('spot: DRIVESTATS also has a depth-2+ segment', !!ds && ds.seg[2] > 0, ds ? `d2+ ${fmt(ds.seg[2])}` : 'missing');
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
const maxSum = Math.max(...[...R.groups.values()].map((g) => g.sum));
for (const [file, labels, otherLabels] of [
  ['index.html', ['本人', '1段目の関連', '2段目以降の関連'], ['the validator itself', 'depth-1 related', 'depth-2+ related']],
  ['en.html', ['the validator itself', 'depth-1 related', 'depth-2+ related'], ['本人', '1段目の関連', '2段目以降の関連']],
]) {
  const { html, chart } = await renderChart(file);
  const tag = file === 'index.html' ? 'JP' : 'EN';
  check(`${tag}: legend lists all three depth segments`, chart.includes('bchart-legend') && labels.every((l) => chart.includes(l)));
  check(`${tag}: no foreign-language segment labels in the chart`, !otherLabels.some((l) => chart.includes(l)));
  if (tag === 'EN') check('EN: chart fragment has no Japanese', !JA.test(chart), (chart.match(/.{0,30}[぀-ヿ一-鿿]+.{0,30}/)?.[0] ?? ''));
  const headTotal = parseFloat(chart.match(/<div class="bchart-total">[^<]*?([\d,]+\.\d{2}) USDT/)[1].replace(/,/g, ''));
  check(`${tag}: header grand total matches recomputation`, near(headTotal, R.total), `${fmt(headTotal)} vs ${fmt(R.total)}`);
  const segHead = stripTags(chart.match(/<div class="bchart-segtotal">([\s\S]*?)<\/div>/)[1]);
  const segHeadAmts = [...segHead.matchAll(/([\d,]+\.\d{2}) USDT/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  check(`${tag}: header segment totals match recomputation`, segHeadAmts.length === 3 && segHeadAmts.every((v, i) => near(v, R.segTot[i])), segHead);
  const rows = parseRows(chart);
  check(`${tag}: one stacked bar per name`, rows.length === R.groups.size, `${rows.length} rows vs ${R.groups.size} groups`);
  let rowsOk = true, widthsOk = true;
  for (const row of rows) {
    const g = R.groups.get(row.name);
    if (!g || !near(row.amt, g.sum)) { rowsOk = false; break; }
    const expectSegs = g.seg.map((v, i) => (v > 0 ? i : null)).filter((x) => x !== null);
    if (row.segs.length !== expectSegs.length || !row.segs.every((s) => expectSegs.includes(s.seg))) { rowsOk = false; break; }
    if (row.brkAmts.length !== expectSegs.length || !expectSegs.every((s, j) => near(row.brkAmts[j], g.seg[s]))) { rowsOk = false; break; }
    const wsum = row.segs.reduce((t, s) => t + s.width, 0);
    if (Math.abs(wsum - (g.sum / maxSum) * 100) > 0.6) widthsOk = false;
  }
  check(`${tag}: every bar's segments + breakdown match its recomputed group`, rowsOk);
  check(`${tag}: stacked segment widths sum to the bar's share of the max`, widthsOk);
  const mrRow = rows.find((r) => r.name === 'Metal Raptor');
  check(`${tag}: Metal Raptor renders NO bar after the audit correction`, !mrRow);
  const l8Rows = rows.filter((r) => r.name === 'light888');
  check(`${tag}: light888 renders as ONE merged bar (self + depth-1)`, l8Rows.length === 1 && l8Rows[0].segs.length === 2 && l8Rows[0].segs.some((s) => s.seg === 0) && l8Rows[0].segs.some((s) => s.seg === 1));
  check(`${tag}: definition text explains depth-2+ inherited attribution`, tag === 'JP' ? html.includes('2段目以降は経路からの継承による帰属') : html.includes('Depth-2+ attribution is inherited through the path'));
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

// ---------- (5) contract audit + closure repair (parent steer, same release) ----------
const audit = JSON.parse(read('contract-audit.json'));
const repair = JSON.parse(read('closure-repair-report.json'));
const auditCore = Object.entries(audit.results).filter(([, r]) => r.decision === 'core').map(([a]) => a);
check('audit: every related/estimated entry was code-checked (347 targets)', audit.targets === 347, String(audit.targets));
check('audit: 34 addresses classified core (incl. bridge-type 0xf2ec...f015)', auditCore.length === 34, String(auditCore.length));
check('audit: no undecided review bucket remains', (audit.counts?.review ?? 0) === 0, JSON.stringify(audit.counts));
check('audit: 0x71b1...30e0 (known personal LP-holding contract) stays related', audit.results['0x71b138382598fbc4b890d2d20a14f9dedb1430e0']?.decision === 'stay-related' && ent.get('0x71b138382598fbc4b890d2d20a14f9dedb1430e0')?.tier === 'related');
const f015 = ent.get('0xf2ecb173b63699c49ace3faae80af5ce677af015');
check('0xf2ec...f015 is now core tier with the bridge-contract label', f015?.tier === 'core' && f015?.isCore === true && f015?.label === 'ブリッジ系コントラクト', `${f015?.tier}/${f015?.label}`);
check('no audit-core address remains in the related/estimated tiers', auditCore.every((a) => ent.get(a)?.tier === 'core'));
check('no audit-core address keeps relatedValidators attribution', auditCore.every((a) => !(ent.get(a)?.relatedValidators ?? []).length));
const auditCoreSet = new Set(auditCore);
const autoEntries = watchlist.entries.filter((e) => e.autoAdded);
check('no auto-added entry was routed via an audit-core contract', autoEntries.every((e) => !auditCoreSet.has(e.via?.address)), autoEntries.find((e) => auditCoreSet.has(e.via?.address))?.address);
check('no auto-added entry hangs below 0xf2ec...f015', autoEntries.every((e) => e.via?.address !== '0xf2ecb173b63699c49ace3faae80af5ce677af015'));
const removedSet = new Set(repair.removedEntries.map((r) => r.address));
check('repair removed 47 closure entries, none still in the watchlist', repair.removedEntries.length === 47 && repair.removedEntries.every((r) => !ent.has(r.address)), String(repair.removedEntries.length));
check('repair removed 1,439 actor events of removed entries', repair.eventsRemoved === 1439, String(repair.eventsRemoved));
check('no stored event keeps a removed actor (except pair-created chain news re-derived without attribution)',
  events.every((e) => !removedSet.has(e.actor) || e.type === 'pair-created'),
  events.find((e) => removedSet.has(e.actor) && e.type !== 'pair-created')?.id);
check('pair-created events of removed creators carry no tier attribution',
  events.filter((e) => e.type === 'pair-created' && removedSet.has(e.actor)).every((e) => e.actorTier == null));
const userAddr = ent.get('0xa33e223bcf1bb82d475ea29a11f3add9c2e73a23');
check('user address 0xa33e...3a23: kept via a non-contract path (NOT removed, NOT via 0xf2ec...f015)',
  repair.userAddressOutcome?.outcome === 'kept' && userAddr?.tier === 'related' && userAddr?.via?.address === '0x2fcfc23071e355aa75a6373d779bf5e220b8ecaf',
  `${repair.userAddressOutcome?.outcome} via ${userAddr?.via?.address}`);
check('chart before/after recorded: 19,113.43 -> 16,074.08 (the whole delta in depth>=2)',
  near(repair.chartBefore.total, 19113.43) && near(repair.chartAfter.total, 16074.08)
  && near(repair.chartBefore.seg[2] - repair.chartAfter.seg[2], repair.chartBefore.total - repair.chartAfter.total)
  && near(repair.chartBefore.seg[0], repair.chartAfter.seg[0]) && near(repair.chartBefore.seg[1], repair.chartAfter.seg[1]),
  `${repair.chartBefore.total} -> ${repair.chartAfter.total}`);
check('Metal Raptor chart group: 3,886.01 before -> NO bar after (846.66 at repair time, then first-validator attribution moved off it entirely)',
  near(repair.chartBefore.metalRaptor.total, 3886.01) && near(repair.chartAfterAtRepair.metalRaptor.total, 846.66)
  && repair.chartAfter.metalRaptor === null,
  `atRepair ${JSON.stringify(repair.chartAfterAtRepair.metalRaptor)} final ${JSON.stringify(repair.chartAfter.metalRaptor)}`);
check('current recomputation total equals the corrected total (no new bridge-outs since repair)',
  near(R.total, repair.chartAfter.total), `${fmt(R.total)} vs ${fmt(repair.chartAfter.total)}`);

// ---------- (6) section order (user reorder, shipped in v0.4.1) ----------
// Coloured special sections on top (insider, snipes, bridge-out, totals
// chart, notable), plain data sections below (LP, dormant, new faces, NEW
// PAIRS, feed, staking, validators). Anchors unchanged.
const ORDER = ['sec-insider', 'sec-snipes', 'sec-bridge', 'sec-bridgechart', 'sec-alerts', 'sec-lp', 'sec-dormant', 'sec-newfaces', 'sec-newpairs', 'sec-feed', 'sec-staking', 'sec-validators'];
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
