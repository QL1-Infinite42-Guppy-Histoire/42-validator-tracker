#!/usr/bin/env node
// Backfill for the v0.4.0 full-history closure (build-closure.mjs).
//
// The 148 addresses added by the closure were not watched before, so the
// live collector never recorded their past moves. This script rebuilds
// them with the collector's own classifiers — the same method as the
// earlier estimates / snipe / prelist backfills:
//  - EVM: every flow-index tx involving a closure actor is re-fetched
//    (tx + receipt) and classified; new events are flagged backfill:true.
//  - Cosmos: the six staking/bank actions' full history is re-queried via
//    tx_search (chain-wide volume is small, ~800 txs) and classified with
//    the expanded watchlist; only events not already recorded are added.
// Deduplication is by event id throughout, so re-runs are safe.
//
// Run: node backfill-closure.mjs
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCosmosTx, classifyTx, COSMOS_ACTIONS, enrichEvent, makeCtx, METHOD_EVENT_TYPES } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FLOWS = join(__dir, '..', '42-flowmap', 'flows.jsonl');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.4';
const EVM_HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const COMET_HOSTS = ['https://comet-rpc.infinitepanda.xyz', 'https://comet-rpc-infinite.mschihuahua.org', 'https://comet-rpc.infinitedrive.xyz'];
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const ADDLIQ_TOPIC = '0x59fa4e6cd353c302e62521b5edca22eaf718c54157652e59c89ed51ecb376e10';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0, rpcRequests = 0;
async function rpcBatch(calls) {
  let lastErr;
  for (let attempt = 0; attempt < EVM_HOSTS.length * 3; attempt++) {
    const host = EVM_HOSTS[attempt % EVM_HOSTS.length];
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
    try {
      rpcRequests++;
      const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++rpcId, method: c[0], params: c[1] }));
      const r = await fetch(host, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const byId = new Map(j.map((x) => [x.id, x]));
      return body.map((b) => {
        const x = byId.get(b.id);
        if (!x) return null;
        if (x.error) throw new Error('rpc error ' + JSON.stringify(x.error).slice(0, 120));
        return x.result;
      });
    } catch (e) { lastErr = e; await sleep(600 * (attempt + 1)); }
    finally { clearTimeout(t); }
  }
  throw lastErr;
}
async function cometOne(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < COMET_HOSTS.length * 2; attempt++) {
    const host = COMET_HOSTS[attempt % COMET_HOSTS.length];
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(host, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error('comet error ' + JSON.stringify(j.error).slice(0, 160));
      return j.result;
    } catch (e) { lastErr = e; await sleep(800 * (attempt + 1)); }
    finally { clearTimeout(t); }
  }
  throw lastErr;
}
async function txSearchAll(query) {
  const out = []; let page = 1, total = Infinity;
  while (out.length < total) {
    const res = await cometOne('tx_search', { query, per_page: '100', page: String(page), order_by: 'asc' });
    total = Number(res.total_count ?? 0);
    const txs = res.txs ?? [];
    out.push(...txs);
    if (!txs.length) break;
    page++;
  }
  return out;
}

// ---------- load context ----------
const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const cachePath = join(__dir, 'pairs-cache.json');
const pairsCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const creationsPath = join(__dir, 'pairs-creation.json');
const creations = existsSync(creationsPath) ? JSON.parse(readFileSync(creationsPath, 'utf8')) : {};
const ctx = makeCtx(watchlist, registries, pairsCache);
// --latest: only the addresses added by the most recent build-closure run
// (closure-report.json additions) — the fast path for iterating the
// closure <-> backfill loop to a fixpoint.
const latestOnly = process.argv.includes('--latest');
const targets = latestOnly
  ? (JSON.parse(readFileSync(join(__dir, 'closure-report.json'), 'utf8')).additions ?? []).map((a) => a.address)
  : watchlist.entries.filter((e) => e.autoAdded && e.addedVia === 'closure-v0.4.0').map((e) => e.address);
if (!targets.length) { console.error('no closure entries in watchlist.json — run build-closure.mjs first'); process.exit(1); }
const targetSet = new Set(targets);
console.log(`closure actors: ${targets.length}`);

const eventsPath = join(__dir, 'events.jsonl');
const existing = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const seen = new Set(existing.map((e) => e.id));
const OTHER_REPEAT_WINDOW_BLOCKS = 360;
const lastOtherByKey = new Map();
for (const e of existing) if (METHOD_EVENT_TYPES.has(e.type) && e.method) lastOtherByKey.set(`${e.actor}|${e.counterparty}|${e.method}`, Math.max(e.block ?? 0, lastOtherByKey.get(`${e.actor}|${e.counterparty}|${e.method}`) ?? 0));

function accept(ev, perActor, perType) {
  enrichEvent(ev, ctx, creations);
  if (METHOD_EVENT_TYPES.has(ev.type) && ev.method) {
    const key = `${ev.actor}|${ev.counterparty}|${ev.method}`;
    const last = lastOtherByKey.get(key);
    if (last != null && ev.block - last < OTHER_REPEAT_WINDOW_BLOCKS) return 'suppressed';
    lastOtherByKey.set(key, ev.block);
  }
  if (seen.has(ev.id)) return 'dup';
  seen.add(ev.id);
  ev.backfill = true;
  appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
  perActor[ev.actor] = (perActor[ev.actor] ?? 0) + 1;
  perType[ev.type] = (perType[ev.type] ?? 0) + 1;
  return 'added';
}

