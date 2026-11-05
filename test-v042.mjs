#!/usr/bin/env node
// v0.4.2 regression tests — final scope:
//  (1) EOA-only person graph: no contract (per the bytecode census in
//      contract-audit.json) exists in the related/estimated tiers; the
//      v0.4.1 exceptions are gone (0x71b1...30e0 LP-holder contract and
//      the estimated shared counterparty 0x98fd...0e88 are core now);
//      0xf2ec...f015 stays core (bridge-type). Via chains of auto-added
//      entries never route through a contract/core/estimated hop.
//  (2) Evidence gate: every depth>=2 related entry carries wallet
//      evidence (valid codes, >=1 validator); the adopted/deleted sets
//      match evidence-repair-report.json; deleted addresses have no
//      watchlist entry and no actor events left.
//  (3) Bridge chart: feed.stats.bridge equals an independent
//      recomputation (collector computeBridgeChart over events.jsonl);
//      all 23 validators have bars (zeros included); every bridge-out
//      actor is the validator itself, a depth-1 wallet, or an
//      evidence-backed depth-2+ wallet.
//  (4) Live gates (unit): bytecode gate routes contracts to core;
//      depth-1 adds are free; depth-2 adds require wallet evidence
//      (bidirectional transfers pass, a single transfer does not).
//  (5) Permanent exclusion (env EXCLUDED_ACTORS): the mechanism works
//      with a DUMMY address (never a real one in this file); when the
//      suite itself runs with EXCLUDED_ACTORS set, the excluded
//      address is absent from watchlist / events / feed / reports.
// Run: node test-v042.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeCtx, computeBridgeChart, buildExcludedSet, excludedActorsFromEnv,
  isPermanentlyExcluded, maybeAutoAddLive, evidenceCodesFor,
} from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
const watchlist = JSON.parse(read('watchlist.json'));
const registries = JSON.parse(read('registries.json'));
const events = read('events.jsonl').trim().split('\n').map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));
const audit = JSON.parse(read('contract-audit.json'));
const evRep = JSON.parse(read('evidence-repair-report.json'));

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const EPS = 0.011;
const near = (a, b) => Math.abs(a - b) <= EPS;
const ent = new Map(watchlist.entries.map((e) => [e.address, e]));

// ---------- (1) EOA-only person graph ----------
const personContracts = watchlist.entries.filter((e) => (e.tier === 'related' || e.tier === 'estimated') && audit.results[e.address]?.decision === 'core');
check('no contract address exists in the related/estimated tiers', personContracts.length === 0, personContracts.map((e) => e.address).join(','));
check('every related/estimated entry was census-checked as EOA', watchlist.entries.filter((e) => e.tier === 'related' || e.tier === 'estimated').every((e) => audit.results[e.address]?.decision === 'eoa'));
check('0x71b1...30E0 (LP-holder contract) is core tier now — no exceptions', ent.get('0x71b138382598fbc4b890d2d20a14f9dedb1430e0')?.tier === 'core');
check('0x98fd...0e88 (estimated shared counterparty, a contract) is core tier now', ent.get('0x98fd9e32eaf45e0adf7f5c8bd7714f24a5dc0e88')?.tier === 'core');
check('estimated tier is EOA-only, 4 entries (through-pool only)', watchlist.entries.filter((e) => e.tier === 'estimated').length === 4);
const f015 = ent.get('0xf2ecb173b63699c49ace3faae80af5ce677af015');
check('0xf2ec...f015 stays core with the bridge-contract label', f015?.tier === 'core' && f015?.label === 'ブリッジ系コントラクト');
const badVia = watchlist.entries.filter((e) => e.autoAdded && e.via?.address && (() => { const v = ent.get(e.via.address); return !v || v.tier === 'core' || v.tier === 'estimated' || audit.results[e.via.address]?.decision === 'core'; })());
check('via-chain integrity: no auto-added entry routes via a contract/core/estimated/missing hop', badVia.length === 0, badVia.map((e) => e.address).join(','));

