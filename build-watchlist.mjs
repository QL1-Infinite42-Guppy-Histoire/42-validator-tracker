#!/usr/bin/env node
// 42 Validator Tracker — Phase 1 watchlist builder.
//
// Builds watchlist.json (+ registries.json with token/pair registries) from the
// existing, already-verified research data. No network access, no guessing:
//
//   Validators (tier "validator", 23 bonded):
//     - ~/workspace/42-cosmos-scan/validators-snapshot.json
//       (itself sourced from the staking precompile 0x0800 bonded set snapshot
//        in ~/workspace/42-flowmap/validators.json, 2026-10-31)
//     - cross-checked against ~/workspace/42-flowmap/validator-balances.json
//       (operator address per moniker must match; a mismatch aborts the build)
//
//   Direct related (tier "related"):
//     - ~/workspace/42-flowmap/data.json -> validators[].confirmed[]
//       These are CONFIRMED direct counterparties only: addresses that directly
//       sent value to / received value from a validator (EVM + Cosmos sources,
//       aggregated in the flowmap research). Estimated / through-pool links
//       (data.json "estimates", validators[].estimated) are deliberately NOT
//       read here — Phase 1 has no estimates, per the standing user rule that
//       estimates are never mixed with confirmed data (estimates are Phase 3).
//
//   Core / system (tier "core", label-only, watch=false):
//     - ~/workspace/42-flowmap/data.json -> nodes[] with core:true and a name
//       (DEX router/factory/pairs, Starlight, Guide/Fluke, st42 vault, bridge
//        routers, staking precompile 0x0800, fee collector, QNS, TOWEL, ...)
//     - plus every pair in ~/workspace/42-flowmap/pairs.json (label "X/Y ペア")
//     Core entries exist so the UI can label infrastructure as infrastructure
//     instead of presenting it as a person wallet. They are NOT event actors
//     (watch=false), except where an address is ALSO a direct related address
//     (the #1 holder 0x7a6f...0a25 is a direct related address flagged core) —
//     those keep watch=true and carry isCore=true for UI labelling.
//     Validators are NEVER core: the flowmap source flags validator Xenia's
//     node as core (she sent exactly 2 [42] to many validators), but the user
//     corrected this on 2026-11-05 — Xenia is a validator/person, her seed
//     distribution is her own activity, not infrastructure. An explicit
//     override below strips any core flag from validator-tier entries.
//
//   Token registry: ~/workspace/42-flowmap/token-whitelist.json (the ONLY 17
//   tokens displayed; copycat CAT42 x1 / ZAP x2 are not in the list and stay
//   excluded) merged with decimals/symbols from
//   ~/workspace/42-flowmap/tokens.json for non-whitelist tokens, which are
//   kept in storage but flagged whitelisted=false (display rule only).
//
// Usage: node build-watchlist.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FLOWMAP = join(__dir, '..', '42-flowmap');
const COSMOS_SCAN = join(__dir, '..', '42-cosmos-scan');

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const lc = (a) => (a ? String(a).toLowerCase() : a);

// ---------- validators ----------
const snapshot = readJSON(join(COSMOS_SCAN, 'validators-snapshot.json'));
const balances = readJSON(join(FLOWMAP, 'validator-balances.json')).balances;
const data = readJSON(join(FLOWMAP, 'data.json'));
const nodeByAddr = new Map(data.nodes.map((n) => [lc(n.address), n]));

const entries = new Map(); // address -> entry
const getEntry = (address) => {
  address = lc(address);
  if (!entries.has(address)) {
    entries.set(address, {
      address, tier: null, label: null, isCore: false, isPair: false,
      watch: false, validators: [], relatedValidators: [],
    });
  }
  return entries.get(address);
};

