#!/usr/bin/env node
// 42 Validator Tracker — Phase 1 collector (EVM side only).
//
// Polls the 42 Chain EVM RPC for new blocks, decodes receipts with NO external
// dependencies (topic hashes are the standard ERC-20 / Uniswap V2 ones,
// verified against ethers.id() during development), classifies events that
// involve watched addresses (validators + their CONFIRMED direct related
// addresses from watchlist.json), appends them to events.jsonl and regenerates
// feed.json (latest 500 events) for the static frontend.
//
// Standing rules honoured here:
//  - NO minimum-amount filtering anywhere: a watched transfer of any size,
//    however small, is recorded.
//  - Swaps are recorded as the actor's asset transformation (sold -> bought
//    with a derived price), never as person-to-person edges.
//  - Estimated / through-pool links are NOT produced (Phase 3). Everything in
//    events.jsonl comes from direct on-chain logs of the tx itself.
//  - Non-whitelist tokens are kept in storage but flagged whitelisted=false
//    (the whitelist is a display rule, see build-watchlist.mjs).
//
// RPC quirk (measured 2026-11-05): requests MUST carry a browser-like
// User-Agent header or some hosts close the connection without responding.
//
// Usage:
//   node collector.mjs                 # loop: poll every ~10s forever
//   node collector.mjs --once          # one pass from checkpoint to tip, exit
//   node collector.mjs --backfill 300  # process the last 300 blocks, exit
//   node collector.mjs --range A:B     # process blocks A..B inclusive, exit
// Env: POLL_MS (default 10000)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const RPC_HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.1';
const W42 = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // wrapped/native [42] marker used across the flowmap data
const ZERO = '0x0000000000000000000000000000000000000000';
const ROUTER = '0xbf07dfe35746894bae373f63f4bf2379f9bafec0';

export const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  mint: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  burn: '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
  deposit: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  withdrawal: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
};

// Site-internal alert rules (Phase 1). These are explicit and are also stated
// on the website itself — no black box:
//   A) a validator SELF swap (buy or sell) is always notable.
//   B) any watched event moving at least NOTABLE_42_THRESHOLD [42] is notable.
export const NOTABLE_42_THRESHOLD = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => (a ? String(a).toLowerCase() : a);
const topicAddr = (t) => '0x' + t.slice(26).toLowerCase();
const u256 = (hex) => BigInt(!hex || hex === '0x' ? '0x0' : hex);

