#!/usr/bin/env node
// Backfill for the ESTIMATED tier (Phase 3 / v0.3.0).
//
// The estimated actors (watchlist.json tier "estimated", built by
// build-estimates.mjs from the 2026-10-31 flow-map research) were not
// watched before v0.3.0, so the live collector never recorded them. This
// script rebuilds their past EVM events from the chain-wide flow index
// (~/workspace/42-flowmap/flows.jsonl, snapshot block 4,193,609) with the
// collector's own classifier — the same method as the earlier snipe /
// bridge-out / insider backfills. Rebuilt events are flagged
// `backfill: true` and appended to events.jsonl (deduplicated by id).
// Estimated events are never pinned into feed.json; feed visibility
// follows the normal latest-500 rule. (Recent activity after the index
// snapshot is picked up separately via `node collector.mjs --backfill N`.)
//
// Cosmos: the six estimated actors have ZERO Cosmos flows in the index,
// so there is nothing to rebuild on that side.
//
// Run: node backfill-estimates.mjs
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTx, enrichEvent, makeCtx, METHOD_EVENT_TYPES } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const FLOWS = join(__dir, '..', '42-flowmap', 'flows.jsonl');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.3';
const EVM_HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
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

// ---------- load context ----------
const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const cachePath = join(__dir, 'pairs-cache.json');
const pairsCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const creationsPath = join(__dir, 'pairs-creation.json');
const creations = existsSync(creationsPath) ? JSON.parse(readFileSync(creationsPath, 'utf8')) : {};
const ctx = makeCtx(watchlist, registries, pairsCache);
const estimated = watchlist.entries.filter((e) => e.tier === 'estimated').map((e) => e.address);
if (!estimated.length) { console.error('no estimated entries in watchlist.json — run build-estimates.mjs first'); process.exit(1); }
const estSet = new Set(estimated);
console.log('estimated actors:', estimated.join(', '));

const eventsPath = join(__dir, 'events.jsonl');
const existing = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const seen = new Set(existing.map((e) => e.id));
const OTHER_REPEAT_WINDOW_BLOCKS = 360;
const lastOtherByKey = new Map();
for (const e of existing) if (METHOD_EVENT_TYPES.has(e.type) && e.method) lastOtherByKey.set(`${e.actor}|${e.counterparty}|${e.method}`, Math.max(e.block ?? 0, lastOtherByKey.get(`${e.actor}|${e.counterparty}|${e.method}`) ?? 0));

// ---------- collect unique EVM tx hashes involving estimated actors ----------
const txMeta = new Map(); // hash -> {b, t}
const rl = createInterface({ input: createReadStream(FLOWS), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (rec.src !== 'evm' || !rec.h?.startsWith('0x')) continue;
  const involves = estSet.has(rec.f) || (rec.to && estSet.has(rec.to)) || (rec.tt ?? []).some((x) => estSet.has(x.f) || estSet.has(x.t));
  if (involves && !txMeta.has(rec.h)) txMeta.set(rec.h, { b: rec.b, t: rec.t });
}
const hashes = [...txMeta.entries()].sort((a, b) => a[1].b - b[1].b);
console.log(`unique EVM txs involving estimated actors: ${hashes.length}`);

// ---------- resolve unknown pairs appearing in swap/LP logs ----------
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

// ---------- rebuild ----------
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
      enrichEvent(ev, ctx, creations);
      if (METHOD_EVENT_TYPES.has(ev.type) && ev.method) {
        const key = `${ev.actor}|${ev.counterparty}|${ev.method}`;
        const last = lastOtherByKey.get(key);
        if (last != null && ev.block - last < OTHER_REPEAT_WINDOW_BLOCKS) { suppressed++; continue; }
        lastOtherByKey.set(key, ev.block);
      }
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      ev.backfill = true;
      appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
      added++;
      perActor[ev.actor] = (perActor[ev.actor] ?? 0) + 1;
      perType[ev.type] = (perType[ev.type] ?? 0) + 1;
    }
  }
  if ((i / BATCH) % 20 === 0) console.log(`  progress ${Math.min(i + BATCH, hashes.length)}/${hashes.length} txs, +${added} events`);
}
if (newPairs) writeFileSync(cachePath, JSON.stringify(pairsCache, null, 1));
console.log(`done: +${added} backfilled events | skipped (missing/failed tx) ${skippedNull} | suppressed repeats ${suppressed} | new pairs resolved ${newPairs} | rpc requests ${rpcRequests}`);
console.log('per actor:', JSON.stringify(perActor, null, 1));
console.log('per type:', JSON.stringify(perType, null, 1));
