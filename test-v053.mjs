#!/usr/bin/env node
// v0.5.3 regression test: depth-1-only scope + full-history backfill with
// the guide-reward exclusion.
//  (1) Scope: exactly 73 watched addresses (23 validators + 50 confirmed
//      depth-1 related); no estimated entries; no related entry at
//      depth >= 2; the 37 one-off candidates stay unwatched.
//  (2) The 16 removed entries (12 evidence-kept depth>=2 + 4 estimated,
//      listed in v053-scope-report.json) are absent from the watchlist
//      and have no actor events left. The two protected X insider
//      wallets (…b242 / …aade) stay related.
//  (3) Guide-reward exclusion: the Starlight fund/claim txs identified
//      in the audit are absent; no reward-claim-starlight events exist;
//      Starlight registrations and Guide/Fluke activity are present.
//  (4) Depth>=2 adoption is retired in the live collector: a depth-2
//      candidate with bidirectional transfers is NOT added.
//  (5) Reports agree: v053-backfill-report.json records 6,432 backfilled
//      events, 24 excluded guide-reward txs and a zero unintentional
//      residual in the re-audit; feed totals match the record.
// Run: node test-v053.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, maybeAutoAddLive } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const watchlist = JSON.parse(read('watchlist.json'));
const registries = JSON.parse(read('registries.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));
const ent = new Map(watchlist.entries.map((e) => [e.address.toLowerCase(), e]));

// ---------- (1) scope ----------
const watched = watchlist.entries.filter((e) => e.watch);
check('watched addresses = 73', watched.length === 73, String(watched.length));
check('watched = 23 validators + 50 related', watched.filter((e) => e.tier === 'validator').length === 23 && watched.filter((e) => e.tier === 'related').length === 50);
check('no estimated entries', watchlist.entries.every((e) => e.tier !== 'estimated'));
check('no related entry at depth >= 2', watchlist.entries.every((e) => e.tier !== 'related' || (e.depth ?? 1) <= 1));
check('candidates = 37, all unwatched', watchlist.entries.filter((e) => e.tier === 'candidate').length === 37 && watchlist.entries.filter((e) => e.tier === 'candidate').every((e) => e.watch === false));
check('feed watchSummary agrees (73 watched / 0 estimated)', feed.status.watchSummary.watchedActors === 73 && feed.status.watchSummary.estimated === 0);
check('bridge chart depth-2+ segment is exactly 0', feed.stats.bridge.segTotals[2] === 0, JSON.stringify(feed.stats.bridge.segTotals));

// ---------- (2) the removed 16 ----------
const scopeRep = JSON.parse(read('v053-scope-report.json'));
const removed = [...(scopeRep.removedEvidence ?? []), ...(scopeRep.removedEstimated ?? [])];
check('scope report lists 16 removed entries (12 evidence + 4 estimated)', removed.length === 16 && (scopeRep.removedEvidence ?? []).length === 12 && (scopeRep.removedEstimated ?? []).length === 4, String(removed.length));
const removedAddrs = new Set(removed.map((r) => (r.address || '').toLowerCase()));
check('removed entries are absent from the watchlist', [...removedAddrs].every((a) => !ent.has(a)));
check('no actor events remain for removed entries (except pair-created chain news, the standing exception)', events.every((e) => !removedAddrs.has((e.actor || '').toLowerCase()) || e.type === 'pair-created'), String(events.filter((e) => removedAddrs.has((e.actor || '').toLowerCase()) && e.type !== 'pair-created').length));
for (const a of ['0xc8de941efb92925bfd359a7a380399e47bc2b242', '0xf75b159860f3de7f229e22d08eab844fd97baade']) {
  const e = ent.get(a);
  check(`protected X insider wallet stays related: …${a.slice(-4)}`, !!e && e.tier === 'related' && e.watch === true && (e.relatedValidators ?? []).includes('X'));
}

// ---------- (3) guide-reward exclusion ----------
const evHashes = new Set(events.map((e) => (e.txHash || '').toLowerCase()));
for (const [h, what] of [
  ['0x15d6cd6976e3f00827e58f8d04e4903bdbee680c536ebe81d3ace7e55d0452fe', 'Starlight fund 500 [42]'],
  ['0x4660b0ebf17f547cefdbf9b66ad8aba54e99beee81ce33ce20f8fbafa8b65ef2', 'Starlight fund 2,500 [42]'],
  ['0x3827c3684679281d3840895de3b6f68abfa5093c237612252445b1b61e486d68', 'Starlight fund (…8807)'],
  ['0x7f86451b14a9bfef235e6dd1d5ce5b1a688ee02e62863c822b6eceb847e27e46', 'Starlight fund (…8807)'],
  ['0xeee33994a62e566e3c9e975335605fd6c6dfd7f37801106c1f6987bf466ef725', 'Starlight claim (…8807)'],
]) check(`guide-reward tx absent: ${what}`, !evHashes.has(h));
check('no reward-claim-starlight events', events.every((e) => e.type !== 'reward-claim-starlight'));
check('Starlight registrations kept (13)', events.filter((e) => e.type === 'starlight-register').length === 13, String(events.filter((e) => e.type === 'starlight-register').length));
const GUIDE = '0xf349e469c474048ded6f9b914309e76880ed1bbd';
check('Guide/Fluke activity kept (counterparty events > 1000)', events.filter((e) => (e.counterparty || '').toLowerCase() === GUIDE).length > 1000, String(events.filter((e) => (e.counterparty || '').toLowerCase() === GUIDE).length));

// ---------- (4) depth>=2 adoption retired (live path) ----------
{
  const wl = JSON.parse(JSON.stringify(watchlist));
  const ctx = makeCtx(wl, registries, {});
  const rel = wl.entries.find((e) => e.tier === 'related');
  const FRESH = '0x' + '77'.repeat(20);
  const evs = [
    { type: 'transfer', actor: rel.address, counterparty: FRESH, ts: 10, amount: null },
    { type: 'transfer', actor: FRESH, counterparty: rel.address, ts: 11, amount: null },
  ];
  const r = await maybeAutoAddLive(wl, ctx, { actor: rel.address, counterparty: FRESH, ts: 20, txHash: '0x0' }, new Set(), { isContractFn: async () => false, events: evs });
  check('depth-2 candidate with bidirectional transfers is NOT adopted (retired)', r === null && !ctx.entry(FRESH), JSON.stringify(r));
}

// ---------- (5) reports ----------
const bfRep = JSON.parse(read('v053-backfill-report.json'));
check('backfill report: 6,432 events added by the flows pass', bfRep.addedEvm + bfRep.addedCosmos === 6432, `${bfRep.addedEvm}+${bfRep.addedCosmos}`);
check('backfill report: 24 guide-reward txs excluded', bfRep.guideRewardExcluded.txs === 24 && bfRep.guideRewardExcluded.events === 24);
check('backfill report: re-audit unintentional residual = 0', bfRep.reaudit.unintentionalResidual === 0);
check('feed totalEvents matches the stored record', feed.status.totalEvents === events.length, `${feed.status.totalEvents} vs ${events.length}`);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
