#!/usr/bin/env node
// Build the ESTIMATED tier of watchlist.json (Phase 3 / v0.3.0).
//
// Source: the 2026-10-31 flow-map research file
//   ~/workspace/42-flowmap/validator-estimates.json
// which computed, per validator, three kinds of ESTIMATED links (the methods
// were defined and approved in that research; see the file's "methods" notes):
//   P  through-pool : relaxed FIFO matching (24h window, <=10% amount gap)
//                     of a validator's pool leg against the SAME pair's
//                     opposite leg by another address. Score in the file.
//   H  2-hop        : validator -> X -> validator, both legs CONFIRMED
//                     transfers (core-mediated paths are kept separately in
//                     the file's "viaCore" list and are NOT used here).
//   S  shared       : third parties transacting directly with >= 2 validators.
//
// Honesty rules (standing user rules for this tracker):
//  - Estimates are a SEPARATE tier. Existing watchlist entries (validator /
//    related / core) are NEVER modified — this script only replaces the
//    tier:"estimated" entries it owns, and asserts the rest are untouched.
//  - Anything already watched (any tier), any pair (tracker registry or the
//    flow-map pair list), any validator itself, and any core/system address
//    is EXCLUDED from the estimated tier (e.g. the shared LP contract
//    0x71b13838…30E0 is already confirmed "related"; core-mediated 2-hop
//    intermediates are infrastructure, not estimated persons).
//  - If an address qualifies under several bases the strongest wins
//    (2hop > shared > pool); all validator links are recorded.
//  - Every estimated entry carries a CONCRETE basis text (amounts / time /
//    score, or the 2-hop path, or the shared-counterparty leg counts), in
//    Japanese and English, which the frontend shows verbatim as 推定の根拠.
//
// Run: node build-estimates.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FLOWMAP = join(__dir, '..', '42-flowmap');
const dry = process.argv.includes('--dry');

const estimates = JSON.parse(readFileSync(join(FLOWMAP, 'validator-estimates.json'), 'utf8'));
const flowPairs = JSON.parse(readFileSync(join(FLOWMAP, 'pairs.json'), 'utf8'));
const watchlistPath = join(__dir, 'watchlist.json');
const watchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));

const pairSet = new Set([...Object.keys(registries.pairs ?? {}), ...Object.keys(flowPairs.pairs ?? {})]);
const existing = new Map(); // address -> entry, non-estimated tiers only
for (const e of watchlist.entries) if (e.tier !== 'estimated') existing.set(e.address, e);
const validatorAddrs = new Map(); // address -> moniker (from watchlist)
for (const e of watchlist.entries) if (e.tier === 'validator') validatorAddrs.set(e.address, e.label);

// ---------- gather candidate bases per address ----------
// cand: address -> { pool: [{validator, moniker, asset, gapPct, dtSeconds, score, side}],
//                    shared: { validators: [{moniker, legs}], totalLegs },
//                    twohop: [{from, to, legs}] }
const cand = new Map();
const ensure = (a) => { if (!cand.has(a)) cand.set(a, {}); return cand.get(a); };

for (const [vAddr, bv] of Object.entries(estimates.byValidator ?? {})) {
  const moniker = bv.moniker ?? validatorAddrs.get(vAddr) ?? vAddr;
  for (const m of bv.poolThrough ?? []) {
    const c = ensure(m.counterparty);
    (c.pool ??= []).push({ validator: vAddr, moniker, asset: m.assetSymbol, gapPct: m.gapPct, dtSeconds: m.dtSeconds, score: m.score, side: m.validatorSide, inHuman: m.validatorInHuman, outHuman: m.validatorOutHuman });
  }
  for (const h of bv.twoHop ?? []) {
    // h is validator(vAddr) --legs--> via --legs--> other validator
    const via = h.via;
    const c = ensure(via);
    (c.twohop ??= []).push({ from: moniker, to: h.otherMoniker, legsFrom: h.legsFromValidator, legsTo: h.legsToOther });
  }
}
for (const s of estimates.sharedCounterparties ?? []) {
  const c = ensure(s.address);
  c.shared = { validators: s.validators.map((v) => ({ moniker: v.moniker, legs: v.inCount + v.outCount })), totalLegs: s.totalLegs };
}

// ---------- exclusion pass (with reasons, for the report) ----------
const excluded = [];
const kept = [];
for (const [addr, bases] of cand) {
  const kinds = Object.keys(bases);
  if (existing.has(addr)) { excluded.push({ addr, kinds, reason: `already watched (tier: ${existing.get(addr).tier})` }); continue; }
  if (pairSet.has(addr)) { excluded.push({ addr, kinds, reason: 'is a DEX pair' }); continue; }
  if (validatorAddrs.has(addr)) { excluded.push({ addr, kinds, reason: 'is a validator itself' }); continue; }
  kept.push({ addr, bases });
}

