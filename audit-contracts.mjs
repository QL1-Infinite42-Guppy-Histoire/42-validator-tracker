#!/usr/bin/env node
// audit-contracts.mjs — v0.4.2: EOA-only person graph, no exceptions.
//
// USER RULE (2026-11-05): 「仕組み系は全部排除」 — every infrastructure /
// contract address leaves the person tiers (related / estimated).
// Membership and graph traversal become EOA-only. The ONLY test is
// bytecode: an address with contract code is infrastructure, no matter
// how person-like it behaved — the v0.4.1 "stay-related" exceptions
// (LP-holder contracts etc.) are gone. Being SHARED between validators
// is never a reason to exclude: a shared EOA stays a person's wallet.
//
// What this script does:
//   - eth_getCode census over EVERY watchlist entry outside the
//     validator tier (related + estimated + core, for completeness).
//   - Decision per entry: 'eoa' (no code) or 'core' (has code — moves
//     to / stays in the core registry, label only, for counterparty
//     display). Repairs are applied by repair-eoa-only.mjs.
//   - Labels: entry.label -> curated OVERRIDES -> collector
//     KNOWN_CONTRACTS -> DEST_LABELS -> registries token/pair names ->
//     the previous audit's label -> null (repair assigns
//     「コントラクト（未分類）」).
//
// Output: contract-audit.json { generatedAt, rule, results: { addr:
// { codeBytes, decision, label, tier, depth, wasCore, relatedValidators } } }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KNOWN_CONTRACTS, DEST_LABELS, excludedActorsFromEnv } from './collector.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const RPCS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'content-type': 'application/json' };
let rpcIdx = 0;
async function rpcBatch(calls) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[rpcIdx % RPCS.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: UA, body: JSON.stringify(calls) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('non-array response');
      return j;
    } catch (e) { lastErr = e; rpcIdx++; }
  }
  throw lastErr;
}

// Curated identity overrides (display labels only).
const OVERRIDES = new Map([
  ['0xf2ecb173b63699c49ace3faae80af5ce677af015', 'ブリッジ系コントラクト'],
]);

const watchlist = JSON.parse(readFileSync(join(DIR, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(DIR, 'registries.json'), 'utf8'));
const prevAudit = existsSync(join(DIR, 'contract-audit.json'))
  ? JSON.parse(readFileSync(join(DIR, 'contract-audit.json'), 'utf8')) : { results: {} };

function resolveLabel(addr, entry) {
  if (entry.label) return entry.label;
  if (OVERRIDES.has(addr)) return OVERRIDES.get(addr);
  if (KNOWN_CONTRACTS[addr]) return KNOWN_CONTRACTS[addr];
  if (DEST_LABELS[addr]) return DEST_LABELS[addr];
  const tok = registries.tokens?.[addr];
  if (tok?.symbol) return `トークン ${tok.symbol}`;
  const pair = registries.pairs?.[addr];
  if (pair) return `流動性プール ${pair.token0Symbol ?? ''}/${pair.token1Symbol ?? ''}`.trim();
  const prev = prevAudit.results?.[addr];
  if (prev?.label) return prev.label;
  return null;
}

async function main() {
  const targets = watchlist.entries.filter((e) => e.tier !== 'validator');
  console.log(`audit targets (all non-validator entries): ${targets.length}`);
  const results = {};
  const CH = 40;
  for (let i = 0; i < targets.length; i += CH) {
    const chunk = targets.slice(i, i + CH);
    const res = await rpcBatch(chunk.map((e, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_getCode', params: [e.address, 'latest'] })));
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j];
      const r = res.find((x) => x.id === j);
      const code = r?.result ?? '0x';
      const isContract = typeof code === 'string' && code !== '0x' && code.length > 2;
      results[e.address] = {
        codeBytes: isContract ? (code.length - 2) / 2 : 0,
        decision: isContract ? 'core' : 'eoa',
        label: isContract ? resolveLabel(e.address, e) : (e.label ?? null),
        tier: e.tier, depth: e.depth ?? null, wasCore: !!e.isCore,
        relatedValidators: e.relatedValidators ?? [],
      };
    }
    process.stdout.write(`\r  ${Math.min(i + CH, targets.length)}/${targets.length}`);
  }
  console.log('');
  const counts = {};
  for (const r of Object.values(results)) counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  console.log('decisions:', JSON.stringify(counts));
  const contracts = Object.entries(results).filter(([, r]) => r.decision === 'core');
  console.log(`contracts found: ${contracts.length}`);
  for (const [a, r] of contracts) console.log(`  ${a} bytes=${r.codeBytes} tier=${r.tier} depth=${r.depth} label=${r.label ?? '(未分類)'}`);
  // Explicit spot reports: the two big via-parents (expected EOA) and
  // the bridge-style contract (must stay core).
  for (const probe of ['0x2fcfc23071e355aa75a6373d779bf5e220b8ecaf', '0xbf2bb17f408521607cf7e79798d0d0ab6be5603a', '0xf2ecb173b63699c49ace3faae80af5ce677af015']) {
    const r = results[probe];
    console.log(`PROBE ${probe}: ${r ? `decision=${r.decision} codeBytes=${r.codeBytes} label=${r.label ?? '(none)'}` : 'NOT IN WATCHLIST'}`);
  }
  // Permanently excluded addresses (env EXCLUDED_ACTORS) are audited in
  // memory like everyone else, but never written into the repo file.
  for (const a of excludedActorsFromEnv()) delete results[a];
  writeFileSync(join(DIR, 'contract-audit.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: 'v0.4.2: bytecode decides — any contract leaves the person tiers (no exceptions); shared EOAs stay',
    results,
  }, null, 1));
  console.log('wrote contract-audit.json');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) { main().catch((e) => { console.error(e); process.exit(1); }); }
