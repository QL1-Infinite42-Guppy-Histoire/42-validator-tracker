#!/usr/bin/env node
// repair-eoa-only.mjs — v0.4.2: enforce the EOA-only person graph.
//
// USER RULES applied here (2026-11-05):
//  1. 「仕組み系は全部排除」 — EVERY contract (per the bytecode census in
//     contract-audit.json) leaves the person tiers. Contracts found in
//     related/estimated move to the core registry (tier 'core', label
//     only, for counterparty display); unknown ones are labelled
//     「コントラクト（未分類）」. Bytecode is the ONLY test — being
//     shared between validators never makes an EOA infrastructure.
//  2. The closure is recomputed with traversal through EOAs only
//     (build-closure / repair-closure rules; contracts, core entries,
//     estimated entries and permanently excluded addresses are barred
//     as transit AND as endpoints). Auto-added entries that lose every
//     EOA path are removed.
//  3. Permanently excluded addresses (env EXCLUDED_ACTORS — held in a
//     GitHub Actions secret in production, never in a repo file) are
//     removed from the watchlist entirely.
//  4. Events whose ACTOR is a contract, a removed entry, or a
//     permanently excluded address are purged from events.jsonl.
//     Events where they appear only as COUNTERPARTY stay, relabelled
//     with the core label where applicable.
// feed.json is NOT touched here — the collector regenerates it on its
// next run (with the same env), which also re-derives the pinned
// sections and the bridge chart on the corrected data.
//
// Report: eoa-repair-report.json (counts + the moved-contract list;
// permanently excluded addresses are reported as a COUNT only).

import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildExcludedSet, recomputeWatchlistSummary, excludedActorsFromEnv,
  makeCtx, computeBridgeChart,
} from './collector.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const lc = (a) => (a ? String(a).toLowerCase() : a);
const HOLDER = '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25'; // #1 holder: category-B core-flagged seed (repair-closure precedent)

