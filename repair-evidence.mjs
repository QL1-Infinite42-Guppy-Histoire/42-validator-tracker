#!/usr/bin/env node
// repair-evidence.mjs — v0.4.2 final scope (user-approved 2026-11-05):
// depth>=2 related addresses stay ONLY with evidence that they are the
// validator's own wallet; all other depth>=2 "general public" addresses
// are removed entirely (watchlist entry + their actor events), the
// same treatment as contracts in repair-eoa-only.mjs.
//
// Evidence (thresholds live in collector.mjs evidenceCodesFor, shared
// with the live auto-add gate) is evaluated per (candidate, validator)
// pair against that validator's SELF SIDE = the validator itself + its
// depth-1 (original) related wallets, using:
//   - directed fund movements from the flow index (42-flowmap
//     flows.jsonl: tt/cs legs + pure native transfers),
//   - delegations from the recorded events (delegate events carry
//     validatorNames + [42] amounts),
//   - swap-buy timestamps from the recorded events (synchrony).
// Adopted candidates keep ONLY the validator names they have evidence
// for, and the codes are stored on the entry (`evidence`). Depths/vias
// are refreshed by BFS over the kept person graph (transfers only);
// unreached adoptees keep their stored depth with a re-pointed via.
// Permanently excluded addresses (env EXCLUDED_ACTORS) are already
// gone (repair-eoa-only) and stay barred here too.
//
// Report: evidence-repair-report.json (adopted entries with their
// evidence codes, deleted addresses, code histogram, before/after).

import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildExcludedSet, recomputeWatchlistSummary, excludedActorsFromEnv,
  makeCtx, computeBridgeChart, evidenceCodesFor,
} from './collector.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const lc = (a) => (a ? String(a).toLowerCase() : a);

