#!/usr/bin/env node
// v0.5.3 repair — narrow the tracker scope to depth-1 only (user decision
// 「1段目までにする」):
//  - the 12 evidence-kept depth>=2 related entries (HeraMoon 7, FoxxOne 4,
//    X 1) and the 4 estimated-tier entries are REMOVED from the watchlist,
//    and every event they authored is purged — the same treatment as the
//    v0.4.2 general-address purge. Events where a removed address appears
//    only as a counterparty stay (status quo of every earlier purge).
//  - X's two prelist-protected wallets are depth-1 related and are NOT
//    touched.
// After this repair the watched set is validators (23) + confirmed
// depth-1 related (50) = 73 addresses. The matching collector change
// retires depth>=2 adoption entirely (no evidence gate any more).
//
// Also (mirror of repair-v052): recompute validatorNames on every stored
// event, re-run enrichment + history flags, rebuild feed.json exactly as
// the collector's writeFeed does. Writes v053-scope-report.json.
//
// Run: node repair-v053.mjs [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recomputeWatchlistSummary, makeCtx, enrichEvent,
  computeHistoryFlags, computeBridgeChart, computeStakingStats, selectFeedEvents,
  hexToBech32, NOTABLE_42_THRESHOLD, SNIPE_RULE, BRIDGE_OUT_RULE, PRELIST_RULE,
  ESTIMATED_RULE, DORMANT_RULE,
} from './collector.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const lc = (a) => (a ? String(a).toLowerCase() : a);
const dryRun = process.argv.includes('--dry-run');

const watchlist = JSON.parse(readFileSync(join(DIR, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(DIR, 'registries.json'), 'utf8'));
const state = JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'));
const oldFeed = JSON.parse(readFileSync(join(DIR, 'feed.json'), 'utf8'));
let creations = {};
try { creations = JSON.parse(readFileSync(join(DIR, 'pairs-creation.json'), 'utf8')); } catch { /* snipe flags stay as stored */ }
let events = readFileSync(join(DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---------- identify removals ----------
const removedEvidence = watchlist.entries.filter((e) => e.tier === 'related' && (e.depth ?? 1) >= 2);
const removedEstimated = watchlist.entries.filter((e) => e.tier === 'estimated');
const removed = [...removedEvidence, ...removedEstimated];
const removedSet = new Set(removed.map((e) => lc(e.address)));
console.log(`removing ${removed.length} entries: evidence depth>=2 ${removedEvidence.length}, estimated ${removedEstimated.length}`);
const byVal = {};
for (const e of removedEvidence) for (const n of e.relatedValidators ?? []) byVal[n] = (byVal[n] ?? 0) + 1;
console.log('evidence removals by validator:', JSON.stringify(byVal));
for (const e of removed) console.log(`  - …${e.address.slice(-4)} tier=${e.tier} depth=${e.depth ?? 1} rel=${JSON.stringify(e.relatedValidators ?? [])}`);
const prot = watchlist.entries.filter((e) => e.protected);
console.log('protected entries (must stay, depth-1):', prot.map((e) => '…' + e.address.slice(-4) + ' depth=' + (e.depth ?? 1)).join(', '));
if (removed.length !== 16) { console.error('ABORT: expected 16 removals'); process.exit(1); }
if (prot.some((e) => removedSet.has(lc(e.address)))) { console.error('ABORT: a protected entry is in the removal set'); process.exit(1); }

// ---------- purge ----------
const beforeEvents = events.length;
const purgedByActor = {};
events = events.filter((e) => {
  if (removedSet.has(lc(e.actor))) { purgedByActor[e.actor] = (purgedByActor[e.actor] ?? 0) + 1; return false; }
  return true;
});
console.log(`events: ${beforeEvents} -> ${events.length} (purged ${beforeEvents - events.length} removed-actor events)`);
watchlist.entries = watchlist.entries.filter((e) => !removedSet.has(lc(e.address)));

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
    snipeRule: SNIPE_RULE, bridgeOutRule: BRIDGE_OUT_RULE, prelistRule: PRELIST_RULE,
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

const split = {};
for (const v of validators) split[v.moniker] = { self: v.selfActivity, related: v.relatedActivity, relatedAddresses: v.relatedCount };
console.log('bridge total:', feed.stats.bridge.total, '/', feed.stats.bridge.count, 'events; segs:', JSON.stringify(feed.stats.bridge.segTotals));
console.log('prelist-flagged events:', events.filter((e) => e.isPrelist).length, '| snipe:', events.filter((e) => e.isSnipe).length, '| dormant:', events.filter((e) => e.isDormantReturn).length);
console.log('summary after:', JSON.stringify(watchlist.summary));

if (!dryRun) {
  writeFileSync(join(DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
  writeFileSync(join(DIR, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(DIR, 'feed.json'), JSON.stringify(feed, null, 1));
  writeFileSync(join(DIR, 'v053-scope-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), version: 'v0.5.3',
    rule: 'Scope narrowed to depth-1 only (user decision): validators + confirmed depth-1 related. The 12 evidence-kept depth>=2 entries and the 4 estimated entries are removed from the watchlist and their authored events purged (counterparty-only mentions stay). Depth>=2 adoption is retired in the collector.',
    removedEvidence: removedEvidence.map((e) => ({ address: e.address, depth: e.depth, relatedValidators: e.relatedValidators, evidence: e.evidence ?? null, eventsPurged: purgedByActor[e.address] ?? 0 })),
    removedEstimated: removedEstimated.map((e) => ({ address: e.address, relatedValidators: e.relatedValidators, basisType: e.basisType ?? null, eventsPurged: purgedByActor[e.address] ?? 0 })),
    eventsBefore: beforeEvents, eventsAfter: events.length, eventsPurged: beforeEvents - events.length,
    watchedAfter: watchlist.summary.watchedActors, entriesAfter: watchlist.entries.length,
    splitAfter: split,
    bridgeAfter: { total: feed.stats.bridge.total, count: feed.stats.bridge.count, segTotals: feed.stats.bridge.segTotals },
  }, null, 1));
  console.log('written: watchlist.json, events.jsonl, feed.json, v053-scope-report.json');
} else console.log('(dry run — nothing written)');
