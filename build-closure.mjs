#!/usr/bin/env node
// Full recursive closure of the CONFIRMED related set (v0.4.0, item 6 —
// final user spec, superseding the "from now on only" scoping):
//
// The user's definition of a related address was, from the start, "every
// address that sent to or received from a validator, and counterparties of
// counterparties, WITHOUT limit". v0.4.0 therefore expands the watchlist
// over the FULL recorded history: starting from the confirmed set
// (23 validators + 110 related + the core-labelled EOA, the #1 holder),
// walk value-transfer relations (42-flowmap/flows.jsonl tt/cs legs,
// successful txs only, plus tracker events actor<->counterparty for the
// post-snapshot range) until a fixpoint. Everything reached becomes a
// confirmed related-tier entry with depth / via / inherited validator
// names / firstSeen recorded.
//
// Exclusions are minimal (reported with counts): known system / core
// contracts and pair contracts (they live on the core side), token
// contracts, the factory, zero/burn addresses, and the verified system
// contracts (collector's KNOWN_SYSTEM_CONTRACTS — incl. the FISH reward
// contract, a mechanical distributor). The 6 ESTIMATED addresses are
// never traversed and never upgraded: an address reachable ONLY through
// an estimated wallet is not added (it can still enter via a confirmed
// path). data.json's per-validator confirmed counterparty lists are
// unioned into depth-1 attribution (research-confirmed direct relations).
//
// Idempotent: addresses already in the watchlist are skipped, so a
// second run adds nothing. Writes watchlist.json + closure-report.json.
//
// Run: node build-closure.mjs [--dry-run]
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExcludedSet, recomputeWatchlistSummary } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FM = join(__dir, '..', '42-flowmap');
const lc = (a) => (a ? String(a).toLowerCase() : a);
const dryRun = process.argv.includes('--dry-run');

const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const flowmap = JSON.parse(readFileSync(join(FM, 'data.json'), 'utf8'));
const entries = new Map(watchlist.entries.map((e) => [e.address, e]));
const estimated = new Set(watchlist.entries.filter((e) => e.tier === 'estimated').map((e) => e.address));
const excluded = buildExcludedSet(watchlist, registries);
for (const a of estimated) excluded.add(a); // never traversed, never upgraded by proxy
// v0.4.1 contract-audit guard: addresses the audit (contract-audit.json)
// classified as protocol contracts are never traversed through and never
// re-added as related (0xf2ecb173…f015, a bridge-type contract, originally
// entered as a plain related wallet and pulled its many users into the
// depth-2 closure — mechanisms are not person links).
try {
  const audit = JSON.parse(readFileSync(join(__dir, 'contract-audit.json'), 'utf8'));
  for (const [addr, r] of Object.entries(audit.results ?? {})) if (r.decision === 'core') excluded.add(addr);
} catch { /* no audit file — buildExcludedSet's isCore coverage applies */ }