const watchlist = JSON.parse(readFileSync(join(DIR, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(DIR, 'registries.json'), 'utf8'));
const audit = JSON.parse(readFileSync(join(DIR, 'contract-audit.json'), 'utf8'));
const auditCore = new Set(Object.entries(audit.results).filter(([, r]) => r.decision === 'core').map(([a]) => a));
const envExcl = excludedActorsFromEnv();

let events = readFileSync(join(DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const tierCounts = (wl) => {
  const t = {};
  for (const e of wl.entries) t[e.tier] = (t[e.tier] ?? 0) + 1;
  return t;
};
const before = {
  watchlistTotal: watchlist.entries.length,
  tiers: tierCounts(watchlist),
  events: events.length,
  bridge: computeBridgeChart(events, makeCtx(watchlist, registries)),
};
console.log(`before: entries ${before.watchlistTotal} ${JSON.stringify(before.tiers)}; events ${before.events}; bridge total ${before.bridge.total} (${before.bridge.count}件)`);

// ---------- 1. permanently excluded entries out ----------
const excludedEntries = watchlist.entries.filter((e) => envExcl.has(e.address));
if (excludedEntries.length) watchlist.entries = watchlist.entries.filter((e) => !envExcl.has(e.address));
console.log(`permanently excluded entries removed: ${excludedEntries.length}`);

// ---------- 2. person-tier contracts -> core registry ----------
const movedContracts = [];
for (const e of watchlist.entries) {
  if ((e.tier === 'related' || e.tier === 'estimated') && auditCore.has(e.address)) {
    const a = audit.results[e.address];
    movedContracts.push({ address: e.address, label: a.label ?? e.label ?? 'コントラクト（未分類）', formerTier: e.tier, formerDepth: e.depth ?? null, codeBytes: a.codeBytes });
    e.tier = 'core';
    e.isCore = true;
    e.watch = false;
    e.label = a.label ?? e.label ?? 'コントラクト（未分類）';
    e.coreNote = 'v0.4.2: バイトコード監査でコントラクトと判明したため仕組み系へ（人の関連からは除外）';
    delete e.depth; delete e.via; delete e.autoAdded; delete e.basisNote;
    e.relatedValidators = [];
  }
}
console.log(`contracts moved from person tiers to core: ${movedContracts.length}`);

// ---------- 3. EOA-only closure recompute ----------
const adj = new Map(); const edgeFirst = new Map();
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const addEdge = (a, b, ts) => {
  if (!a || !b || a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b); adj.get(b).add(a);
  const k = key(a, b);
  if (!edgeFirst.has(k) || ts < edgeFirst.get(k).ts) edgeFirst.set(k, { ts });
};
{
  const rl = createInterface({ input: createReadStream(join(DIR, '..', '42-flowmap', 'flows.jsonl')), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const f = JSON.parse(line);
    if (f.st !== 1) continue;
    // Same edge sources as build-closure / repair-closure: the flow's
    // own from/to PLUS its value-transfer legs (tt = EVM token
    // transfers, cs = Cosmos legs).
    addEdge(lc(f.from), lc(f.to), f.ts ?? 0);
    for (const t of f.tt ?? []) addEdge(lc(t.f), lc(t.t), f.ts ?? 0);
    for (const c of f.cs ?? []) addEdge(lc(c.f), lc(c.t), f.ts ?? 0);
  }
}
for (const e of events) if (e.counterparty) addEdge(e.actor, e.counterparty, e.ts ?? 0);

const flowmap = JSON.parse(readFileSync(join(DIR, '..', '42-flowmap', 'data.json'), 'utf8'));
const entries = new Map(watchlist.entries.map((e) => [e.address, e]));
const barred = buildExcludedSet(watchlist, registries);
for (const a of envExcl) barred.add(a);
for (const a of auditCore) barred.add(a);
for (const e of watchlist.entries) {
  if (e.tier === 'core') barred.add(e.address);
  if (e.tier === 'estimated') barred.add(e.address);
  if (e.isCore && e.address !== HOLDER) barred.add(e.address);
}
const candidates = new Map();
for (const e of watchlist.entries) if (e.autoAdded && e.tier === 'related') candidates.set(e.address, e);

const depth = new Map(); const seedNames = new Map();
for (const e of watchlist.entries) {
  if (e.tier === 'validator') { depth.set(e.address, 0); seedNames.set(e.address, new Set([e.label])); }
  else if (e.tier === 'related' && !e.autoAdded && (!e.isCore || e.address === HOLDER)) { depth.set(e.address, e.depth ?? 1); seedNames.set(e.address, new Set(e.relatedValidators ?? [])); }
}
const forced = new Map();
for (const v of flowmap.validators ?? []) for (const c of v.confirmed ?? []) {
  const a = lc(c.counterparty);
  if (!forced.has(a)) forced.set(a, new Set());
  forced.get(a).add(v.moniker);
}
const passable = (a) => entries.has(a) && !barred.has(a);
const queue = [...depth.keys()].sort((x, y) => depth.get(x) - depth.get(y));
const inQueue = new Set(queue);
while (queue.length) {
  let mi = 0;
  for (let i = 1; i < queue.length; i++) if (depth.get(queue[i]) < depth.get(queue[mi])) mi = i;
  const cur = queue.splice(mi, 1)[0];
  const d = depth.get(cur);
  for (const nb of adj.get(cur) ?? []) {
    if (depth.has(nb) || !passable(nb)) continue;
    depth.set(nb, d + 1);
    if (!inQueue.has(nb)) { queue.push(nb); inQueue.add(nb); }
  }
}
for (const a of candidates.keys()) {
  if (!depth.has(a) && forced.has(a) && !barred.has(a)) depth.set(a, 1);
}
const names = new Map(seedNames);
const ordered = [...candidates.keys()].filter((a) => depth.has(a)).sort((x, y) => depth.get(x) - depth.get(y));
const updated = [];
for (const a of ordered) {
  const d = depth.get(a);
  const ns = new Set(forced.get(a) ?? []);
  let via = null, viaFirst = null;
  for (const nb of adj.get(a) ?? []) {
    if (!depth.has(nb) || depth.get(nb) >= d) continue;
    for (const n of names.get(nb) ?? []) ns.add(n);
    const f = edgeFirst.get(key(a, nb));
    if (f && (!viaFirst || f.ts < viaFirst.ts)) { via = nb; viaFirst = f; }
  }
  if (!via) {
    const vName = [...(forced.get(a) ?? [])][0];
    via = watchlist.entries.find((e) => e.tier === 'validator' && e.label === vName)?.address ?? null;
  }
  names.set(a, ns);
  const e = candidates.get(a);
  const newVia = { address: via, validators: via ? [...(names.get(via) ?? [])].sort() : [] };
  const changed = e.depth !== d || JSON.stringify([...ns].sort()) !== JSON.stringify(e.relatedValidators ?? []) || JSON.stringify(newVia) !== JSON.stringify(e.via ?? null);
  if (changed) updated.push({ address: a, fromDepth: e.depth ?? null, toDepth: d, via });
  e.depth = d; e.relatedValidators = [...ns].sort(); e.via = newVia;
}
const removed = [];
for (const [a, e] of candidates) {
  if (depth.has(a)) continue;
  removed.push({ address: a, depth: e.depth ?? null, via: e.via?.address ?? null, validators: e.relatedValidators ?? [] });
}
const removedSet = new Set(removed.map((r) => r.address));
if (removedSet.size) watchlist.entries = watchlist.entries.filter((e) => !removedSet.has(e.address));
console.log(`closure entries: kept ${ordered.length}, updated ${updated.length}, removed ${removed.length}`);

// ---------- 4. events purge + counterparty relabel ----------
const coreEntryAddrs = new Set(watchlist.entries.filter((e) => e.tier === 'core').map((e) => e.address));
const purgeExcluded = new Set(excludedEntries.map((e) => e.address));
let purgedContract = 0, purgedExcluded = 0, purgedRemoved = 0;
const evBefore = events.length;
events = events.filter((e) => {
  if (purgeExcluded.has(e.actor)) { purgedExcluded++; return false; }
  if (removedSet.has(e.actor)) { purgedRemoved++; return false; }
  if (auditCore.has(e.actor) || coreEntryAddrs.has(e.actor)) { purgedContract++; return false; }
  return true;
});
const entAfter = new Map(watchlist.entries.map((e) => [e.address, e]));
let relabelled = 0;
for (const e of events) {
  const ce = e.counterparty ? entAfter.get(e.counterparty) : null;
  if (ce && ce.tier === 'core') {
    if (e.counterpartyLabel !== (ce.label ?? e.counterpartyLabel) || e.counterpartyIsCore !== true) relabelled++;
    if (ce.label) e.counterpartyLabel = ce.label;
    e.counterpartyIsCore = true;
  }
}
console.log(`events: ${evBefore} -> ${events.length} (purged: contracts ${purgedContract}, permanently-excluded ${purgedExcluded}, removed-entries ${purgedRemoved}); counterparty relabelled ${relabelled}`);

// ---------- 5. write + report ----------
recomputeWatchlistSummary(watchlist);
watchlist.generatedAt = new Date().toISOString();
writeFileSync(join(DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
writeFileSync(join(DIR, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

const after = {
  watchlistTotal: watchlist.entries.length,
  tiers: tierCounts(watchlist),
  events: events.length,
  bridge: computeBridgeChart(events, makeCtx(watchlist, registries)),
};
console.log(`after: entries ${after.watchlistTotal} ${JSON.stringify(after.tiers)}; events ${after.events}; bridge total ${after.bridge.total} (${after.bridge.count}件)`);
console.log('bridge top5 (new rule):');
for (const g of after.bridge.perValidator.slice(0, 5)) console.log(`  ${g.moniker}: total ${g.total} seg ${g.seg.join('/')} (${g.count}件)`);

writeFileSync(join(DIR, 'eoa-repair-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  rule: 'v0.4.2: bytecode-only test — contracts leave the person tiers; closure recomputed EOA-only; permanently excluded addresses removed (count only in this report)',
  auditDecisions: Object.values(audit.results).reduce((m, r) => { m[r.decision] = (m[r.decision] ?? 0) + 1; return m; }, {}),
  contractsMovedToCore: movedContracts,
  excludedEntriesRemoved: excludedEntries.length,
  closureRemoved: removed,
  closureUpdated: updated.length,
  eventsPurged: { contractActors: purgedContract, excludedActors: purgedExcluded, removedEntries: purgedRemoved, total: purgedContract + purgedExcluded + purgedRemoved },
  counterpartyRelabelled: relabelled,
  before,
  after,
}, null, 1));
console.log('wrote watchlist.json, events.jsonl, eoa-repair-report.json');