const watchlist = JSON.parse(readFileSync(join(DIR, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(DIR, 'registries.json'), 'utf8'));
const envExcl = excludedActorsFromEnv();
let events = readFileSync(join(DIR, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const tierCounts = (wl) => { const t = {}; for (const e of wl.entries) t[e.tier] = (t[e.tier] ?? 0) + 1; return t; };
const before = {
  watchlistTotal: watchlist.entries.length, tiers: tierCounts(watchlist), events: events.length,
  bridge: computeBridgeChart(events, makeCtx(watchlist, registries)),
};
console.log(`before: entries ${before.watchlistTotal} ${JSON.stringify(before.tiers)}; events ${before.events}; bridge ${before.bridge.total}`);

// ---------- sets ----------
const entries = new Map(watchlist.entries.map((e) => [e.address, e]));
const validators = watchlist.entries.filter((e) => e.tier === 'validator');
const originals = watchlist.entries.filter((e) => e.tier === 'related' && !e.autoAdded);
const candidates = watchlist.entries.filter((e) => e.tier === 'related' && (e.depth ?? 1) >= 2);
console.log(`candidates (depth>=2 related): ${candidates.length}`);
const candSet = new Set(candidates.map((e) => e.address));
const sideOf = new Map(); // validator name -> Set of self-side addresses
for (const v of validators) {
  const s = new Set([v.address]);
  for (const o of originals) if ((o.relatedValidators ?? []).includes(v.label)) s.add(o.address);
  sideOf.set(v.label, s);
}
const allSide = new Set();
for (const s of sideOf.values()) for (const a of s) allSide.add(a);

// ---------- flow statistics for candidates ----------
// stats: cand -> Map(counterparty -> { inN, outN, inAmt42: BigInt })
const stats = new Map();
const bump = (cand, cp, dir, amt42) => {
  if (!stats.has(cand)) stats.set(cand, new Map());
  const m = stats.get(cand);
  if (!m.has(cp)) m.set(cp, { inN: 0, outN: 0, inAmt42: 0n });
  const r = m.get(cp);
  if (dir === 'in') { r.inN++; r.inAmt42 += amt42; } else r.outN++;
};
// transfer graph (for the depth refresh BFS)
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
    const legs = [];
    for (const t of f.tt ?? []) legs.push({ f: lc(t.f), t: lc(t.t), amt42: 0n });
    for (const c of f.cs ?? []) legs.push({ f: lc(c.f), t: lc(c.t), amt42: BigInt(c.a ?? '0') });
    if ((!f.tt?.length && !f.cs?.length) && f.v && f.v !== '0') legs.push({ f: lc(f.from), t: lc(f.to), amt42: BigInt(f.v) });
    for (const leg of legs) {
      addEdge(leg.f, leg.t, f.ts ?? 0);
      if (candSet.has(leg.t)) bump(leg.t, leg.f, 'in', leg.amt42);
      if (candSet.has(leg.f)) bump(leg.f, leg.t, 'out', 0n);
    }
  }
}
for (const e of events) if (e.type === 'transfer' && e.counterparty) addEdge(e.actor, e.counterparty, e.ts ?? 0);

// delegations + buys from events
const deleg = new Map(); // actor -> Map(name -> {count, amt})
const buys = new Map(); // actor -> [ts]
for (const ev of events) {
  if (ev.type === 'delegate') {
    if (!deleg.has(ev.actor)) deleg.set(ev.actor, new Map());
    const m = deleg.get(ev.actor);
    for (const n of ev.validatorNames ?? []) {
      if (!m.has(n)) m.set(n, { count: 0, amt: 0n });
      const r = m.get(n); r.count++;
      try { r.amt += BigInt(ev.amount?.amountRaw ?? '0'); } catch {}
    }
  } else if (ev.type === 'swap-buy') {
    if (!buys.has(ev.actor)) buys.set(ev.actor, []);
    buys.get(ev.actor).push(ev.ts);
  }
}
const sideBuys = new Map(); // validator name -> [ts]
for (const [name, s] of sideOf) {
  const arr = [];
  for (const a of s) for (const t of buys.get(a) ?? []) arr.push(t);
  arr.sort((x, y) => x - y);
  sideBuys.set(name, arr);
}
const hasSync = (cand, name) => {
  const cb = buys.get(cand) ?? []; const sb = sideBuys.get(name) ?? [];
  for (const t of cb) for (const s of sb) if (Math.abs(t - s) <= 600) return true;
  return false;
};

// ---------- evaluate ----------
const adopted = []; const deleted = [];
const codeAddrCount = {}; // code -> #addresses adopted with it (any validator)
for (const c of candidates) {
  const m = stats.get(c.address) ?? new Map();
  let totalVS = 0;
  for (const [cp, r] of m) if (allSide.has(cp)) totalVS += r.inN + r.outN;
  const keepNames = {};
  for (const name of c.relatedValidators ?? []) {
    const S = sideOf.get(name) ?? new Set();
    let inN = 0, outN = 0, inAmt42 = 0n;
    for (const [cp, r] of m) if (S.has(cp)) { inN += r.inN; outN += r.outN; inAmt42 += r.inAmt42; }
    const d = deleg.get(c.address)?.get(name) ?? { count: 0, amt: 0n };
    const r = evidenceCodesFor({ inN, outN, totalVS, received42: inAmt42, delegated42: d.amt, delegateCount: d.count, sync: hasSync(c.address, name) });
    if (r.adopted) keepNames[name] = [...r.strong, ...r.weak];
  }
  if (Object.keys(keepNames).length) {
    adopted.push({ entry: c, keepNames });
    for (const codes of Object.values(keepNames)) for (const code of codes) codeAddrCount[code] = (codeAddrCount[code] ?? 0) + 1;
  } else deleted.push(c);
}
console.log(`evidence: adopted ${adopted.length}, deleted ${deleted.length}`);
console.log('adopted-address count per evidence code:', JSON.stringify(codeAddrCount));

// ---------- apply: prune attribution + record evidence ----------
const deletedSet = new Set(deleted.map((e) => e.address));
for (const { entry, keepNames } of adopted) {
  entry.relatedValidators = Object.keys(keepNames).sort();
  entry.evidence = keepNames;
}

// ---------- depth/via refresh over the KEPT person graph ----------
const kept = new Set(watchlist.entries.filter((e) => !deletedSet.has(e.address) && (e.tier === 'validator' || e.tier === 'related')).map((e) => e.address));
const barred = buildExcludedSet(watchlist, registries);
for (const a of envExcl) barred.add(a);
const depth = new Map(); const seedNames = new Map();
for (const e of watchlist.entries) {
  if (deletedSet.has(e.address)) continue;
  if (e.tier === 'validator') { depth.set(e.address, 0); seedNames.set(e.address, new Set([e.label])); }
  else if (e.tier === 'related' && !e.autoAdded) { depth.set(e.address, e.depth ?? 1); seedNames.set(e.address, new Set(e.relatedValidators ?? [])); }
}
const passable = (a) => kept.has(a) && !barred.has(a) && entries.has(a);
const queue = [...depth.keys()];
while (queue.length) {
  let mi = 0;
  for (let i = 1; i < queue.length; i++) if (depth.get(queue[i]) < depth.get(queue[mi])) mi = i;
  const cur = queue.splice(mi, 1)[0];
  const d = depth.get(cur);
  for (const nb of adj.get(cur) ?? []) {
    if (depth.has(nb) || !passable(nb)) continue;
    depth.set(nb, d + 1);
    queue.push(nb);
  }
}
const namesOf = (addr) => {
  const e = entries.get(addr);
  if (!e) return new Set();
  if (e.tier === 'validator') return new Set([e.label]);
  return new Set(e.relatedValidators ?? []);
};
for (const { entry } of adopted) {
  const a = entry.address;
  const adoptedNames = new Set(entry.relatedValidators);
  if (depth.has(a)) {
    const d = depth.get(a);
    let via = null, viaFirst = null;
    for (const nb of adj.get(a) ?? []) {
      if (!depth.has(nb) || depth.get(nb) >= d) continue;
      const f = edgeFirst.get(key(a, nb));
      const shares = [...namesOf(nb)].some((n) => adoptedNames.has(n));
      if (f && (via === null || (shares && ![...namesOf(via)].some((n) => adoptedNames.has(n))) || (shares === [...namesOf(via ?? '')].some((n) => adoptedNames.has(n)) && f.ts < (viaFirst?.ts ?? Infinity)))) { via = nb; viaFirst = f; }
    }
    entry.depth = d;
    if (via) entry.via = { address: via, validators: [...namesOf(via)].sort() };
  } else if (entry.via && deletedSet.has(entry.via.address)) {
    // re-point via to the strongest self-side counterparty of an adopted name
    let best = null, bestN = 0;
    const m = stats.get(a) ?? new Map();
    for (const [cp, r] of m) {
      const n = r.inN + r.outN;
      if (n > bestN && [...adoptedNames].some((name) => sideOf.get(name)?.has(cp))) { best = cp; bestN = n; }
    }
    if (best) {
      const be = entries.get(best);
      entry.depth = (depth.get(best) ?? be?.depth ?? 1) + 1;
      entry.via = { address: best, validators: [...namesOf(best)].sort() };
    }
  }
}

// ---------- delete the rest + purge their events ----------
watchlist.entries = watchlist.entries.filter((e) => !deletedSet.has(e.address));
const evBefore = events.length;
events = events.filter((e) => !deletedSet.has(e.actor));
const purged = evBefore - events.length;
console.log(`deleted entries: ${deletedSet.size}; actor events purged: ${purged} (${evBefore} -> ${events.length})`);

// ---------- write + report ----------
recomputeWatchlistSummary(watchlist);
watchlist.generatedAt = new Date().toISOString();
writeFileSync(join(DIR, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
writeFileSync(join(DIR, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
const after = {
  watchlistTotal: watchlist.entries.length, tiers: tierCounts(watchlist), events: events.length,
  bridge: computeBridgeChart(events, makeCtx(watchlist, registries)),
};
console.log(`after: entries ${after.watchlistTotal} ${JSON.stringify(after.tiers)}; events ${after.events}; bridge ${after.bridge.total}`);
console.log('bridge top5 (final scope):');
for (const g of after.bridge.perValidator.slice(0, 5)) console.log(`  ${g.moniker}: ${g.total} seg ${g.seg.join('/')} (${g.count}件)`);
writeFileSync(join(DIR, 'evidence-repair-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  rule: 'v0.4.2 final scope: depth>=2 related kept only with own-wallet evidence (strong x1 or weak x2); others deleted as general addresses',
  adopted: adopted.map(({ entry, keepNames }) => ({ address: entry.address, depth: entry.depth ?? null, via: entry.via?.address ?? null, evidence: keepNames })),
  adoptedCount: adopted.length,
  codeAddressCounts: codeAddrCount,
  deleted: deleted.map((e) => ({ address: e.address, depth: e.depth ?? null, via: e.via?.address ?? null, validators: e.relatedValidators ?? [] })),
  deletedCount: deleted.length,
  eventsPurged: purged,
  before, after,
}, null, 1));
console.log('wrote watchlist.json, events.jsonl, evidence-repair-report.json');