// ---------- (2) evidence gate ----------
const CODES = new Set(['bidirectional', 'funded-delegation', 'concentrated-repeat', 'one-way-repeat', 'delegation', 'synchronized']);
const d2 = watchlist.entries.filter((e) => e.tier === 'related' && (e.depth ?? 1) >= 2);
check('every depth>=2 related entry carries wallet evidence', d2.length > 0 && d2.every((e) => e.evidence && Object.keys(e.evidence).length >= 1), `${d2.length} entries`);
check('evidence codes are all from the defined set and name only attributed validators', d2.every((e) => Object.entries(e.evidence).every(([n, codes]) => (e.relatedValidators ?? []).includes(n) && codes.length >= 1 && codes.every((c) => CODES.has(c)))));
check('adopted set matches evidence-repair-report (12 entries)', evRep.adoptedCount === 12 && evRep.adopted.every((a) => ent.has(a.address) && JSON.stringify(ent.get(a.address).evidence) === JSON.stringify(a.evidence)));
const deletedSet = new Set(evRep.deleted.map((d) => d.address));
check('evidence-deleted set matches the report (84 entries), none in the watchlist', evRep.deletedCount === 84 && [...deletedSet].every((a) => !ent.has(a)));
check('no stored event keeps an evidence-deleted actor (except pair-created chain news)', events.every((e) => !deletedSet.has(e.actor) || e.type === 'pair-created'), events.find((e) => deletedSet.has(e.actor) && e.type !== 'pair-created')?.id);
check('evidence histogram on record: bidirectional 11 / concentrated-repeat 2 / delegation 1 / synchronized 1', evRep.codeAddressCounts.bidirectional === 11 && evRep.codeAddressCounts['concentrated-repeat'] === 2 && evRep.codeAddressCounts.delegation === 1 && evRep.codeAddressCounts.synchronized === 1, JSON.stringify(evRep.codeAddressCounts));
// threshold unit checks on the shared implementation
check('evidenceCodesFor: bidirectional alone adopts (strong)', evidenceCodesFor({ inN: 1, outN: 1 }).adopted === true);
check('evidenceCodesFor: funded-delegation adopts (strong)', evidenceCodesFor({ inN: 2, received42: 100n, delegated42: 60n, delegateCount: 1 }).adopted === true);
check('evidenceCodesFor: concentrated-repeat adopts (strong)', evidenceCodesFor({ inN: 3, outN: 2, totalVS: 9 }).adopted === true);
check('evidenceCodesFor: a single weak signal does not adopt', evidenceCodesFor({ inN: 3, outN: 0 }).adopted === false && evidenceCodesFor({ delegateCount: 1 }).adopted === false);
check('evidenceCodesFor: two weak signals adopt', evidenceCodesFor({ delegateCount: 1, sync: true }).adopted === true && evidenceCodesFor({ inN: 4, outN: 0, delegateCount: 1 }).adopted === true);

// ---------- (3) bridge chart ----------
const S = feed.stats.bridge;
check('feed.stats.bridge exists with all 23 validator bars', !!S && S.perValidator.length === 23, S ? `${S.perValidator.length} bars` : 'missing');
const recomputed = computeBridgeChart(events, makeCtx(watchlist, registries));
check('chart: deduplicated total equals the independent recomputation', near(S.total, recomputed.total), `${S.total} vs ${recomputed.total}`);
check('chart: every bar equals the independent recomputation', S.perValidator.every((g) => { const r = recomputed.perValidator.find((x) => x.moniker === g.moniker); return r && near(g.total, r.total) && g.seg.every((v, i) => near(v, r.seg[i])) && g.count === r.count; }));
check('chart: segment totals equal the recomputation', S.segTotals.every((v, i) => near(v, recomputed.segTotals[i])));
check('chart: zero bars are present (validators without any bridge-out still listed)', S.perValidator.some((g) => g.total === 0));
const boActorsOk = events.filter((e) => e.type === 'bridge-out').every((e) => {
  const a = ent.get(e.actor);
  if (!a) return e.actorTier == null;
  if (a.tier === 'validator' || a.tier === 'related') return (a.depth ?? 1) < 2 || !!a.evidence;
  return false;
});
check('chart population: every bridge-out actor is self / depth-1 / evidence-backed depth-2+', boActorsOk);
check('chart after evidence gate: total 8,763.62 over 22 events (record)', near(evRep.after.bridge.total, 8763.62) && evRep.after.bridge.count === 22, `${evRep.after.bridge.total}/${evRep.after.bridge.count}`);

