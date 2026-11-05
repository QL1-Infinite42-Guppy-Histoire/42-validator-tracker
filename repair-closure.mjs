#!/usr/bin/env node
// Closure repair (v0.4.1): apply the contract audit (contract-audit.json)
// and recompute the recursive related expansion WITHOUT routing through
// core / protocol contracts.
//
// Why: 0xf2ecb173…f015 sat in the related tier as a plain "depth-1
// wallet" of Metal Raptor, but it is a bridge-type CONTRACT (see
// audit-contracts.mjs). The v0.4.0 closure traversed through it and pulled
// in its many independent users as depth-2 "related wallets" — a shared
// piece of infrastructure is not a person link. The audit found 34 such
// protocol contracts in the related/estimated tiers.
//
// What this does:
//  1. Reclassifies every audit-'core' entry to the core tier (label from
//     the audit; relatedValidators cleared; watch off). Their stored
//     events are relabelled actorTier 'core' (counterparty labels too).
//  2. Recomputes reachability of every auto-added entry (closure + live)
//     from the confirmed seeds (validators + original related entries)
//     over the same flows+events graph build-closure.mjs used, with
//     transit barred through: buildExcludedSet, all core-tier entries,
//     all isCore entries (except the #1 holder, a person), and the
//     estimated tier. data.json research-confirmed direct counterparties
//     still force depth 1 (same rule as the original closure).
//  3. Kept entries get depth / via / inherited validator names recomputed
//     (build-closure's attribution rules). Unreached entries are REMOVED
//     from the watchlist and their actor events are removed from
//     events.jsonl (events where they are merely the counterparty stay —
//     they belong to the other side's record).
//  4. Writes closure-repair-report.json with before/after bridge-out
//     chart totals (chart rule) and the explicit outcome for the known
//     case 0xa33e223b…3a23.
// Run: node repair-closure.mjs [--dry-run]
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExcludedSet, recomputeWatchlistSummary } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FM = join(__dir, '..', '42-flowmap');
const lc = (a) => (a ? String(a).toLowerCase() : a);
const dryRun = process.argv.includes('--dry-run');
const HOLDER = '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25';
const USER_ADDR = '0xa33e223bcf1bb82d475ea29a11f3add9c2e73a23';