for (const v of snapshot.validators) {
  const addr = lc(v.operator);
  const bal = balances[v.moniker];
  if (!bal || lc(bal.operator) !== addr) {
    throw new Error(`validator cross-check FAILED for ${v.moniker}: snapshot=${addr} balances=${bal?.operator}`);
  }
  const e = getEntry(addr);
  e.tier = 'validator';
  e.watch = true;
  e.label = v.moniker;
  e.validators = [v.moniker];
  const node = nodeByAddr.get(addr);
  if (node?.core) { e.isCore = true; e.coreNote = '配布型の中核としても扱う（バリデーター本人）'; }
}

// ---------- direct related (confirmed counterparties only) ----------
let confirmedEntries = 0;
for (const v of data.validators) {
  for (const c of v.confirmed ?? []) {
    confirmedEntries++;
    const addr = lc(c.counterparty);
    const e = getEntry(addr);
    if (!e.relatedValidators.includes(v.moniker)) e.relatedValidators.push(v.moniker);
    if (e.tier === 'validator') continue; // validator-to-validator link: keep tier, note the relation
    e.tier = 'related';
    e.watch = true;
    if (c.core) e.isCore = true;
    const node = nodeByAddr.get(addr);
    if (node?.core) { e.isCore = true; if (node.name) e.label = node.name; if (node.isPair) e.isPair = true; }
  }
}

// ---------- core / system label-only entries ----------
const pairsRaw = readJSON(join(FLOWMAP, 'pairs.json')).pairs;
for (const n of data.nodes) {
  if (!n.core) continue;
  const e = getEntry(n.address);
  if (e.tier === 'validator' || e.tier === 'related') {
    // already watched; just make sure the core flag/label is present
    e.isCore = true;
    if (!e.label || e.tier === 'related') e.label = n.name ?? e.label;
    if (n.isPair) e.isPair = true;
    continue;
  }
  e.tier = 'core';
  e.isCore = true;
  e.watch = false;
  e.label = n.name ?? '仕組み系アドレス';
  if (n.isPair) e.isPair = true;
}
// every known pair gets a label, even if it was not in the core node list
const tokensRaw = readJSON(join(FLOWMAP, 'tokens.json'));
const symOf = (a) => (a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? '42' : (tokensRaw[lc(a)]?.symbol ?? '…'));
for (const [addr, p] of Object.entries(pairsRaw)) {
  const e = getEntry(addr);
  e.isPair = true;
  e.isCore = true;
  if (e.tier !== 'validator' && e.tier !== 'related') { e.tier = 'core'; e.watch = false; }
  if (!e.label || /ペア$/.test(e.label) === false) e.label = `${symOf(p.token0)}/${symOf(p.token1)} ペア`;
}
// explicit system contracts (must be labelled even if absent above)
const EXPLICIT_CORE = [
  ['0xbf07dfe35746894bae373f63f4bf2379f9bafec0', 'DEXルーター'],
  ['0x3157c6aca800d507af95ab1466adba3a6f11ee1a', 'DEX工場（ファクトリー）'],
  ['0xebc32e52a1aa52d8a0cd71402c4ffdf316f0db07', 'Starlight'],
  ['0xf349e469c474048ded6f9b914309e76880ed1bbd', 'Guide/Fluke'],
  ['0x78f40e828a92af9e137ff7660e52ac8b0f1d121e', 'st42バルト'],
  ['0x0000000000000000000000000000000000000800', 'ステーキング（0x0800）'],
];
for (const [addr, name] of EXPLICIT_CORE) {
  const e = getEntry(addr);
  e.isCore = true;
  if (e.tier !== 'validator' && e.tier !== 'related') { e.tier = 'core'; e.watch = false; }
  if (!e.label || e.label === '仕組み系アドレス') e.label = name;
}
// #1 holder: distributor-type core flag (it is already a direct related entry)
const holder = getEntry('0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25');
holder.isCore = true;
if (!holder.label) holder.label = '残高1位アドレス';
holder.coreNote = '配布型・中核として表示（人物ウォレット扱いしない）';