// ---------- (4) live gates (unit) ----------
const clone = () => JSON.parse(JSON.stringify(watchlist));
const val = watchlist.entries.find((e) => e.tier === 'validator' && e.label === 'Xenia');
const orig = watchlist.entries.find((e) => e.tier === 'related' && !e.autoAdded && (e.relatedValidators ?? []).includes('Xenia'));
const noContract = async () => false;
const yesContract = async () => true;
const FRESH1 = '0x' + 'a1'.repeat(20), FRESH2 = '0x' + 'a2'.repeat(20), FRESH3 = '0x' + 'a3'.repeat(20), FRESH4 = '0x' + 'a4'.repeat(20);
{
  const wl = clone(); const ctx = makeCtx(wl, registries);
  const r = await maybeAutoAddLive(wl, ctx, { actor: val.address, counterparty: FRESH1, ts: 1, txHash: '0x0' }, new Set(), { isContractFn: yesContract, events: [] });
  check('live gate: a contract counterparty is routed to core, never to related', !!r?.contract && ctx.entry(FRESH1)?.tier === 'core');
}
{
  // v0.5.2 supersedes the v0.4.2 "added freely" rule: a validator's
  // first direct contact becomes a one-off CANDIDATE (not related);
  // the second direct dealing promotes it to related automatically.
  const wl = clone(); const ctx = makeCtx(wl, registries);
  const ev1 = { type: 'transfer', actor: val.address, counterparty: FRESH2, from: val.address, to: FRESH2, ts: 1, txHash: '0x1' };
  const r = await maybeAutoAddLive(wl, ctx, ev1, new Set(), { isContractFn: noContract, events: [] });
  check('live gate (v0.5.2): a first depth-1 contact becomes a candidate, not related', !!r?.candidate && ctx.entry(FRESH2)?.tier === 'candidate' && ctx.entry(FRESH2)?.watch === false, JSON.stringify(r));
  const ev2 = { type: 'transfer', actor: val.address, counterparty: FRESH2, from: FRESH2, to: val.address, ts: 2, txHash: '0x2' };
  const r2 = await maybeAutoAddLive(wl, ctx, ev2, new Set(), { isContractFn: noContract, events: [] });
  check('live gate (v0.5.2): the second direct dealing promotes the candidate to related', !!r2?.promoted && ctx.entry(FRESH2)?.tier === 'related' && ctx.entry(FRESH2)?.watch === true && (ctx.entry(FRESH2)?.relatedValidators ?? []).includes(val.label), JSON.stringify(r2?.promoted?.relatedValidators ?? null));
}
{
  const wl = clone(); const ctx = makeCtx(wl, registries);
  const evs = [{ type: 'transfer', actor: orig.address, counterparty: FRESH3, ts: 10, amount: null }];
  const r = await maybeAutoAddLive(wl, ctx, { actor: orig.address, counterparty: FRESH3, ts: 20, txHash: '0x0' }, new Set(), { isContractFn: noContract, events: evs });
  check('live gate: a depth-2 candidate with only one transfer is NOT added', r === null && !ctx.entry(FRESH3));
}
{
  const wl = clone(); const ctx = makeCtx(wl, registries);
  const evs = [
    { type: 'transfer', actor: orig.address, counterparty: FRESH4, ts: 10, amount: null },
    { type: 'transfer', actor: FRESH4, counterparty: orig.address, ts: 11, amount: null },
  ];
  const r = await maybeAutoAddLive(wl, ctx, { actor: orig.address, counterparty: FRESH4, ts: 20, txHash: '0x0' }, new Set(), { isContractFn: noContract, events: evs });
  check('live gate: a depth-2 candidate with bidirectional transfers IS added, with evidence recorded', !!r && r.tier === 'related' && r.depth === 2 && !!r.evidence && Object.values(r.evidence).some((codes) => codes.includes('bidirectional')), JSON.stringify(r?.evidence ?? null));
}