// ---- interaction graph: undirected, with earliest interaction per edge ----
const adj = new Map();
const edgeFirst = new Map(); // "a|b" (a<b) -> {ts, hash}
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
let flowRecs = 0;
for await (const line of rl) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  flowRecs++;
  if (r.st !== 1) continue;
  for (const t of r.tt ?? []) addEdge(t.f, t.t, r.t, r.h);
  for (const c of r.cs ?? []) addEdge(c.f, c.t, r.t, r.h);
}
let evEdges = 0;
for (const line of readFileSync(join(__dir, 'events.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const e = JSON.parse(line);
  if (e.actor && e.counterparty) { addEdge(e.actor, e.counterparty, e.ts, e.txHash); evEdges++; }
}
console.log(`graph: ${flowRecs} flow records + ${evEdges} event edges -> ${adj.size} nodes`);

// ---- seeds: validators depth 0, existing related depth 1 ----
// Traversal seeds are PERSON-side wallets only: pair contracts, the DEX /
// bridge routers and TOWEL carry a related-tier entry for labelling, but
// they are core infrastructure — walking THROUGH a pair would merge the
// pool's two sides, which is exactly the (separate, labelled) estimated
// through-pool domain, not a confirmed relation. The one isCore person
// wallet, the #1 holder, does seed.
const HOLDER = '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25';
const depth = new Map(), names = new Map();
for (const e of watchlist.entries) {
  if (e.tier === 'validator') { depth.set(e.address, 0); names.set(e.address, new Set([e.label])); }
  else if (e.tier === 'related' && (!e.isCore || e.address === HOLDER)) { depth.set(e.address, e.depth ?? 1); names.set(e.address, new Set(e.relatedValidators ?? [])); }
}
// data.json confirmed direct counterparties: forced depth-1 candidates
// (research-confirmed even if no transfer leg is in the graph subset).
const forced = new Map(); // addr -> Set(validator names)
for (const v of flowmap.validators ?? []) {
  for (const c of v.confirmed ?? []) {
    const a = lc(c.counterparty);
    if (!forced.has(a)) forced.set(a, new Set());
    forced.get(a).add(v.moniker);
  }
}

// ---- BFS to fixpoint (level order guarantees shortest depths) ----
const queue = [...depth.keys()].sort((a, b) => depth.get(a) - depth.get(b));
const excludedSeen = new Map(); // addr -> rough category
const catOf = (a) => {
  const e = entries.get(a);
  if (estimated.has(a)) return 'estimated (never traversed)';
  if (e?.isPair || (registries.pairs ?? {})[a]) return 'pair contract';
  if ((registries.tokens ?? {})[a]) return 'token contract';
  if (e?.isCore) return 'core / system contract (watchlist)';
  return 'system contract / factory / burn address';
};
while (queue.length) {
  const cur = queue.shift();
  const d = depth.get(cur);
  for (const nb of adj.get(cur) ?? []) {
    if (depth.has(nb)) continue;
    if (excluded.has(nb)) { excludedSeen.set(nb, catOf(nb)); continue; }
    if (entries.has(nb)) continue;
    depth.set(nb, d + 1); queue.push(nb);
  }
}
// forced depth-1 (data.json confirmed) not reached by the graph walk
let forcedAdded = 0;
for (const [a] of forced) {
  if (entries.has(a) || depth.has(a)) continue;
  if (excluded.has(a)) { excludedSeen.set(a, catOf(a)); continue; }
  depth.set(a, 1); forcedAdded++;
}
// attribution pass in depth order: names = union of reached neighbours
// with smaller depth; via = earliest-interacting such neighbour.
const fresh = [...depth.keys()].filter((a) => !entries.has(a)).sort((x, y) => depth.get(x) - depth.get(y));
for (const a of fresh) {
  const d = depth.get(a);
  const ns = new Set(forced.get(a) ?? []);
  let via = null, viaFirst = null;
  for (const nb of adj.get(a) ?? []) {
    if (!depth.has(nb) || depth.get(nb) >= d) continue;
    for (const n of names.get(nb) ?? []) ns.add(n);
    const f = edgeFirst.get(key(a, nb));
    if (f && (!viaFirst || f.ts < viaFirst.ts)) { via = nb; viaFirst = f; }
  }
  if (!via) { // forced-only node: via = a validator that confirmed it
    const vName = [...(forced.get(a) ?? [])][0];
    via = watchlist.entries.find((e) => e.tier === 'validator' && e.label === vName)?.address ?? null;
    viaFirst = null;
  }
  names.set(a, ns);
  const firstOverall = viaFirst ?? [...(adj.get(a) ?? [])].map((nb) => edgeFirst.get(key(a, nb))).filter(Boolean).sort((x, y) => x.ts - y.ts)[0] ?? null;
  const entry = {
    address: a, tier: 'related', label: null, isCore: false, isPair: false, watch: true,
    validators: [], relatedValidators: [...ns].sort(),
    autoAdded: true, addedVia: 'closure-v0.4.0',
    addedAt: firstOverall?.ts ?? null, firstSeenTx: firstOverall?.hash ?? null,
    via: { address: via, validators: via ? [...(names.get(via) ?? [])].sort() : [] },
    depth: d,
  };
  fresh[fresh.indexOf(a)] = entry;
}

// ---- report + persist ----
const byDepth = {};
for (const e of fresh) byDepth[e.depth] = (byDepth[e.depth] ?? 0) + 1;
const exclByCat = {};
for (const [, c] of excludedSeen) exclByCat[c] = (exclByCat[c] ?? 0) + 1;
console.log(`closure additions: ${fresh.length} (depth ${JSON.stringify(byDepth)}; forced from data.json confirmed: ${forcedAdded})`);
console.log(`excluded neighbours encountered: ${excludedSeen.size} ${JSON.stringify(exclByCat)}`);
console.log(`watchlist before: ${watchlist.entries.length} entries`);
if (!dryRun && fresh.length) {
  watchlist.entries.push(...fresh);
  recomputeWatchlistSummary(watchlist);
  writeFileSync(join(__dir, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
  writeFileSync(join(__dir, 'closure-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), version: 'v0.4.0',
    added: fresh.length, byDepth, forcedFromDataJson: forcedAdded,
    excludedEncountered: excludedSeen.size, excludedByCategory: exclByCat,
    additions: fresh.map((e) => ({ address: e.address, depth: e.depth, validators: e.relatedValidators, via: e.via.address, firstSeenTx: e.firstSeenTx, addedAt: e.addedAt })),
  }, null, 1));
  console.log(`watchlist after: ${watchlist.entries.length} entries (related ${watchlist.summary.related}, auto-added ${watchlist.summary.autoAdded})`);
}
if (dryRun) console.log('(dry run — nothing written)');
