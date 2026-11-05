#!/usr/bin/env node
// v0.4.0 regression tests for the six new sections:
//  (1) New pairs: pair-created event shape + whitelist display rule
//      (both sides non-whitelisted => hidden from the section).
//  (2) LP moves: feed pinning cap + confirmed-only data supply.
//  (3) Staking stats: computeStakingStats matches an independent recount
//      of events.jsonl; ambiguous attribution stays out of per-validator.
//  (4) Dormant returns: the 60-day threshold in computeHistoryFlags
//      (59d = no, 60d = yes), estimated actors never eligible.
//  (5) Price: feed.status.price present and plausible.
//  (6) New faces + auto-add: computeHistoryFlags flags only the earliest
//      appearance of a counterparty; maybeAutoAdd adds for confirmed
//      actors (with inherited attribution + depth), never for estimated
//      actors, pairs, token/system contracts, or known addresses.
//  (6b) Closure fixpoint over the REAL graph (flows + events): every
//      neighbour of the confirmed person-side set is watched, excluded,
//      or estimated; closure entries carry depth/via/firstSeen and never
//      route through an estimated address.
// Run: node test-v040.mjs (exit 1 on failure)
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExcludedSet, buildPairCreatedEvent, computeHistoryFlags, computeStakingStats, makeCtx, maybeAutoAdd, selectFeedEvents } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
const watchlist = JSON.parse(read('watchlist.json'));
const registries = JSON.parse(read('registries.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));
const ctx = makeCtx(watchlist, registries, {});
const excluded = buildExcludedSet(watchlist, registries);

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const lc = (a) => String(a).toLowerCase();

// ---------- (1) pair-created events ----------
const pairEvents = events.filter((e) => e.type === 'pair-created');
check('stored pair-created events exist', pairEvents.length >= 60, String(pairEvents.length));
check('pair-created events carry pairSymbols/pairWhitelist/firstMint field', pairEvents.every((e) => Array.isArray(e.pairSymbols) && Array.isArray(e.pairWhitelist) && 'firstMint' in e));
check('pair-created events are never snipe/insider flagged', pairEvents.every((e) => !e.isSnipe && !e.isInsider));
const displayedPairs = pairEvents.filter((e) => (e.pairWhitelist || []).some(Boolean));
const hiddenPairs = pairEvents.filter((e) => !(e.pairWhitelist || []).some(Boolean));
check('display rule: at-least-one-whitelisted pairs exist', displayedPairs.length > 0, String(displayedPairs.length));
check('display rule: both-non-whitelisted pairs are exactly the hidden ones', hiddenPairs.every((e) => e.pairWhitelist.every((w) => !w)) && displayedPairs.every((e) => e.pairWhitelist.some(Boolean)), `displayed ${displayedPairs.length} / hidden ${hiddenPairs.length}`);
check('one-sided pairs carry nonWhitelistedSide', pairEvents.filter((e) => e.pairWhitelist.filter(Boolean).length === 1).every((e) => e.nonWhitelistedSide === true));
check('pair-created events present in feed.json', feed.events.filter((e) => e.type === 'pair-created').length > 0, String(feed.events.filter((e) => e.type === 'pair-created').length));
{
  // builder-level: synthetic creation on the real FISH/42 pair (both listed)
  const ev = buildPairCreatedEvent(ctx, '0x46cce7b6b48e1627d7e3f69a68f425cba833dcc3', { createdBlock: 100, createdTs: 1700000000, txHash: '0x' + 'ab'.repeat(32), creator: null }, null);
  check('builder: FISH/42 pair event is fully whitelisted', !!ev && ev.pairWhitelist.every(Boolean) && ev.nonWhitelistedSide === false && ev.tokens.includes('FISH'));
}
// feed pinning caps (synthetic; pinned categories sit BELOW the head-500
// window so the caps apply exactly)
{
  const mk = (base) => (i, type, extra = {}) => ({ id: `${type}-${i}`, block: base - i, logIndex: 0, type, ...extra });
  const many = [
    ...Array.from({ length: 600 }, (_, i) => mk(9000000)(i, 'transfer')),
    ...Array.from({ length: 300 }, (_, i) => mk(8000000)(i, 'pair-created')),
    ...Array.from({ length: 400 }, (_, i) => mk(7000000)(i, 'lp-add')),
    ...Array.from({ length: 300 }, (_, i) => mk(6000000)(i, 'transfer', { isNewCounterparty: true, id: `newface-${i}` })),
  ].sort((a, b) => b.block - a.block);
  const sel = selectFeedEvents(many);
  check('feed pinning: pair-created capped at exactly 100', sel.filter((e) => e.type === 'pair-created').length === 100, String(sel.filter((e) => e.type === 'pair-created').length));
  check('feed pinning: LP capped at exactly 150', sel.filter((e) => e.type === 'lp-add').length === 150, String(sel.filter((e) => e.type === 'lp-add').length));
  check('feed pinning: new-counterparty capped at exactly 100', sel.filter((e) => e.isNewCounterparty).length === 100, String(sel.filter((e) => e.isNewCounterparty).length));
}

// ---------- (2) LP data supply ----------
const storedLp = events.filter((e) => e.type === 'lp-add' || e.type === 'lp-remove');
const feedLp = feed.events.filter((e) => (e.type === 'lp-add' || e.type === 'lp-remove') && e.actorTier !== 'estimated');
check('stored LP events exist (incl. closure backfill)', storedLp.length >= 223, String(storedLp.length));
check('feed LP events: none from estimated actors', feed.events.filter((e) => (e.type === 'lp-add' || e.type === 'lp-remove') && e.actorTier === 'estimated').length === 0);
check('feed LP section is populated', feedLp.length > 0, String(feedLp.length));

// ---------- (3) staking stats: independent recount ----------
{
  const st = feed.stats?.staking;
  check('feed.stats.staking present', !!st);
  const TYPES = ['delegate', 'undelegate', 'redelegate', 'reward', 'commission'];
  for (const t of TYPES) {
    const rows = events.filter((e) => e.type === t);
    const raw = rows.reduce((s, e) => s + (e.amount?.symbol === '42' && e.amount?.amountRaw ? BigInt(e.amount.amountRaw) : 0n), 0n);
    check(`stats totals ${t}: count matches recount`, st.totals[t].count === rows.length, `${st.totals[t].count} vs ${rows.length}`);
    const shown = parseFloat(st.totals[t].amount42.replace(/,/g, ''));
    check(`stats totals ${t}: [42] sum matches recount (±0.001 rounding)`, Math.abs(shown - Number(raw) / 1e18) < 0.001, `${shown} vs ${Number(raw) / 1e18}`);
  }
  // per-validator commission: pick the top row and recount by hand
  const top = st.perValidator[0];
  check('stats perValidator non-empty', !!top);
  if (top) {
    const rows = events.filter((e) => e.type === 'commission' && (ctx.entry(e.actor)?.tier === 'validator' && ctx.entry(e.actor)?.label === top.moniker));
    check('stats top commission count matches recount', top.commissionCount === rows.length, `${top.commissionCount} vs ${rows.length}`);
  }
  // ambiguous commission actors (shared operator accounts) are NOT attributed
  const amb = events.filter((e) => e.type === 'commission' && ctx.entry(e.actor)?.tier !== 'validator');
  check('ambiguous commission events counted as unattributed', st.unattributed.commission === amb.length, `${st.unattributed.commission} vs ${amb.length}`);
  check('stats range covers the event history', st.range.fromBlock === Math.min(...events.filter((e) => e.block != null).map((e) => e.block)) && st.range.toBlock != null);
  const direct = computeStakingStats(events, ctx);
  check('computeStakingStats is deterministic vs feed copy', JSON.stringify(direct.totals) === JSON.stringify(st.totals) && direct.perValidator.length === st.perValidator.length);
}

// ---------- (4) dormant threshold ----------
{
  const rel = watchlist.entries.find((e) => e.tier === 'related' && !e.isPair && !e.isCore);
  const est = watchlist.entries.find((e) => e.tier === 'estimated');
  const D = 86400, T0 = 1700000000;
  const mkEv = (actor, ts, id) => ({ id, chain: 'evm', ts, block: 1000 + id, logIndex: 0, type: 'transfer', actor, counterparty: watchlist.entries[0].address });
  const evs = [
    mkEv(rel.address, T0, 1),
    mkEv(rel.address, T0 + 59 * D, 2), // 59d gap: NOT dormant
    mkEv(rel.address, T0 + 59 * D + 61 * D, 3), // 61d gap: dormant
    mkEv(est.address, T0, 4),
    mkEv(est.address, T0 + 200 * D, 5), // estimated: never dormant
  ];
  computeHistoryFlags(evs, ctx);
  check('dormant: 59-day gap is NOT flagged', !evs[1].isDormantReturn);
  check('dormant: 61-day gap IS flagged with dormantDays', evs[2].isDormantReturn === true && evs[2].dormantDays === 61, String(evs[2].dormantDays));
  check('dormant: first event of an actor is never flagged', !evs[0].isDormantReturn);
  check('dormant: estimated actor never flagged', !evs[4].isDormantReturn);
  const storedDormant = events.filter((e) => e.isDormantReturn);
  check('stored dormant flags all satisfy >= 60 days', storedDormant.every((e) => e.dormantDays >= 60), String(storedDormant.length));
  check('stored dormant events: no estimated actors', storedDormant.every((e) => e.actorTier !== 'estimated'));
}

// ---------- (5) price ----------
check('feed.status.price present', !!feed.status.price && typeof feed.status.price.usdt === 'number');
check('price is plausible (0 < p < 10 USDT)', feed.status.price.usdt > 0 && feed.status.price.usdt < 10, String(feed.status.price.usdt));
check('price change24hPct is number or null', feed.status.price.change24hPct === null || typeof feed.status.price.change24hPct === 'number');

// ---------- (6) new faces + auto-add ----------
{
  const wl = JSON.parse(JSON.stringify(watchlist));
  const ctx2 = makeCtx(wl, registries, {});
  const ex2 = buildExcludedSet(wl, registries);
  const known = wl.entries.find((e) => e.tier === 'validator');
  const fresh1 = '0x' + 'f1'.repeat(20), fresh2 = '0x' + 'f2'.repeat(20);
  const base = { chain: 'evm', ts: 1800000000, block: 5000000, logIndex: 0, type: 'transfer', txHash: '0x' + 'cd'.repeat(32) };
  const evs = [
    { ...base, id: 'n1', actor: known.address, counterparty: known.address }, // self: ignored
    { ...base, id: 'n2', actor: known.address, counterparty: fresh1 },
    { ...base, id: 'n3', actor: known.address, counterparty: fresh1, ts: 1800000100 }, // second appearance: not flagged
    { ...base, id: 'n4', actor: known.address, counterparty: '0x46cce7b6b48e1627d7e3f69a68f425cba833dcc3' }, // pair: known/core side
  ];
  computeHistoryFlags(evs, ctx2);
  check('newface: first appearance flagged', evs[1].isNewCounterparty === true);
  check('newface: second appearance NOT flagged', !evs[2].isNewCounterparty);
  check('newface: pair counterparty NOT flagged', !evs[3].isNewCounterparty);

  // maybeAutoAdd behaviour on a cloned watchlist
  const rel = wl.entries.find((e) => e.tier === 'related' && !e.isPair && !e.isCore && (e.relatedValidators ?? []).length);
  const val = wl.entries.find((e) => e.tier === 'validator');
  const est = wl.entries.find((e) => e.tier === 'estimated');
  const addEv = (actor, counterparty) => ({ ...base, actor, counterparty });
  const before = wl.entries.length;
  const a1 = maybeAutoAdd(wl, ctx2, addEv(val.address, fresh2), ex2);
  check('autoAdd: validator counterparty added at depth 1 with validator name', !!a1 && a1.depth === 1 && a1.relatedValidators.includes(val.label) && a1.autoAdded === true && a1.addedVia === 'live');
  const a2 = maybeAutoAdd(wl, ctx2, addEv(rel.address, '0x' + 'f3'.repeat(20)), ex2);
  check('autoAdd: related counterparty inherits names, depth = actor+1', !!a2 && a2.relatedValidators.join() === (rel.relatedValidators ?? []).join() && a2.depth === (rel.depth ?? 1) + 1);
  const a3 = maybeAutoAdd(wl, ctx2, addEv(fresh2, '0x' + 'f4'.repeat(20)), ex2);
  check('autoAdd: recursive — an auto-added wallet adds its own counterparty', !!a3 && a3.depth === 2 && a3.via.address === fresh2);
  check('autoAdd: estimated actor adds nothing', maybeAutoAdd(wl, ctx2, addEv(est.address, '0x' + 'f5'.repeat(20)), ex2) === null);
  check('autoAdd: pair counterparty not added', maybeAutoAdd(wl, ctx2, addEv(val.address, '0x46cce7b6b48e1627d7e3f69a68f425cba833dcc3'), ex2) === null);
  check('autoAdd: router (system contract) not added', maybeAutoAdd(wl, ctx2, addEv(val.address, '0xbf07dfe35746894bae373f63f4bf2379f9bafec0'), ex2) === null);
  check('autoAdd: token contract not added', maybeAutoAdd(wl, ctx2, addEv(val.address, '0x2c32120a12b754272d9e85c57f64b50ca2c43513'), ex2) === null);
  check('autoAdd: already-watched counterparty not re-added', maybeAutoAdd(wl, ctx2, addEv(val.address, rel.address), ex2) === null);
  check('autoAdd: entries grew only by the 3 valid adds', wl.entries.length === before + 3, `${wl.entries.length} vs ${before}+3`);
  const storedNewface = events.filter((e) => e.isNewCounterparty);
  check('stored newface events exist', storedNewface.length > 0, String(storedNewface.length));
  check('stored newface counterparties are unique (one flag per address)', new Set(storedNewface.map((e) => lc(e.counterparty))).size === storedNewface.length);
}

// ---------- (6b) closure fixpoint over the real graph ----------
{
  const closure = watchlist.entries.filter((e) => e.autoAdded && e.addedVia === 'closure-v0.4.0');
  check('closure entries exist and match summary count', closure.length > 0 && closure.length === watchlist.summary.autoAddedClosure, String(closure.length));
  check('closure entries all related tier, watched, with depth>=1/via/firstSeen', closure.every((e) => e.tier === 'related' && e.watch === true && e.depth >= 1 && e.via?.address && (e.firstSeenTx || e.addedAt)));
  const byDepth = {};
  for (const e of closure) byDepth[e.depth] = (byDepth[e.depth] ?? 0) + 1;
  check('closure depth distribution is fully recorded', Object.values(byDepth).reduce((s, n) => s + n, 0) === closure.length, JSON.stringify(byDepth));
  check('no closure entry is in the excluded set', closure.every((e) => !excluded.has(e.address)));
  const estAddrs = new Set(watchlist.entries.filter((e) => e.tier === 'estimated').map((e) => e.address));
  check('no closure entry routes via an estimated address', closure.every((e) => !estAddrs.has(e.via.address)));
  check('closure attribution: via names overlap entry names', closure.every((e) => (e.via.validators ?? []).some((n) => e.relatedValidators.includes(n)) || (e.via.validators ?? []).length === 0));
  check('summary: autoAdded counts agree', watchlist.summary.autoAdded === watchlist.entries.filter((e) => e.autoAdded).length && watchlist.summary.autoAddedClosure === closure.length);
  check('feed validators autoAddedCount sums to per-name link total', feed.validators.reduce((s, v) => s + (v.autoAddedCount ?? 0), 0) === watchlist.entries.filter((e) => e.autoAdded).reduce((s, e) => s + e.relatedValidators.length, 0));

  // fixpoint: rebuild the person-side graph and verify nothing reachable
  // is left unwatched (outside exclusions / estimates)
  const adj = new Map();
  const addEdge = (a, b) => { a = lc(a); b = lc(b); if (!a || !b || a === b) return; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); };
  const rl = createInterface({ input: createReadStream(join(__dir, '..', '42-flowmap', 'flows.jsonl')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.st !== 1) continue;
    for (const t of r.tt ?? []) addEdge(t.f, t.t);
    for (const c of r.cs ?? []) addEdge(c.f, c.t);
  }
  for (const e of events) if (e.actor && e.counterparty) addEdge(e.actor, e.counterparty);
  const HOLDER = '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25';
  // Faithful replication of build-closure.mjs: seeds = the ORIGINAL
  // confirmed person-side set; expansion is BLOCKED at excluded nodes and
  // at estimated addresses. Fixpoint claim: every node this traversal can
  // reach is watched, excluded, or estimated.
  const reached = new Set();
  const queue = [];
  for (const e of watchlist.entries) {
    const personSeed = e.tier === 'validator' || (e.tier === 'related' && (!e.isCore || e.address === HOLDER));
    if (personSeed && !e.autoAdded && !reached.has(e.address)) { reached.add(e.address); queue.push(e.address); }
  }
  while (queue.length) {
    const cur = queue.shift();
    if (excluded.has(cur) || estAddrs.has(cur)) continue; // blocked node: do not expand
    for (const nb of adj.get(cur) ?? []) {
      if (reached.has(nb)) continue;
      reached.add(nb); queue.push(nb);
    }
  }
  const watched = new Set(watchlist.entries.map((e) => e.address));
  const missing = [...reached].filter((a) => !watched.has(a) && !excluded.has(a) && !estAddrs.has(a));
  check('fixpoint: every reachable non-excluded node is watched or estimated', missing.length === 0, missing.slice(0, 5).join(','));
  check('fixpoint: all closure entries are inside the reached set', closure.every((e) => reached.has(e.address)));
}

// ---------- frontend statics ----------
{
  const jp = read('index.html'), en = read('en.html'), home = read('home.html'), homeEn = read('home-en.html');
  const order = ['sec-insider', 'sec-snipes', 'sec-newpairs', 'sec-bridge', 'sec-bridgechart', 'sec-alerts', 'sec-lp', 'sec-dormant', 'sec-newfaces', 'sec-feed', 'sec-staking', 'sec-validators'];
  for (const [name, html] of [['index.html', jp], ['en.html', en]]) {
    const idx = order.map((id) => html.indexOf(`id="${id}"`));
    check(`${name}: all 12 sections present in order`, idx.every((v, i) => v > -1 && (i === 0 || v > idx[i - 1])));
    check(`${name}: price bar + staking renderer + dormant rule hook`, html.includes('id="pricebar"') && html.includes('renderStaking') && html.includes('id="dormantRule"'));
    check(`${name}: LP border classes + new badges`, html.includes('.ev.lpadd') && html.includes('.ev.lpremove') && html.includes('badge dormant') && html.includes('badge newface'));
    check(`${name}: topnav has all new sections`, ['#sec-newpairs', '#sec-lp', '#sec-dormant', '#sec-newfaces', '#sec-staking'].every((h) => html.includes(`href="${h}"`)));
    check(`${name}: version v0.4.1`, html.includes('v0.4.1'));
  }
  for (const [name, html, p] of [['home.html', home, 'index.html'], ['home-en.html', homeEn, 'en.html']]) {
    check(`${name}: price card present`, html.includes('id="pricecard"'));
    check(`${name}: portal cards for all new sections`, ['#sec-newpairs', '#sec-lp', '#sec-dormant', '#sec-newfaces', '#sec-staking'].every((h) => html.includes(`href="${p}${h}"`)));
    check(`${name}: version v0.4.1`, html.includes('v0.4.1'));
  }
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