// ---------- (5) permanent exclusion mechanism ----------
const DUMMY = '0x' + 'deadbeef'.repeat(5);
{
  const saved = process.env.EXCLUDED_ACTORS;
  process.env.EXCLUDED_ACTORS = DUMMY;
  try {
    check('exclusion: env address is parsed by excludedActorsFromEnv', excludedActorsFromEnv().has(DUMMY));
    check('exclusion: isPermanentlyExcluded answers true for the env address', isPermanentlyExcluded(DUMMY) === true);
    const ex = buildExcludedSet(watchlist, registries);
    check('exclusion: buildExcludedSet merges the env address', ex.has(DUMMY));
    const wl = clone(); const ctx = makeCtx(wl, registries);
    const r = await maybeAutoAddLive(wl, ctx, { actor: val.address, counterparty: DUMMY, ts: 1, txHash: '0x0' }, ex, { isContractFn: noContract, events: [] });
    check('exclusion: an event with the excluded address as counterparty never adds it', r === null && !ctx.entry(DUMMY));
  } finally {
    if (saved == null) delete process.env.EXCLUDED_ACTORS; else process.env.EXCLUDED_ACTORS = saved;
  }
}
if (process.env.EXCLUDED_ACTORS) {
  const excl = excludedActorsFromEnv();
  check('exclusion (live env): no excluded address has a watchlist entry', [...excl].every((a) => !ent.has(a)));
  check('exclusion (live env): zero actor events for excluded addresses in events.jsonl', events.every((e) => !excl.has(e.actor)));
  check('exclusion (live env): zero actor events for excluded addresses in feed.json', feed.events.every((e) => !excl.has(e.actor)));
  const repText = read('eoa-repair-report.json') + read('evidence-repair-report.json') + read('contract-audit.json');
  check('exclusion (live env): excluded addresses appear in no repair/audit report', [...excl].every((a) => !repText.includes(a)));
} else {
  console.log('SKIP exclusion live-env assertions (EXCLUDED_ACTORS not set in this process)');
}

// ---------- (6) site definition texts ----------
const idx = read('index.html'); const en = read('en.html');
check('JP scope note: contracts are never counted or transited', idx.includes('プログラム（コントラクト）のアドレスは、人の関連としては数えず、経由もしません'));
check('JP scope note: shared alone is not infrastructure (bytecode only)', idx.includes('共有の財布というだけでは仕組み系にしません。プログラム（コントラクト）かどうかだけで判定します'));
check('JP scope/chart rule: depth-2+ counted only with own-wallet evidence', idx.includes('2段目以降は、バリデーター本人の財布らしい証拠（双方向の資金移動など）があるものだけを数えます。証拠のない一般のアドレスは数えません'));
check('EN scope note: contracts are never counted or transited', en.includes('Program (contract) addresses are not counted as a person\u2019s relations, and connections are never traced through them') || en.includes("Program (contract) addresses are not counted as a person's relations, and connections are never traced through them"));
check('EN scope note: shared alone is not infrastructure', en.includes('never treated as infrastructure just for being a shared wallet'));
check('EN chart rule: depth-2+ counted only with evidence', en.includes('Depth-2+ wallets are counted only when there is evidence they are the validator\u2019s own wallet') || en.includes("Depth-2+ wallets are counted only when there is evidence they are the validator's own wallet"));
check('versions bumped to v0.4.2 on all four pages', idx.includes('v0.4.2') && en.includes('v0.4.2') && read('home.html').includes('v0.4.2') && read('home-en.html').includes('v0.4.2'));

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