// ---------- user correction (2026-11-05): Xenia is NOT core ----------
// The flowmap source data flags Xenia's node core:true (2026-10-31 bubble-map
// category-B "distributor-type" ruling). The user overturned that ruling:
// Xenia is an ordinary validator/person and must never be classified as
// core/system （中核・仕組み系） anywhere. Strip the core flag + note from
// every validator-tier entry so a rebuild cannot reintroduce it. (The #1
// holder 0x7a6f...0a25 is related-tier and keeps its core flag — the user
// corrected Xenia only.)
for (const e of entries.values()) {
  if (e.tier === 'validator' && e.isCore) {
    e.isCore = false;
    delete e.coreNote;
  }
}

// ---------- registries ----------
const whitelist = readJSON(join(FLOWMAP, 'token-whitelist.json'));
const tokens = {}; // address -> {symbol, decimals, whitelisted}
tokens['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'] = { symbol: '42', decimals: 18, whitelisted: true };
for (const t of whitelist.tokens) {
  if (t.address === 'native') continue;
  const a = lc(t.address);
  tokens[a] = { symbol: t.symbol, decimals: tokensRaw[a]?.decimals ?? 18, whitelisted: true };
}
// copycats named in the whitelist notes must NEVER become whitelisted:
const COPYCATS = ['0x96492e454b15100680310a1989220069188ea692'];
for (const [a, t] of Object.entries(tokensRaw)) {
  const addr = lc(a);
  if (!tokens[addr]) tokens[addr] = { symbol: t.symbol, decimals: t.decimals ?? 18, whitelisted: false };
}
for (const a of COPYCATS) if (tokens[a]) tokens[a].whitelisted = false;

const pairs = {};
for (const [addr, p] of Object.entries(pairsRaw)) {
  pairs[lc(addr)] = { token0: lc(p.token0), token1: lc(p.token1), factory: lc(p.factory) };
}

// ---------- write outputs ----------
const list = [...entries.values()].sort((a, b) =>
  (a.tier === 'validator' ? 0 : a.tier === 'related' ? 1 : 2) - (b.tier === 'validator' ? 0 : b.tier === 'related' ? 1 : 2)
  || a.address.localeCompare(b.address));

const summary = {
  validators: list.filter((e) => e.tier === 'validator').length,
  directRelated: list.filter((e) => e.tier === 'related').length,
  coreLabelOnly: list.filter((e) => e.tier === 'core').length,
  coreFlaggedTotal: list.filter((e) => e.isCore).length,
  watchedActors: list.filter((e) => e.watch).length,
  totalEntries: list.length,
  confirmedCounterpartyLinks: confirmedEntries,
  uniqueConfirmedCounterparties: new Set(data.validators.flatMap((v) => (v.confirmed ?? []).map((c) => lc(c.counterparty)))).size,
};

const watchlist = {
  generatedAt: new Date().toISOString(),
  sources: {
    validators: '42-cosmos-scan/validators-snapshot.json (staking precompile 0x0800 bonded set, 2026-10-31), cross-checked with 42-flowmap/validator-balances.json',
    directRelated: '42-flowmap/data.json validators[].confirmed[] — CONFIRMED direct counterparties only; estimates intentionally excluded (Phase 3)',
    core: '42-flowmap/data.json nodes[core=true] + 42-flowmap/pairs.json + explicit system contracts',
    snapshotBlockOfSourceData: data.snapshotBlock,
  },
  summary,
  entries: list,
};
writeFileSync(join(__dir, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
writeFileSync(join(__dir, 'registries.json'), JSON.stringify({ generatedAt: watchlist.generatedAt, tokens, pairs }, null, 1));

console.log('watchlist.json written:', JSON.stringify(summary, null, 1));
console.log('registries.json written: tokens', Object.keys(tokens).length, '(whitelisted', Object.values(tokens).filter((t) => t.whitelisted).length, '), pairs', Object.keys(pairs).length);