// ---------- EVM: collect unique tx hashes involving closure actors ----------
const txMeta = new Map();
const rl = createInterface({ input: createReadStream(FLOWS), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.src !== 'evm' || !rec.h?.startsWith('0x')) continue;
  const involves = targetSet.has(rec.f) || (rec.to && targetSet.has(rec.to)) || (rec.tt ?? []).some((x) => targetSet.has(x.f) || targetSet.has(x.t));
  if (involves && !txMeta.has(rec.h)) txMeta.set(rec.h, { b: rec.b, t: rec.t });
}
const hashes = [...txMeta.entries()].sort((a, b) => a[1].b - b[1].b);
console.log(`unique EVM txs involving closure actors: ${hashes.length}`);

async function resolvePairs(logsList) {
  const want = new Set();
  for (const logs of logsList) for (const log of logs ?? []) {
    const a = String(log.address).toLowerCase();
    if ((log.topics?.[0] === SWAP_TOPIC || log.topics?.[0] === ADDLIQ_TOPIC) && !ctx.pairs[a]) want.add(a);
  }
  if (!want.size) return 0;
  const arr = [...want];
  const calls = [];
  for (const a of arr) { calls.push(['eth_call', [{ to: a, data: '0x0dfe1681' }, 'latest']]); calls.push(['eth_call', [{ to: a, data: '0xd21220a7' }, 'latest']]); }
  const res = await rpcBatch(calls);
  let n = 0;
  arr.forEach((a, i) => {
    const t0 = res[2 * i], t1 = res[2 * i + 1];
    const ok = (x) => x && x !== '0x' && x.length >= 66;
    if (ok(t0) && ok(t1)) {
      const p = { token0: '0x' + t0.slice(26).toLowerCase(), token1: '0x' + t1.slice(26).toLowerCase() };
      ctx.pairs[a] = p;
      pairsCache[a] = p;
      n++;
    }
  });
  return n;
}

const perActor = {}, perType = {};
let added = 0, skippedNull = 0, suppressed = 0, newPairs = 0;
const BATCH = 40;
for (let i = 0; i < hashes.length; i += BATCH) {
  const chunk = hashes.slice(i, i + BATCH);
  const calls = [];
  for (const [h] of chunk) { calls.push(['eth_getTransactionByHash', [h]]); calls.push(['eth_getTransactionReceipt', [h]]); }
  const res = await rpcBatch(calls);
  newPairs += await resolvePairs(chunk.map((_, k) => res[2 * k + 1]?.logs));
  for (let k = 0; k < chunk.length; k++) {
    const [hash, meta] = chunk[k];
    const tx = res[2 * k], receipt = res[2 * k + 1];
    if (!tx || !receipt || receipt.status !== '0x1') { skippedNull++; continue; }
    let evs = [];
    try { evs = classifyTx(ctx, tx, receipt, meta.t, meta.b); } catch { evs = []; }
    for (const ev of evs) {
      const r = accept(ev, perActor, perType);
      if (r === 'added') added++;
      else if (r === 'suppressed') suppressed++;
    }
  }
  if ((i / BATCH) % 25 === 0) console.log(`  evm progress ${Math.min(i + BATCH, hashes.length)}/${hashes.length} txs, +${added} events`);
}
if (newPairs) writeFileSync(cachePath, JSON.stringify(pairsCache, null, 1));
console.log(`evm done: +${added} events | skipped ${skippedNull} | suppressed repeats ${suppressed} | new pairs ${newPairs} | rpc requests ${rpcRequests}`);

// ---------- Cosmos: full-history re-run of the six actions ----------
const blockTsCache = new Map();
async function cosmosBlockTs(height) {
  if (blockTsCache.has(height)) return blockTsCache.get(height);
  const res = await cometOne('block', { height: String(height) });
  const ts = Math.floor(new Date(res.block.header.time).getTime() / 1000);
  blockTsCache.set(height, ts);
  return ts;
}
let cosmosAdded = 0;
{
  const byHash = new Map();
  for (const action of Object.values(COSMOS_ACTIONS)) {
    const txs = await txSearchAll(`message.action='${action}'`);
    for (const it of txs) byHash.set(String(it.hash).toUpperCase(), it);
    console.log(`  cosmos ${action.split('.').pop()}: ${txs.length} txs`);
  }
  const heights = [...new Set([...byHash.values()].map((t) => Number(t.height)))];
  for (const h of heights) await cosmosBlockTs(h).catch(() => null);
  for (const it of byHash.values()) {
    const ts = blockTsCache.get(Number(it.height));
    if (ts == null) continue;
    let evs = [];
    try { evs = classifyCosmosTx(ctx, it, ts); } catch { evs = []; }
    for (const ev of evs) if (accept(ev, perActor, perType) === 'added') cosmosAdded++;
  }
}
console.log(`cosmos done: +${cosmosAdded} events`);
console.log(`TOTAL: +${added + cosmosAdded} backfilled events`);
console.log('per type:', JSON.stringify(perType, null, 1));
const topActors = Object.entries(perActor).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('top actors:', JSON.stringify(topActors));