// Exact decimal string for a raw integer amount (no float rounding surprises).
export function decimalStr(rawStr, decimals = 18) {
  let s = BigInt(rawStr).toString();
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  s = s.padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals) || '0';
  let frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + intPart + (frac ? '.' + frac : '');
}
export const fmtNum = (rawStr, decimals = 18) => {
  const str = decimalStr(rawStr, decimals);
  const [i, f] = str.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${grouped}.${f.slice(0, 6)}` : grouped;
};

// ---------------- log decoding (adapted from 42-flowmap/index-flows.mjs) ----------------
export function decodeReceiptLogs(receipt) {
  const out = { transfers: [], swaps: [], mints: [], burns: [] };
  for (const log of receipt?.logs ?? []) {
    const t0 = log.topics?.[0];
    const emitter = lc(log.address);
    const li = typeof log.logIndex === 'string' ? parseInt(log.logIndex, 16) : (log.logIndex ?? 0);
    if (t0 === TOPIC.transfer && log.topics.length === 3) {
      out.transfers.push({ token: emitter, from: topicAddr(log.topics[1]), to: topicAddr(log.topics[2]), amountRaw: u256(log.data).toString(), logIndex: li });
    } else if (t0 === TOPIC.swap) {
      const d = log.data.slice(2);
      out.swaps.push({
        pair: emitter, sender: topicAddr(log.topics[1]), recipient: topicAddr(log.topics[2]),
        a0i: u256('0x' + d.slice(0, 64)).toString(), a1i: u256('0x' + d.slice(64, 128)).toString(),
        a0o: u256('0x' + d.slice(128, 192)).toString(), a1o: u256('0x' + d.slice(192, 256)).toString(), logIndex: li,
      });
    } else if (t0 === TOPIC.mint) {
      const d = log.data.slice(2);
      out.mints.push({ pair: emitter, sender: topicAddr(log.topics[1]), a0: u256('0x' + d.slice(0, 64)).toString(), a1: u256('0x' + d.slice(64, 128)).toString(), logIndex: li });
    } else if (t0 === TOPIC.burn) {
      const d = log.data.slice(2);
      out.burns.push({ pair: emitter, sender: topicAddr(log.topics[1]), recipient: topicAddr(log.topics[2]), a0: u256('0x' + d.slice(0, 64)).toString(), a1: u256('0x' + d.slice(64, 128)).toString(), logIndex: li });
    }
    // Deposit/Withdrawal (wrapped 42) logs are same-owner transformations and
    // are intentionally not events on their own; the swap/transfer they belong
    // to is what gets recorded.
  }
  return out;
}

// ---------------- classification ----------------
// ctx: { watch: Map<addr, entry>, tokens: {addr->{symbol,decimals,whitelisted}},
//        pairs: {addr->{token0,token1}}, pairLabel: (addr)=>label|null }
export function makeCtx(watchlist, registries, pairsCache = {}) {
  const watch = new Map(watchlist.entries.map((e) => [e.address, e]));
  const pairs = { ...registries.pairs, ...pairsCache };
  return {
    watch, tokens: registries.tokens, pairs,
    entry: (a) => watch.get(lc(a)) ?? null,
    // An address can be an event ACTOR only if it is watched, is not a pair
    // contract, and is not core infrastructure (pairs/routers/etc. appear as
    // related/core for labelling — they are not people, and e.g. the DEX
    // router is the Swap event's recipient on native-out swaps, which would
    // otherwise swallow the real actor). Two deliberate exceptions: validators
    // always count (Xenia is both validator and distributor-type core), and
    // the #1 holder 0x7a6f...0a25 (distributor-type core, but a real actor).
    isActor: (a) => {
      const e = watch.get(lc(a));
      if (!e || !e.watch || e.isPair) return false;
      if (e.tier === 'validator') return true;
      if (e.isCore && e.address !== '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25') return false;
      return true;
    },
    tokenInfo: (a) => registries.tokens[lc(a)] ?? { symbol: '…' + lc(a).slice(-4), decimals: 18, whitelisted: false },
    pairLabel: (a) => watch.get(lc(a))?.label ?? null,
  };
}

function amountObj(ctx, tokenAddr, rawStr) {
  const info = ctx.tokenInfo(tokenAddr);
  return { token: lc(tokenAddr), symbol: info.symbol, amountRaw: rawStr, amount: fmtNum(rawStr, info.decimals), whitelisted: info.whitelisted };
}
function validatorNamesFor(ctx, actorEntry, counterpartyAddr) {
  const names = new Set();
  if (actorEntry?.tier === 'validator' && actorEntry.label) names.add(actorEntry.label);
  for (const n of actorEntry?.relatedValidators ?? []) names.add(n);
  const cp = counterpartyAddr ? ctx.entry(counterpartyAddr) : null;
  if (cp?.tier === 'validator' && cp.label) names.add(cp.label);
  for (const n of cp?.relatedValidators ?? []) if (actorEntry?.tier === 'validator') names.add(n);
  return [...names];
}
function notableReasons(ev) {
  const reasons = [];
  if (ev.actorTier === 'validator' && (ev.type === 'swap-buy' || ev.type === 'swap-sell')) reasons.push('バリデーター本人の売買');
  const amounts = [];
  if (ev.sold) amounts.push(ev.sold);
  if (ev.bought) amounts.push(ev.bought);
  if (ev.amount) amounts.push(ev.amount);
  for (const a of ev.amounts ?? []) amounts.push(a);
  const big42 = amounts.some((a) => a.token === W42 && Number(decimalStr(a.amountRaw, 18)) >= NOTABLE_42_THRESHOLD);
  if (big42) reasons.push(`大きな[42]の移動（${NOTABLE_42_THRESHOLD.toLocaleString()} [42]以上）`);
  return reasons;
}
function baseEvent(ctx, tx, blockTs, actorAddr, counterpartyAddr, type, logIndex) {
  const ae = ctx.entry(actorAddr);
  const ce = counterpartyAddr ? ctx.entry(counterpartyAddr) : null;
  return {
    id: `${lc(tx.hash)}:${logIndex ?? 'tx'}:${type}:${lc(actorAddr)}`,
    ts: blockTs, block: Number(tx.blockNumber ?? 0) || undefined,
    txHash: lc(tx.hash), logIndex: logIndex ?? null, type,
    actor: lc(actorAddr), actorLabel: ae?.label ?? null, actorTier: ae?.tier ?? null, actorIsCore: !!ae?.isCore,
    counterparty: counterpartyAddr ? lc(counterpartyAddr) : null,
    counterpartyLabel: ce?.label ?? (counterpartyAddr ? ctx.pairLabel(counterpartyAddr) : null),
    counterpartyIsCore: !!ce?.isCore,
    validatorNames: validatorNamesFor(ctx, ae, counterpartyAddr),
  };
}

// Classify one successful tx into 0..n watched events.
// Swap/LP logs make a tx a swap/LP tx: its internal ERC-20 transfer legs are
// part of that transformation and are NOT also recorded as transfers.
export function classifyTx(ctx, tx, receipt, blockTs, blockNumber) {
  if (!receipt || receipt.status === '0x0') return [];
  const txN = { ...tx, blockNumber: blockNumber ?? (typeof tx.blockNumber === 'string' ? parseInt(tx.blockNumber, 16) : tx.blockNumber) };
  const from = lc(tx.from), to = lc(tx.to);
  const dec = decodeReceiptLogs(receipt);
  const events = [];
  const pickActor = (candidates) => candidates.map(lc).find((a) => a && ctx.isActor(a)) ?? null;
  // Transfer actor when one or both sides are watched: a validator self beats
  // a related counterparty (the feed is validator-centric); if both/neither
  // are validators, the sender is the actor.
  const transferActor = (f, t) => {
    const fe = ctx.isActor(f), te = t && ctx.isActor(t);
    if (!fe && !te) return null;
    if (fe && te) {
      const fv = ctx.entry(f)?.tier === 'validator', tv = ctx.entry(t)?.tier === 'validator';
      if (tv && !fv) return lc(t);
    }
    return fe ? lc(f) : lc(t);
  };

  // ---- swaps: actor's asset transformation ----
  for (const s of dec.swaps) {
    const actor = pickActor([s.recipient, from, s.sender]);
    if (!actor) continue;
    const pair = ctx.pairs[s.pair];
    if (!pair) continue; // unknown pair token order; remote resolution happens in the collector loop before classify
    const ins = [[pair.token0, s.a0i], [pair.token1, s.a1i]].filter(([, a]) => BigInt(a) > 0n);
    const outs = [[pair.token0, s.a0o], [pair.token1, s.a1o]].filter(([, a]) => BigInt(a) > 0n);
    if (ins.length !== 1 || outs.length !== 1) continue; // multi-asset swap legs: not seen on this V2 fork's single-pair events
    const sold = amountObj(ctx, ins[0][0], ins[0][1]);
    const bought = amountObj(ctx, outs[0][0], outs[0][1]);
    // 買い/売り rule (documented on the site): the [42]/USDT side is the quote.
    //  - receive a non-quote token (paying quote)  -> 買い of the received token
    //  - pay a non-quote token (receiving quote)   -> 売り of the paid token
    //  - USDT -> [42] is 買い of [42]; [42] -> USDT is 売り of [42].
    //  - neither side is quote: 買い of the received token (fallback).
    const USDT = '0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753';
    const isQuote = (t) => t === W42 || t === USDT;
    let type, subject, price, priceUnit;
    if (sold.token === W42 && bought.token === USDT) { type = 'swap-sell'; subject = sold; }
    else if (isQuote(sold.token) && !isQuote(bought.token)) { type = 'swap-buy'; subject = bought; }
    else if (!isQuote(sold.token) && isQuote(bought.token)) { type = 'swap-sell'; subject = sold; }
    else if (sold.token === USDT && bought.token === W42) { type = 'swap-buy'; subject = bought; }
    else { type = 'swap-buy'; subject = bought; }
    if (type === 'swap-buy') { price = Number(decimalStr(sold.amountRaw, ctx.tokenInfo(sold.token).decimals)) / Number(decimalStr(bought.amountRaw, ctx.tokenInfo(bought.token).decimals)); priceUnit = `${sold.symbol}/${bought.symbol}`; }
    else { price = Number(decimalStr(bought.amountRaw, ctx.tokenInfo(bought.token).decimals)) / Number(decimalStr(sold.amountRaw, ctx.tokenInfo(sold.token).decimals)); priceUnit = `${bought.symbol}/${sold.symbol}`; }
    const ev = baseEvent(ctx, txN, blockTs, actor, s.pair, type, s.logIndex);
    ev.sold = sold; ev.bought = bought;
    ev.subjectSymbol = subject.symbol;
    ev.price = Number.isFinite(price) ? Math.round(price * 1e8) / 1e8 : null;
    ev.priceUnit = priceUnit;
    ev.pair = s.pair; ev.pairLabel = ctx.pairLabel(s.pair);
    ev.tokens = [sold.symbol, bought.symbol];
    ev.whitelisted = sold.whitelisted && bought.whitelisted;
    ev.summary = type === 'swap-buy'
      ? `${bought.symbol}を買い（支払い ${sold.amount} ${sold.symbol}／価格 約${ev.price} ${priceUnit}）`
      : `${sold.symbol}を売り（受取 ${bought.amount} ${bought.symbol}／価格 約${ev.price} ${priceUnit}）`;
    ev.notableReasons = notableReasons(ev);
    events.push(ev);
  }
  if (events.length) return events;

  // ---- LP add / remove ----
  for (const m of [...dec.mints.map((x) => ({ ...x, kind: 'mint' })), ...dec.burns.map((x) => ({ ...x, kind: 'burn' }))]) {
    const pair = ctx.pairs[m.pair];
    if (!pair) continue;
    const lpMintTo = dec.transfers.filter((t) => t.token === m.pair && t.from === ZERO).map((t) => t.to);
    const lpBurnFrom = dec.transfers.filter((t) => t.token === m.pair && (t.to === m.pair || t.to === ZERO)).map((t) => t.from);
    const actor = pickActor(m.kind === 'mint'
      ? [from, ...lpMintTo, m.sender]
      : [from, m.sender, m.recipient, ...lpBurnFrom]);
    if (!actor) continue;
    const ev = baseEvent(ctx, txN, blockTs, actor, m.pair, m.kind === 'mint' ? 'lp-add' : 'lp-remove', m.logIndex);
    ev.amounts = [amountObj(ctx, pair.token0, m.a0), amountObj(ctx, pair.token1, m.a1)];
    ev.pair = m.pair; ev.pairLabel = ctx.pairLabel(m.pair);
    ev.tokens = ev.amounts.map((a) => a.symbol);
    ev.whitelisted = ev.amounts.every((a) => a.whitelisted);
    ev.summary = `${m.kind === 'mint' ? 'LP追加' : 'LP解除'}：${ev.amounts[0].amount} ${ev.amounts[0].symbol} ＋ ${ev.amounts[1].amount} ${ev.amounts[1].symbol}（${ev.pairLabel ?? 'ペア'}）`;
    ev.notableReasons = notableReasons(ev);
    events.push(ev);
  }
  if (events.length) return events;

  // ---- plain transfers (ERC-20 logs + native value), no amount floor ----
  if (dec.swaps.length === 0 && dec.mints.length === 0 && dec.burns.length === 0) {
    for (const t of dec.transfers) {
      if (t.from === ZERO || t.to === ZERO) continue; // mint/burn legs are issuance, not transfers
      const actor = transferActor(t.from, t.to);
      if (!actor) continue;
      const outgoing = actor === t.from;
      const ev = baseEvent(ctx, txN, blockTs, actor, outgoing ? t.to : t.from, 'transfer', t.logIndex);
      ev.direction = outgoing ? 'out' : 'in';
      ev.amount = amountObj(ctx, t.token, t.amountRaw);
      ev.from = t.from; ev.to = t.to;
      ev.tokens = [ev.amount.symbol];
      ev.whitelisted = ev.amount.whitelisted;
      ev.summary = outgoing ? `${ev.amount.amount} ${ev.amount.symbol} を送金` : `${ev.amount.amount} ${ev.amount.symbol} を受取`;
      ev.notableReasons = notableReasons(ev);
      events.push(ev);
    }
    const value = BigInt(tx.value ?? '0x0');
    if (value > 0n) {
      const actor = transferActor(from, to);
      if (actor) {
        const outgoing = actor === from;
        const ev = baseEvent(ctx, txN, blockTs, actor, outgoing ? to : from, 'transfer', null);
        ev.direction = outgoing ? 'out' : 'in';
        ev.amount = amountObj(ctx, W42, value.toString());
        ev.from = from; ev.to = to;
        ev.tokens = ['42'];
        ev.whitelisted = true;
        ev.summary = outgoing ? `${ev.amount.amount} [42] を送金` : `${ev.amount.amount} [42] を受取`;
        ev.notableReasons = notableReasons(ev);
        events.push(ev);
      }
    }
    if (events.length) return events;
  }

  // ---- other contract interaction by a watched sender ----
  if (from && ctx.isActor(from) && to && (tx.input ?? '0x') !== '0x') {
    const ev = baseEvent(ctx, txN, blockTs, from, to, 'other-contract', null);
    ev.method = (tx.input ?? '').slice(0, 10);
    ev.tokens = [];
    ev.whitelisted = true;
    ev.summary = `その他の操作（宛先 …${to.slice(-4)}）`;
    ev.notableReasons = [];
    events.push(ev);
  }
  return events;
}

// ---------------- RPC (batched, host fallback, browser UA) ----------------
let rpcStats = { requests: 0, retries: 0 };
async function rpcBatch(calls, depth = 0) {
  let lastErr;
  for (let attempt = 0; attempt < RPC_HOSTS.length * 2; attempt++) {
    const host = RPC_HOSTS[attempt % RPC_HOSTS.length];
    rpcStats.requests++;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    try {
      const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
      const r = await fetch(host, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('non-array batch response');
      const out = new Array(calls.length).fill(null);
      for (const item of j) if (typeof item.id === 'number') out[item.id] = item.error ? null : item.result;
      return out;
    } catch (e) {
      lastErr = e; rpcStats.retries++;
      if (calls.length > 1 && depth < 4) {
        const mid = Math.ceil(calls.length / 2);
        return (await rpcBatch(calls.slice(0, mid), depth + 1)).concat(await rpcBatch(calls.slice(mid), depth + 1));
      }
      await sleep(1000 * (attempt + 1));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}
const rpcOne = async (method, params) => (await rpcBatch([{ method, params }]))[0];

// Resolve token0/token1 for a pair we have never seen (cached to pairs-cache.json).
async function resolvePairRemote(ctx, pairAddr, cache, cachePath) {
  const sel = (data) => ({ method: 'eth_call', params: [{ to: pairAddr, data }, 'latest'] });
  const [t0, t1] = await rpcBatch([sel('0x0dfe1681'), sel('0xd21220a7')]);
  if (!t0 || !t1) return null;
  const pair = { token0: topicAddr(t0), token1: topicAddr(t1) };
  ctx.pairs[pairAddr] = pair; cache[pairAddr] = pair;
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  return pair;
}

// ---------------- main collector ----------------
async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const backfillIdx = args.indexOf('--backfill');
  const backfill = backfillIdx >= 0 ? Number(args[backfillIdx + 1]) : null;
  const rangeIdx = args.indexOf('--range');
  const range = rangeIdx >= 0 ? args[rangeIdx + 1].split(':').map(Number) : null;
  const pollMs = Number(process.env.POLL_MS ?? 10000);

  const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
  const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
  const cachePath = join(__dir, 'pairs-cache.json');
  const pairsCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const ctx = makeCtx(watchlist, registries, pairsCache);

  const statePath = join(__dir, 'state.json');
  const eventsPath = join(__dir, 'events.jsonl');
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { lastProcessedBlock: null, totalBlocksScanned: 0, totalTxsScanned: 0, totalEventsFound: 0, updatedAt: null };
  const allEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const seen = new Set(allEvents.map((e) => e.id));
  const OTHER_REPEAT_WINDOW_BLOCKS = 360; // ~30 min at 5.4s/block
  const lastOtherByKey = new Map();
  for (const e of allEvents) if (e.type === 'other-contract') lastOtherByKey.set(`${e.actor}|${e.counterparty}|${e.method}`, Math.max(e.block ?? 0, lastOtherByKey.get(`${e.actor}|${e.counterparty}|${e.method}`) ?? 0));

  const saveState = () => { state.updatedAt = new Date().toISOString(); writeFileSync(statePath, JSON.stringify(state, null, 1)); };
  function writeFeed(latestBlock) {
    const sorted = [...allEvents].sort((a, b) => (b.block - a.block) || ((b.logIndex ?? -1) - (a.logIndex ?? -1)));
    const validators = watchlist.entries.filter((e) => e.tier === 'validator').map((v) => ({
      moniker: v.label, address: v.address, isCore: v.isCore,
      relatedCount: watchlist.entries.filter((e) => e.tier === 'related' && e.relatedValidators.includes(v.label)).length,
    }));
    const feed = {
      generatedAt: new Date().toISOString(),
      status: {
        lastProcessedBlock: state.lastProcessedBlock, latestBlockSeen: latestBlock ?? null,
        lastProcessedAt: state.updatedAt, totalEvents: allEvents.length,
        watchSummary: watchlist.summary,
        notableRule: `注目ルール：①バリデーター本人の売買 ②${NOTABLE_42_THRESHOLD.toLocaleString()} [42]以上の移動`,
      },
      validators,
      events: sorted.slice(0, 500),
    };
    writeFileSync(join(__dir, 'feed.json'), JSON.stringify(feed, null, 1));
    return feed;
  }

  async function processRange(start, end) {
    let newEvents = 0, txs = 0;
    for (let chunkStart = start; chunkStart <= end; chunkStart += 50) {
      const chunkEnd = Math.min(chunkStart + 49, end);
      const heights = []; for (let h = chunkStart; h <= chunkEnd; h++) heights.push(h);
      const blocks = await rpcBatch(heights.map((h) => ({ method: 'eth_getBlockByNumber', params: ['0x' + h.toString(16), true] })));
      const jobs = []; // {tx, receipt, ts, block}
      const receiptCalls = []; const receiptMeta = [];
      blocks.forEach((blk, i) => {
        if (!blk) return;
        const ts = parseInt(blk.timestamp, 16);
        for (const tx of blk.transactions ?? []) {
          txs++;
          receiptCalls.push({ method: 'eth_getTransactionReceipt', params: [tx.hash] });
          receiptMeta.push({ tx, ts, block: heights[i] });
        }
      });
      for (let i = 0; i < receiptCalls.length; i += 40) {
        const receipts = await rpcBatch(receiptCalls.slice(i, i + 40));
        for (let j = 0; j < receipts.length; j++) {
          const meta = receiptMeta[i + j]; const receipt = receipts[j];
          if (!receipt) continue;
          // resolve unknown pairs before classifying swaps in this tx
          for (const log of receipt.logs ?? []) {
            if (log.topics?.[0] === TOPIC.swap && !ctx.pairs[lc(log.address)]) {
              await resolvePairRemote(ctx, lc(log.address), pairsCache, cachePath).catch(() => null);
            }
          }
          const evs = classifyTx(ctx, meta.tx, receipt, meta.ts, meta.block);
          for (const ev of evs) {
            if (seen.has(ev.id)) continue;
            // Repetition suppression for "other-contract" ONLY: a keeper-like
            // related address (0xbfc5…4f29, 43k+ txs in the flowmap snapshot)
            // repeats the same call every few blocks and would flood the feed.
            // Transfers / swaps / LP events are NEVER suppressed (standing
            // rule: watched transfers are tracked no matter how small/frequent).
            if (ev.type === 'other-contract') {
              const key = `${ev.actor}|${ev.counterparty}|${ev.method}`;
              const last = lastOtherByKey.get(key);
              if (last != null && meta.block - last < OTHER_REPEAT_WINDOW_BLOCKS) continue;
              lastOtherByKey.set(key, meta.block);
            }
            seen.add(ev.id); allEvents.push(ev);
            appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
            newEvents++;
          }
        }
      }
      state.lastProcessedBlock = chunkEnd;
      state.totalBlocksScanned += (chunkEnd - chunkStart + 1);
      state.totalTxsScanned += 0; // txs accumulated below at range end to keep state writes cheap
      saveState();
    }
    state.totalTxsScanned += txs;
    state.totalEventsFound = allEvents.length;
    saveState();
    return { newEvents, txs };
  }

  const latest = Number(await rpcOne('eth_blockNumber', []).then((h) => BigInt(h)));
  console.log('[collector] chain tip:', latest, '| checkpoint:', state.lastProcessedBlock, '| known events:', allEvents.length);

  if (range) {
    const [a, b] = range;
    console.log(`[collector] --range ${a}:${b}`);
    const r = await processRange(a, b);
    writeFeed(latest);
    console.log(`[collector] done: blocks ${b - a + 1}, txs ${r.txs}, new watched events ${r.newEvents}, total events ${allEvents.length}`);
    return;
  }
  if (backfill != null) {
    const start = Math.max(0, latest - backfill + 1);
    console.log(`[collector] --backfill ${backfill}: blocks ${start}..${latest}`);
    const r = await processRange(start, latest);
    writeFeed(latest);
    console.log(`[collector] done: blocks ${backfill}, txs ${r.txs}, new watched events ${r.newEvents}, total events ${allEvents.length}`);
    return;
  }
  if (state.lastProcessedBlock == null) {
    state.lastProcessedBlock = latest;
    saveState();
    writeFeed(latest);
    console.log('[collector] first run: checkpoint set to tip (use --backfill N to scan history)');
    if (once) return;
  }
  do {
    const tip = Number(await rpcOne('eth_blockNumber', []).then((h) => BigInt(h)));
    if (tip > state.lastProcessedBlock) {
      const start = state.lastProcessedBlock + 1;
      const end = Math.min(tip, start + 1999);
      const r = await processRange(start, end);
      writeFeed(tip);
      console.log(`[collector] blocks ${start}..${end}: txs ${r.txs}, new events ${r.newEvents} (tip ${tip})`);
    } else if (once) {
      writeFeed(tip);
      console.log('[collector] no new blocks');
    }
    if (once) break;
    await sleep(pollMs);
  } while (true);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('[collector] FATAL', e); process.exit(1); });