const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const audit = JSON.parse(readFileSync(join(__dir, 'contract-audit.json'), 'utf8'));
const flowmap = JSON.parse(readFileSync(join(FM, 'data.json'), 'utf8'));
let events = readFileSync(join(__dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------- chart numbers (chart rule, watchlist-derived depth) ----------
const ent0 = new Map(watchlist.entries.map((e) => [e.address, e]));
const depthOf = (map, addr) => {
  const en = map.get(lc(addr));
  if (!en) return null;
  if (en.tier === 'validator') return 0;
  if (en.depth != null) return en.depth;
  if (en.tier === 'related') return 1;
  return null;
};
const amtOf = (e) => parseFloat(String((e.amount && e.amount.amount) || '0').replace(/,/g, '')) || 0;
function chartNumbers(evs, entriesMap) {
  const outs = evs.filter((e) => e.type === 'bridge-out' && e.actorTier !== 'estimated');
  const groups = new Map(); const seg = [0, 0, 0]; let total = 0;
  for (const ev of outs) {
    const a = amtOf(ev); total += a;
    const d = depthOf(entriesMap, ev.actor);
    seg[d <= 0 ? 0 : d === 1 ? 1 : 2] += a;
    let name;
    if (ev.actorTier === 'validator' && ev.actorLabel) name = ev.actorLabel;
    else { const rel = ev.actorValidators || []; name = rel.length ? rel[0] : (ev.actorLabel || ev.actor); }
    const g = groups.get(name) || { seg: [0, 0, 0], sum: 0 };
    g.seg[d <= 0 ? 0 : d === 1 ? 1 : 2] += a; g.sum += a; groups.set(name, g);
  }
  return { total, seg, groups };
}
const before = chartNumbers(events, ent0);

// ---------- 1. apply audit core reclassifications ----------
const auditCore = new Map();
for (const [addr, r] of Object.entries(audit.results)) if (r.decision === 'core') auditCore.set(addr, r);
const coreApplied = [];
for (const e of watchlist.entries) {
  const r = auditCore.get(e.address);
  if (!r) continue;
  coreApplied.push({ address: e.address, fromTier: e.tier, label: r.label ?? 'コントラクト（仕組み系）', reason: r.reason });
  e.tier = 'core'; e.isCore = true; e.watch = false;
  e.label = r.label ?? 'コントラクト（仕組み系）';
  e.validators = []; e.relatedValidators = [];
  e.coreNote = 'プロトコル系コントラクトのため、v0.4.1 のコントラクト監査で関連から中核へ再分類';
  delete e.depth; delete e.via; delete e.autoAdded; delete e.addedVia; delete e.addedAt; delete e.firstSeenTx;
}
console.log(`audit core applied: ${coreApplied.length}`);

// ---------- graph (same construction as build-closure.mjs) ----------
const adj = new Map(); const edgeFirst = new Map();
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function addEdge(a, b, ts, hash) {
  a = lc(a); b = lc(b);
  if (!a || !b || a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b); adj.get(b).add(a);
  const k = key(a, b);
  const cur = edgeFirst.get(k);
  if (!cur || ts < cur.ts) edgeFirst.set(k, { ts, hash });
}
const rl = createInterface({ input: createReadStream(join(FM, 'flows.jsonl')), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (r.st !== 1) continue;
  for (const t of r.tt ?? []) addEdge(t.f, t.t, r.t, r.h);
  for (const c of r.cs ?? []) addEdge(c.f, c.t, r.t, r.h);
}
for (const e of events) if (e.actor && e.counterparty) addEdge(e.actor, e.counterparty, e.ts, e.txHash);

// ---------- 2. barred set + seeds ----------
const entries = new Map(watchlist.entries.map((e) => [e.address, e]));
const barred = buildExcludedSet(watchlist, registries);
for (const e of watchlist.entries) {
  if (e.tier === 'core') barred.add(e.address);
  if (e.tier === 'estimated') barred.add(e.address);
  if (e.isCore && e.address !== HOLDER) barred.add(e.address);
}
const candidates = new Map(); // auto-added entries subject to re-verification
for (const e of watchlist.entries) if (e.autoAdded && e.tier === 'related') candidates.set(e.address, e);

const depth = new Map(); const seedNames = new Map();
for (const e of watchlist.entries) {
  if (e.tier === 'validator') { depth.set(e.address, 0); seedNames.set(e.address, new Set([e.label])); }
  else if (e.tier === 'related' && !e.autoAdded && (!e.isCore || e.address === HOLDER)) { depth.set(e.address, e.depth ?? 1); seedNames.set(e.address, new Set(e.relatedValidators ?? [])); }
}
// forced depth-1 (data.json research-confirmed direct counterparties)
const forced = new Map();
for (const v of flowmap.validators ?? []) for (const c of v.confirmed ?? []) {
  const a = lc(c.counterparty);
  if (!forced.has(a)) forced.set(a, new Set());
  forced.get(a).add(v.moniker);
}
// BFS (level order; seeds start at depth 0/1). Transit/entry only through
// non-barred watchlist entries; candidates join the depth map as reached.
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
// attribution pass in depth order (build-closure's rules)
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
// removals
const removed = [];
for (const [a, e] of candidates) {
  if (depth.has(a)) continue;
  removed.push({ address: a, depth: e.depth ?? null, via: e.via?.address ?? null, validators: e.relatedValidators ?? [] });
}
const removedSet = new Set(removed.map((r) => r.address));
if (removedSet.size) watchlist.entries = watchlist.entries.filter((e) => !removedSet.has(e.address));

// ---------- 3. events: drop removed actors' events; relabel audit core ----------
const evBefore = events.length;
const removedEventsByType = {};
events = events.filter((e) => {
  if (!removedSet.has(e.actor)) return true;
  removedEventsByType[e.type] = (removedEventsByType[e.type] ?? 0) + 1;
  return false;
});
let relabelled = 0;
for (const e of events) {
  if (auditCore.has(e.actor)) {
    e.actorTier = 'core';
    e.actorLabel = entries.get(e.actor)?.label ?? 'コントラクト（仕組み系）';
    relabelled++;
  }
  if (e.counterparty && auditCore.has(e.counterparty)) e.counterpartyLabel = entries.get(e.counterparty)?.label ?? e.counterpartyLabel;
}
console.log(`closure entries: kept ${ordered.length}, updated ${updated.length}, removed ${removed.length}`);
console.log(`events: ${evBefore} -> ${events.length} (removed ${evBefore - events.length}: ${JSON.stringify(removedEventsByType)}); audit-core actor events relabelled: ${relabelled}`);

// ---------- report ----------
const ent1 = new Map(watchlist.entries.map((e) => [e.address, e]));
const after = chartNumbers(events, ent1);
const fmtG = (g) => (g ? { total: +g.sum.toFixed(2), seg: g.seg.map((v) => +v.toFixed(2)) } : null);
const userEntry = entries.get(USER_ADDR);
const userOutcome = removedSet.has(USER_ADDR)
  ? { address: USER_ADDR, outcome: 'removed', detail: 'バリデーター側への到達経路が、ブリッジ系コントラクト 0xf2ecb173…f015 を経由するものしかなかったため、関連から除外' }
  : userEntry && userEntry.tier === 'related'
    ? { address: USER_ADDR, outcome: 'kept', detail: `depth ${userEntry.depth} via ${userEntry.via?.address}`, via: userEntry.via, validators: userEntry.relatedValidators }
    : { address: USER_ADDR, outcome: userEntry ? `tier=${userEntry.tier}` : 'absent' };
console.log('user address outcome:', JSON.stringify(userOutcome));
console.log(`chart before: total ${before.total.toFixed(2)} seg ${before.seg.map((v) => v.toFixed(2)).join('/')}`);
console.log(`chart after:  total ${after.total.toFixed(2)} seg ${after.seg.map((v) => v.toFixed(2)).join('/')}`);
console.log(`Metal Raptor before/after: ${JSON.stringify(fmtG(before.groups.get('Metal Raptor')))} -> ${JSON.stringify(fmtG(after.groups.get('Metal Raptor')))}`);
console.log(`DRIVESTATS before/after: ${JSON.stringify(fmtG(before.groups.get('DRIVESTATS')))} -> ${JSON.stringify(fmtG(after.groups.get('DRIVESTATS')))}`);

recomputeWatchlistSummary(watchlist);
console.log('summary:', JSON.stringify(watchlist.summary));
if (!dryRun) {
  writeFileSync(join(__dir, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
  writeFileSync(join(__dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(__dir, 'closure-repair-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), version: 'v0.4.1',
    auditCoreApplied: coreApplied, removedEntries: removed, updatedEntries: updated,
    eventsRemoved: evBefore - events.length, removedEventsByType, auditCoreActorEventsRelabelled: relabelled,
    userAddressOutcome: userOutcome,
    chartBefore: { total: +before.total.toFixed(2), seg: before.seg.map((v) => +v.toFixed(2)), metalRaptor: fmtG(before.groups.get('Metal Raptor')), drivestats: fmtG(before.groups.get('DRIVESTATS')) },
    chartAfter: { total: +after.total.toFixed(2), seg: after.seg.map((v) => +v.toFixed(2)), metalRaptor: fmtG(after.groups.get('Metal Raptor')), drivestats: fmtG(after.groups.get('DRIVESTATS')) },
  }, null, 1));
  console.log('written: watchlist.json, events.jsonl, closure-repair-report.json');
} else console.log('(dry run — nothing written)');