// ---------- basis texts ----------
const hrs = (s) => (s / 3600).toFixed(1);
function basisFor(addr, bases) {
  // strongest basis wins: 2hop > shared > pool
  const type = bases.twohop ? '2hop' : bases.shared ? 'shared' : 'pool';
  const validators = new Set();
  let text = '', textEn = '';
  if (type === '2hop') {
    const links = bases.twohop;
    for (const l of links) { validators.add(l.from); validators.add(l.to); }
    const l0 = links[0];
    text = `2ホップの推定：${l0.from} → このアドレス → ${l0.to} の両方向とも確認済みの直接送金があります（${l0.from}から${l0.legsFrom}件／${l0.to}へ${l0.legsTo}件）。経由した事実は確定ですが、両者の関係そのものは推定です`;
    textEn = `2-hop estimate: confirmed direct transfers run ${l0.from} -> this address -> ${l0.to} (${l0.legsFrom} legs in / ${l0.legsTo} legs out). The pass-through itself is confirmed; the relationship between the two validators is the estimate`;
  } else if (type === 'shared') {
    const vs = bases.shared.validators;
    for (const v of vs) validators.add(v.moniker);
    const names = vs.map((v) => v.moniker).join('・');
    text = `共通の相手先からの推定：${names} の${vs.length}名のバリデーターと直接の送受信が計${bases.shared.totalLegs}件あります。複数のバリデーターと取引する相手先ですが、各バリデーターとの関係は確定していません`;
    textEn = `Shared-counterparty estimate: this address transacted directly with ${vs.length} validators (${vs.map((v) => v.moniker).join(', ')}), ${bases.shared.totalLegs} legs in total. It deals with several validators, but no single relationship is confirmed`;
  } else {
    const ms = [...bases.pool].sort((a, b) => b.score - a.score);
    for (const m of ms) validators.add(m.moniker);
    const m = ms[0];
    if (m.side === 'to') {
      text = `プール経由の推定：${m.moniker} がプールから受け取った ${m.asset} と、このアドレスが先に同じプールへ売った分が、金額差 ${m.gapPct}%・時間差 約${hrs(m.dtSeconds)}時間で一致（スコア ${m.score}）。同じプールを経由しただけの別人の可能性もあり、確定した送金ではありません`;
      textEn = `Through-pool estimate: ${m.moniker} received ${m.asset} from a pool, and this address had sold into the same pool shortly before — amount gap ${m.gapPct}%, time gap about ${hrs(m.dtSeconds)}h (score ${m.score}). It may simply be a different person using the same pool; this is not a confirmed transfer`;
    } else {
      text = `プール経由の推定：${m.moniker} がプールへ売った ${m.asset} と、このアドレスが後に同じプールから買った分が、金額差 ${m.gapPct}%・時間差 約${hrs(m.dtSeconds)}時間で一致（スコア ${m.score}）。同じプールを経由しただけの別人の可能性もあり、確定した送金ではありません`;
      textEn = `Through-pool estimate: ${m.moniker} sold ${m.asset} into a pool, and this address bought from the same pool shortly after — amount gap ${m.gapPct}%, time gap about ${hrs(m.dtSeconds)}h (score ${m.score}). It may simply be a different person using the same pool; this is not a confirmed transfer`;
    }
  }
  // record every validator linked by ANY basis, not just the strongest
  for (const m of bases.pool ?? []) validators.add(m.moniker);
  if (bases.shared) for (const v of bases.shared.validators) validators.add(v.moniker);
  for (const l of bases.twohop ?? []) { validators.add(l.from); validators.add(l.to); }
  return { type, text, textEn, validators: [...validators] };
}

// ---------- merge ----------
const before = JSON.stringify(watchlist.entries.filter((e) => e.tier !== 'estimated'));
const newEntries = kept.map(({ addr, bases }) => {
  const b = basisFor(addr, bases);
  return {
    address: addr, tier: 'estimated', label: null, isCore: false, isPair: false, watch: true,
    validators: [], relatedValidators: b.validators,
    basisType: b.type, basisText: b.text, basisTextEn: b.textEn,
    estimateLinks: {
      ...(bases.pool ? { pool: bases.pool.map((m) => ({ validator: m.moniker, asset: m.asset, gapPct: m.gapPct, dtSeconds: m.dtSeconds, score: m.score, side: m.side })) } : {}),
      ...(bases.shared ? { shared: bases.shared } : {}),
      ...(bases.twohop ? { '2hop': bases.twohop } : {}),
    },
  };
}).sort((a, b2) => a.address.localeCompare(b2.address));

watchlist.entries = [...watchlist.entries.filter((e) => e.tier !== 'estimated'), ...newEntries];
const cnt = (t) => watchlist.entries.filter((e) => e.tier === t).length;
watchlist.summary = {
  ...watchlist.summary,
  validators: cnt('validator'), related: cnt('related'), core: cnt('core'), estimated: cnt('estimated'),
  watchedActors: watchlist.entries.filter((e) => e.watch).length,
  totalEntries: watchlist.entries.length,
};
watchlist.sources = {
  ...watchlist.sources,
  estimated: '42-flowmap/validator-estimates.json (2026-10-31 research: through-pool relaxed FIFO 24h/10%, 2-hop confirmed legs, shared counterparties >=2 validators); merged by build-estimates.mjs — estimates are a separate tier, always labelled 推定 with their basis, and never enter the confirmed-only sections',
};
const after = JSON.stringify(watchlist.entries.filter((e) => e.tier !== 'estimated'));
if (before !== after) { console.error('FATAL: non-estimated entries changed during merge'); process.exit(1); }

console.log(`estimated candidates: ${cand.size} | kept: ${newEntries.length} | excluded: ${excluded.length}`);
for (const e of newEntries) console.log(`  KEPT  ${e.address} [${e.basisType}] -> ${e.relatedValidators.join(', ')}`);
for (const x of excluded) console.log(`  EXCL  ${x.addr} [${x.kinds.join('+')}] — ${x.reason}`);
console.log('summary:', JSON.stringify(watchlist.summary));
if (!dry) { writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 1)); console.log('watchlist.json updated'); }
else console.log('(dry run — nothing written)');
