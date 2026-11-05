#!/usr/bin/env node
// v0.5.2 repair — tighten the depth-1 "related" definition (user-approved):
// a confirmed relation now requires DIRECT dealings with the validator
// itself: >=2 direct value transfers, or a two-way exchange (1+ each way,
// which also totals 2). One-off one-way contacts are demoted to a
// non-displayed CANDIDATE state (tier 'candidate', watch:false): their
// recorded events are purged, and the collector re-promotes them
// automatically when a second direct dealing with the validator occurs.
//
// Judgment data = ALL data, not just events.jsonl: the flow index
// (42-flowmap/flows.jsonl transfer legs, st=1, incl. leg-less native
// 'transfer' records, blocks <= 4193609 snapshot) PLUS tracker transfer
// events after the snapshot. Unit = one transfer leg — cross-checked
// against data.json's confirmed aggregates (101/103 pairs exact; the 2
// differences are post-snapshot growth, ours higher).
//
// Protections / scope guards (per the approved spec):
//  - X insider-section wallets: an entry eligible for the insider
//    section (related, not pair/core, depth<=1, X among its relations)
//    KEEPS its X relation even if it fails the new rule (2 such wallets,
//    flagged in the report), because the section's membership is a
//    separately user-confirmed display.
//  - Depth>=2 evidence-kept entries (12) are a different yardstick and
//    are NOT touched. Validator-tier entries are NOT touched
//    (validator<->validator links never affect a validator's own listing).
//
// Also: recompute validatorNames on every stored event (the collector
// derives it at classification time only), re-run the enrichment +
// history-flag migrations, and rebuild feed.json exactly as the
// collector's writeFeed does (plus the v0.5.2 selfActivity /
// relatedActivity per-validator fields). Writes tightening-report.json.
//
// Run: node repair-v052.mjs [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExcludedSet, recomputeWatchlistSummary, makeCtx, enrichEvent,
  computeHistoryFlags, computeBridgeChart, computeStakingStats, selectFeedEvents,
  hexToBech32, NOTABLE_42_THRESHOLD, SNIPE_RULE, BRIDGE_OUT_RULE, INSIDER_RULE,
  ESTIMATED_RULE, DORMANT_RULE,
} from './collector.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const FM = join(DIR, '..', '42-flowmap');
const SNAP = 4193609;
const lc = (a) => (a ? String(a).toLowerCase() : a);
const dryRun = process.argv.includes('--dry-run');

const watchlist = JSON.parse(readFileSync(join(DIR, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(DIR, 'registries.json'), 'utf8'));
const state = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'));
const oldFeed = JSON.parse(readFileSync(join(DIR, 'feed.json'), 'utf8'));
let creations = {};
try { creations = JSON.parse(readFileSync(join(DIR, 'pairs-creation.json'), 'utf8')); } catch { /* snipe flags stay as stored */ }
let events = readFileSync(join(DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const valAddr = new Map(), addrVal = new Map();
for (const e of watchlist.entries) if (e.tier === 'validator') { valAddr.set(e.label, lc(e.address)); addrVal.set(lc(e.address), e.label); }
const d1 = watchlist.entries.filter((e) => e.tier === 'related' && e.depth === undefined);
const d1Set = new Set(d1.map((e) => e.address));

// ---------- pair statistics over ALL data ----------
const stats = new Map(); // `${vAddr}|${addr}` -> {out (V->A), in (A->V)}
const bump = (vAddr, aAddr, dir) => {
  const k = vAddr + '|' + aAddr;
  if (!stats.has(k)) stats.set(k, { out: 0, in: 0 });
  stats.get(k)[dir]++;
};
const consider = (f, t) => {
  f = lc(f); t = lc(t);
  if (!f || !t || f === t) return;
  if (addrVal.has(f) && d1Set.has(t)) bump(f, t, 'out');
  else if (addrVal.has(t) && d1Set.has(f)) bump(t, f, 'in');
};
for (const l of readFileSync(join(FM, 'flows.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const r = JSON.parse(l);
  if (r.st !== 1) continue;
  const nl = (r.tt ?? []).length + (r.cs ?? []).length;
  for (const x of r.tt ?? []) consider(x.f, x.t);
  for (const x of r.cs ?? []) consider(x.f, x.t);
  if (nl === 0 && r.k === 'transfer') consider(r.f, r.to); // native send: the record itself
}
const TRANSFER_TYPES = new Set(['transfer', 'bridge-out', 'bridge-send-other', 'nft-transfer']);
for (const e of events) {
  if (!TRANSFER_TYPES.has(e.type) || !e.from || !e.to || !(e.block > SNAP)) continue;
  consider(e.from, e.to);
}

// ---------- judgment ----------
const isInsiderEligible = (e) => e.tier === 'related' && !e.isPair && !e.isCore && (e.depth ?? 1) <= 1 && (e.relatedValidators ?? []).includes('X');
const decisions = [];
const demoted = new Set();
for (const e of d1) {
  const perVal = {};
  for (const name of e.relatedValidators ?? []) {
    const s = stats.get(valAddr.get(name) + '|' + e.address) ?? { out: 0, in: 0 };
    perVal[name] = { out: s.out, in: s.in, total: s.out + s.in };
  }
  e.directStats = perVal;
  const keep = [], drop = [];
  for (const [name, s] of Object.entries(perVal)) (s.total >= 2 ? keep : drop).push(name);
  let protectedX = false;
  if (drop.includes('X') && isInsiderEligible(e)) { keep.push('X'); drop.splice(drop.indexOf('X'), 1); protectedX = true; e.protected = 'insider-x'; }
  if (keep.length) {
    e.relatedValidators = keep.sort();
    decisions.push({ address: e.address, action: protectedX ? 'kept (insider-protected)' : (drop.length ? 'kept (relations pruned)' : 'kept'), keep, drop, protectedX, perVal });
  } else {
    e.tier = 'candidate'; e.watch = false; e.relatedValidators = [];
    e.demotedAt = 'v0.5.2';
    e.demoteNote = '直接のやり取りが1回だけの一方通行のため関連から候補へ（v0.5.2 関連定義の締め付け）。2回目の直接取引で自動的に関連へ復帰';
    demoted.add(e.address);
    decisions.push({ address: e.address, action: 'demoted to candidate', keep, drop, perVal });
  }
}
const kept = decisions.filter((d) => d.action.startsWith('kept'));
const prunedRelations = decisions.reduce((n, d) => n + (d.drop?.length ?? 0), 0);
console.log(`judged ${d1.length} depth-1 entries: kept ${kept.length} (pruned relations ${prunedRelations}), demoted to candidate ${demoted.size}`);
for (const d of decisions.filter((d) => d.protectedX)) console.log(`  insider-protected (fails the rule vs X, kept): ${d.address} ${JSON.stringify(d.perVal)}`);

// ---------- purge demoted actors' events ----------
const beforeEvents = events.length;
events = events.filter((e) => !demoted.has(lc(e.actor)));
console.log(`events: ${beforeEvents} -> ${events.length} (purged ${beforeEvents - events.length} candidate-actor events)`);

// ---------- re-derive display fields under the new watchlist ----------
recomputeWatchlistSummary(watchlist);
const ctx = makeCtx(watchlist, registries);
function validatorNamesFor(actorEntry, counterpartyAddr) {
  const names = new Set();
  if (actorEntry?.tier === 'validator' && actorEntry.label) names.add(actorEntry.label);
  for (const n of actorEntry?.relatedValidators ?? []) names.add(n);
  const cp = counterpartyAddr ? ctx.entry(counterpartyAddr) : null;
  if (cp?.tier === 'validator' && cp.label) names.add(cp.label);
  for (const n of cp?.relatedValidators ?? []) if (actorEntry?.tier === 'validator') names.add(n);
  return [...names];
}
let vnChanged = 0;
for (const ev of events) {
  const names = validatorNamesFor(ctx.entry(ev.actor), ev.counterparty);
  if (JSON.stringify(names) !== JSON.stringify(ev.validatorNames ?? [])) { ev.validatorNames = names; vnChanged++; }
  enrichEvent(ev, ctx, creations);
}
console.log(`validatorNames recomputed: ${vnChanged} events changed`);
computeHistoryFlags(events, ctx);

// ---------- rebuild feed.json (mirror of collector writeFeed) ----------
const sorted = [...events].sort((a, b) => (b.block - a.block) || ((b.logIndex ?? -1) - (a.logIndex ?? -1)));
const validators = watchlist.entries.filter((e) => e.tier === 'validator').map((v) => ({
  moniker: v.label, address: v.address, bech32: hexToBech32(v.address), isCore: v.isCore,
  relatedCount: watchlist.entries.filter((e) => e.tier === 'related' && e.relatedValidators.includes(v.label)).length,
  selfActivity: events.filter((e) => e.actor === v.address).length,
  relatedActivity: events.filter((e) => e.actor !== v.address && (e.actorValidators ?? []).includes(v.label)).length,
  autoAddedCount: watchlist.entries.filter((e) => e.autoAdded && e.relatedValidators.includes(v.label)).length,
  estimatedCount: watchlist.entries.filter((e) => e.tier === 'estimated' && e.relatedValidators.includes(v.label)).length,
  ...(v.inactive ? { inactive: true } : {}),
}));
const feed = {
  generatedAt: new Date().toISOString(),
  status: {
    lastProcessedBlock: state.lastProcessedBlock, latestBlockSeen: state.lastProcessedBlock,
    lastProcessedCosmosBlock: state.lastProcessedCosmosBlock ?? null,
    lastProcessedAt: state.updatedAt, totalEvents: events.length,
    watchSummary: watchlist.summary,
    notableRule: `注目ルール：①バリデーター本人の売買 ②${NOTABLE_42_THRESHOLD.toLocaleString()} [42]以上の移動（ブリッジで外部へ送信は専用の緑色の欄に分けて表示）`,
    snipeRule: SNIPE_RULE, bridgeOutRule: BRIDGE_OUT_RULE, insiderRule: INSIDER_RULE,
    estimatedRule: ESTIMATED_RULE, dormantRule: DORMANT_RULE,
    ...(oldFeed.status?.chainValidators ? { chainValidators: oldFeed.status.chainValidators } : {}),
    ...(oldFeed.status?.validatorsAdded ? { validatorsAdded: oldFeed.status.validatorsAdded } : {}),
    actionRule: '操作の種類は、宛先コントラクトとメソッドから判別できた範囲で具体名を表示します（Fluke参加・NFTミント・報酬請求など）。判別できないものは「未分類の操作（メソッド／宛先）」と正直に表示します。',
    ...(oldFeed.status?.price ? { price: oldFeed.status.price } : {}),
  },
  stats: { staking: computeStakingStats(events, ctx), bridge: computeBridgeChart(events, ctx) },
  validators,
  events: selectFeedEvents(sorted),
};

// ---------- per-validator self/related for the report ----------
const split = {};
for (const v of validators) split[v.moniker] = { self: v.selfActivity, related: v.relatedActivity, relatedAddresses: v.relatedCount };
console.log('Woman-In-Red-42:', JSON.stringify(split['Woman-In-Red-42']));
console.log('Sirius Cybernetics:', JSON.stringify(split['Sirius Cybernetics']));
console.log('bridge total:', feed.stats.bridge.total, '/', feed.stats.bridge.count, 'events');

if (!dryRun) {
  writeFileSync(join(DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
  writeFileSync(join(DIR, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(DIR, 'feed.json'), JSON.stringify(feed, null, 1));
  writeFileSync(join(DIR, 'tightening-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), version: 'v0.5.2',
    rule: 'depth-1 related requires >=2 direct value transfers with the validator itself (either direction; two-way 1+1 also qualifies). Unit: one transfer leg over flows.jsonl (st=1, incl. native leg-less transfer records) + post-snapshot tracker transfer events.',
    judged: d1.length,
    kept: kept.length, prunedRelations,
    demotedToCandidate: demoted.size,
    removedNoBasis: 0,
    insiderProtected: decisions.filter((d) => d.protectedX).map((d) => ({ address: d.address, perVal: d.perVal, note: 'fails the new rule vs X (single one-way contact) but kept as related per the approved spec: insider-section membership is not dropped; flagged here as a warning' })),
    eventsBefore: beforeEvents, eventsAfter: events.length,
    eventsPurged: beforeEvents - events.length,
    splitAfter: split,
    bridgeAfter: { total: feed.stats.bridge.total, count: feed.stats.bridge.count, segTotals: feed.stats.bridge.segTotals },
    decisions,
  }, null, 1));
  console.log('written: watchlist.json, events.jsonl, feed.json, tightening-report.json');
} else console.log('(dry run — nothing written)');
