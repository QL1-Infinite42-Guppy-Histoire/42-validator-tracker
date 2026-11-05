#!/usr/bin/env node
// 42 Validator Tracker — collector (v0.2.0: EVM side + Cosmos side).
//
// Polls the 42 Chain EVM RPC for new blocks, decodes receipts with NO external
// dependencies (topic hashes are the standard ERC-20 / Uniswap V2 ones,
// verified against ethers.id() during development), classifies events that
// involve watched addresses (validators + their CONFIRMED direct related
// addresses from watchlist.json), appends them to events.jsonl and regenerates
// feed.json (latest 500 events) for the static frontend.
//
// v0.2.0 additions:
//  - Cosmos side (Phase 2): CometBFT tx_search per message action + a minimal
//    protobuf decoder for the TxBody messages (bank MsgSend, staking
//    delegate/undelegate/redelegate, distribution reward/commission).
//    MsgEthereumTx is never queried or decoded here — the EVM side already
//    covers it, so there is no double counting. Message-level decoding also
//    means fee legs never appear (fees live in AuthInfo, not in messages).
//  - Snipe flagging: swap-buy / lp-add events get pairCreatedTs + pairAgeSecs
//    + isSnipe (pair age <= 3h). Pair creation is resolved once per pair via
//    Blockscout's creation_transaction_hash (+ EVM RPC for block/time) and
//    cached in pairs-creation.json.
//  - Display-semantics enrichment on every stored event: chain, the ACTOR's
//    own validator relations (actorValidators — validatorNames stays the
//    union used for filtering), a shared-counterparty flag (>=3 relations),
//    and a research-backed contract note for the one known shared contract.
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
//   node collector.mjs --cosmos-backfill N  # Cosmos side only: last N heights
// Env: POLL_MS (default 10000)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const RPC_HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const COMET_HOSTS = ['https://comet-rpc.infinitepanda.xyz', 'https://comet-rpc-infinite.mschihuahua.org', 'https://comet-rpc.infinitedrive.xyz'];
const FACTORY = '0x3157c6aca800d507af95ab1466adba3a6f11ee1a';
const BLOCKSCOUT = 'https://scan.infinitedrive.xyz/api/v2';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.2';
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

// Snipe definition (printed on the site): a validator-self or direct-related
// wallet buying (swap-buy) or adding LP on a pair within 3 hours of that
// pair's creation. The 3-hour window matches the user's earlier sniping
// research ("first 3 hours" lists).
export const SNIPE_WINDOW_SECS = 3 * 3600;
export const SNIPE_RULE = 'スナイプの定義：ペアが作られてから3時間以内に、バリデーター本人または直接関連ウォレットが、そのペアで買う（買い）またはLP追加した動き';

// Known contracts among watched addresses, from the 2026-10-31 validator
// research (~/workspace/42-flowmap validator dossiers): 0x71b13838…30E0 is a
// CONTRACT holding 90%+ of the LP shares of several FISH pairs and is a shared
// counterparty of 8 validators — a shared service/LP contract, not a person.
// Only addresses verified in research are listed here; do not add guesses.
export const KNOWN_CONTRACTS = {
  '0x71b138382598fbc4b890d2d20a14f9dedb1430e0': 'コントラクト（複数のFISHペアのLPシェアを保有する共有コントラクト）',
};

// ---------------- bech32 (BIP-173) encode/decode, no deps ----------------
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
export function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('convertBits: invalid padding');
  return out;
}
export function bech32Encode(hrp, bytes) {
  const words = convertBits([...bytes], 8, 5, true);
  const pm = bech32Polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (pm >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...checksum].map((w) => BECH32_ALPHABET[w]).join('');
}
export function bech32Decode(str) {
  const s = String(str).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) throw new Error('bech32: no separator');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => { const v = BECH32_ALPHABET.indexOf(c); if (v < 0) throw new Error('bech32: bad char'); return v; });
  if (data.length < 6 || bech32Polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bech32: bad checksum');
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return { hrp, bytes: Buffer.from(bytes) };
}
export const hexToBech32 = (hex, hrp = 'infinite') => bech32Encode(hrp, Buffer.from(String(hex).replace(/^0x/, ''), 'hex'));
export const bech32ToHex = (s) => '0x' + bech32Decode(s).bytes.toString('hex');

// ---------------- minimal protobuf decoding (Cosmos Tx) ----------------
function readVarint(buf, pos) {
  let result = 0n, shift = 0n;
  while (pos < buf.length) { const b = buf[pos++]; result |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) return [result, pos]; shift += 7n; }
  throw new Error('proto: truncated varint');
}
export function parseProto(buf) {
  const fields = []; let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos); pos = p1;
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { const [v, p2] = readVarint(buf, pos); pos = p2; fields.push({ field, wire, value: v }); }
    else if (wire === 2) { const [len, p2] = readVarint(buf, pos); pos = p2; const n = Number(len); fields.push({ field, wire, value: buf.subarray(pos, pos + n) }); pos += n; }
    else if (wire === 5) { fields.push({ field, wire, value: buf.subarray(pos, pos + 4) }); pos += 4; }
    else if (wire === 1) { fields.push({ field, wire, value: buf.subarray(pos, pos + 8) }); pos += 8; }
    else throw new Error('proto: bad wire type ' + wire);
  }
  return fields;
}
const pfB = (fields, n) => fields.filter((f) => f.field === n && f.wire === 2).map((f) => f.value);
const pfS = (fields, n) => pfB(fields, n).map((b) => b.toString('utf8'));
function parseCoin(buf) { const f = parseProto(buf); return { denom: pfS(f, 1)[0] ?? '', amount: pfS(f, 2)[0] ?? '0' }; }
// Decode a Cosmos Tx (base64 raw bytes, as returned by CometBFT) into its
// TxBody messages: [{typeUrl, value(Buffer)}]. AuthInfo/signatures ignored.
export function decodeCosmosMessages(txB64) {
  const raw = Buffer.from(txB64, 'base64');
  const tx = parseProto(raw);
  const bodyBytes = pfB(tx, 1)[0];
  if (!bodyBytes) return [];
  const body = parseProto(bodyBytes);
  return pfB(body, 1).map((anyBytes) => {
    const any = parseProto(anyBytes);
    return { typeUrl: pfS(any, 1)[0] ?? '', value: pfB(any, 2)[0] ?? Buffer.alloc(0) };
  });
}

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

// ---------------- display-semantics enrichment (v0.2.0) ----------------
// validatorNames stays the UNION used for FILTERING. For DISPLAY the site
// needs the ACTOR's own relations only (actorValidators), whether the actor
// is a shared counterparty of >=3 validators (actorShared), a research-backed
// contract note, and snipe fields for swap-buy/lp-add events. Returns true if
// anything changed (used by the stored-events migration on load).
export function enrichEvent(ev, ctx, creations = {}) {
  let changed = false;
  const set = (k, v) => { if (JSON.stringify(ev[k]) !== JSON.stringify(v)) { ev[k] = v; changed = true; } };
  if (!ev.chain) set('chain', 'evm');
  const ae = ctx.entry(ev.actor);
  const rel = ae?.tier === 'validator' ? [] : [...(ae?.relatedValidators ?? [])];
  set('actorValidators', rel);
  set('actorShared', ev.actorTier !== 'validator' && rel.length >= 3);
  set('actorContractNote', KNOWN_CONTRACTS[lc(ev.actor)] ?? null);
  if ((ev.type === 'swap-buy' || ev.type === 'lp-add') && ev.pair) {
    const c = creations[lc(ev.pair)];
    if (c?.createdTs) {
      set('pairCreatedTs', c.createdTs);
      const age = ev.ts - c.createdTs;
      set('pairAgeSecs', age);
      set('isSnipe', age >= 0 && age <= SNIPE_WINDOW_SECS);
    }
  }
  return changed;
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

// ---------------- Cosmos side (CometBFT, Phase 2 / v0.2.0) ----------------
// CometBFT JSON-RPC does NOT support batched requests: single calls with host
// rotation + retries (same recipe as 42-flowmap/finalize.mjs rpcCometBatch).
let cometStats = { requests: 0, retries: 0 };
async function cometOne(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < COMET_HOSTS.length * 2; attempt++) {
    const host = COMET_HOSTS[attempt % COMET_HOSTS.length];
    cometStats.requests++;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(host, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error('comet error ' + JSON.stringify(j.error).slice(0, 160));
      return j.result;
    } catch (e) { lastErr = e; cometStats.retries++; await sleep(800 * (attempt + 1)); }
    finally { clearTimeout(t); }
  }
  throw lastErr;
}
// All tx_search results for a query (paginated to exhaustion, asc order).
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
  return { txs: out, total };
}
export const COSMOS_ACTIONS = {
  send: '/cosmos.bank.v1beta1.MsgSend',
  delegate: '/cosmos.staking.v1beta1.MsgDelegate',
  undelegate: '/cosmos.staking.v1beta1.MsgUndelegate',
  redelegate: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
  reward: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
  commission: '/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission',
};
function cosmosAmount(coin) {
  if (!coin) return null;
  if (coin.denom === 'drop') return { token: W42, denom: 'drop', symbol: '42', amountRaw: coin.amount, amount: fmtNum(coin.amount, 18), whitelisted: true };
  return { token: 'cosmos:' + coin.denom, denom: coin.denom, symbol: coin.denom, amountRaw: coin.amount, amount: fmtNum(coin.amount, 0), whitelisted: false };
}
function parseCoinAmountStr(s) {
  // "123drop" or "123drop,456uatom" -> first coin {amount, denom}
  const m = String(s ?? '').split(',')[0].match(/^(\d+)(.*)$/);
  return m ? { amount: m[1], denom: m[2] } : null;
}
function cosmosBase(ctx, hashUpper, height, ts, msgIndex, actorAddr, counterpartyAddr, type) {
  const ae = ctx.entry(actorAddr);
  const ce = counterpartyAddr ? ctx.entry(counterpartyAddr) : null;
  return {
    id: `cosmos:${hashUpper}:${msgIndex}:${type}:${lc(actorAddr)}`,
    chain: 'cosmos',
    ts, block: height,
    txHash: hashUpper, logIndex: null, type,
    actor: lc(actorAddr), actorLabel: ae?.label ?? null, actorTier: ae?.tier ?? null, actorIsCore: !!ae?.isCore,
    counterparty: counterpartyAddr ? lc(counterpartyAddr) : null,
    counterpartyLabel: ce?.label ?? null, counterpartyIsCore: !!ce?.isCore,
    validatorNames: validatorNamesFor(ctx, ae, counterpartyAddr),
  };
}
// Classify one Cosmos tx (from tx_search) into watched events. Messages are
// protobuf-decoded from the raw tx bytes, so fee legs never appear and
// MsgEthereumTx messages are skipped (EVM side covers them — no double count).
export function classifyCosmosTx(ctx, txItem, blockTs) {
  if ((txItem.tx_result?.code ?? 0) !== 0) return [];
  const hashUpper = String(txItem.hash).toUpperCase();
  const height = Number(txItem.height);
  let msgs;
  try { msgs = decodeCosmosMessages(txItem.tx); } catch { return []; }
  const events = [];
  const resultEvents = txItem.tx_result?.events ?? [];
  const evAttr = (type, key) => { const e = resultEvents.find((x) => x.type === type); const a = e?.attributes?.find((x) => x.key === key); return a?.value ?? null; };
  const transferActor = (f, t) => {
    const fe = ctx.isActor(f), te = t && ctx.isActor(t);
    if (!fe && !te) return null;
    if (fe && te) {
      const fv = ctx.entry(f)?.tier === 'validator', tv = ctx.entry(t)?.tier === 'validator';
      if (tv && !fv) return lc(t);
    }
    return fe ? lc(f) : lc(t);
  };
  msgs.forEach((m, mi) => {
    try {
      if (m.typeUrl.endsWith('MsgEthereumTx')) return; // EVM side covers it
      const f = parseProto(m.value);
      if (m.typeUrl === COSMOS_ACTIONS.send) {
        const from = bech32ToHex(pfS(f, 1)[0] ?? '');
        const to = bech32ToHex(pfS(f, 2)[0] ?? '');
        const coins = pfB(f, 3).map(parseCoin);
        for (const coin of coins) {
          const actor = transferActor(from, to);
          if (!actor) continue;
          const outgoing = actor === from;
          const ev = cosmosBase(ctx, hashUpper, height, blockTs, mi, actor, outgoing ? to : from, 'transfer');
          ev.direction = outgoing ? 'out' : 'in';
          ev.amount = cosmosAmount(coin);
          ev.from = from; ev.to = to;
          ev.tokens = [ev.amount.symbol];
          ev.whitelisted = ev.amount.whitelisted;
          ev.summary = ev.amount.denom === 'drop'
            ? (outgoing ? `${ev.amount.amount} [42] を送金` : `${ev.amount.amount} [42] を受取`)
            : (outgoing ? `${ev.amount.amount} ${ev.amount.symbol} を送金` : `${ev.amount.amount} ${ev.amount.symbol} を受取`);
          ev.notableReasons = notableReasons(ev);
          events.push(ev);
        }
      } else if (m.typeUrl === COSMOS_ACTIONS.delegate || m.typeUrl === COSMOS_ACTIONS.undelegate) {
        const delegator = bech32ToHex(pfS(f, 1)[0] ?? '');
        const validator = bech32ToHex(pfS(f, 2)[0] ?? '');
        const coin = pfB(f, 3).map(parseCoin)[0];
        if (!ctx.isActor(delegator)) return;
        const type = m.typeUrl === COSMOS_ACTIONS.delegate ? 'delegate' : 'undelegate';
        const ev = cosmosBase(ctx, hashUpper, height, blockTs, mi, delegator, validator, type);
        ev.amount = cosmosAmount(coin);
        ev.tokens = ev.amount ? [ev.amount.symbol] : [];
        ev.whitelisted = ev.amount ? ev.amount.whitelisted : true;
        // A validator outside the current 23-name snapshot (e.g. an early
        // self-delegating operator) has no label: show its last-4 instead of
        // a bare generic word.
        const vName = ctx.entry(validator)?.label ?? `バリデーター …${validator.slice(-4).toUpperCase()}`;
        ev.summary = type === 'delegate'
          ? `${ev.amount?.amount ?? ''} [42] を ${vName} に委任`
          : `${vName} への委任を解除（${ev.amount?.amount ?? ''} [42]）`;
        ev.notableReasons = notableReasons(ev);
        events.push(ev);
      } else if (m.typeUrl === COSMOS_ACTIONS.redelegate) {
        const delegator = bech32ToHex(pfS(f, 1)[0] ?? '');
        const src = bech32ToHex(pfS(f, 2)[0] ?? '');
        const dst = bech32ToHex(pfS(f, 3)[0] ?? '');
        const coin = pfB(f, 4).map(parseCoin)[0];
        if (!ctx.isActor(delegator)) return;
        const ev = cosmosBase(ctx, hashUpper, height, blockTs, mi, delegator, dst, 'redelegate');
        ev.amount = cosmosAmount(coin);
        ev.tokens = ev.amount ? [ev.amount.symbol] : [];
        ev.whitelisted = ev.amount ? ev.amount.whitelisted : true;
        ev.summary = `委任先を変更：${ctx.entry(src)?.label ?? `バリデーター …${src.slice(-4).toUpperCase()}`} → ${ctx.entry(dst)?.label ?? `バリデーター …${dst.slice(-4).toUpperCase()}`}（${ev.amount?.amount ?? ''} [42]）`;
        ev.notableReasons = notableReasons(ev);
        events.push(ev);
      } else if (m.typeUrl === COSMOS_ACTIONS.reward) {
        const delegator = bech32ToHex(pfS(f, 1)[0] ?? '');
        const validator = bech32ToHex(pfS(f, 2)[0] ?? '');
        if (!ctx.isActor(delegator)) return;
        const ev = cosmosBase(ctx, hashUpper, height, blockTs, mi, delegator, validator, 'reward');
        const amtCoin = parseCoinAmountStr(evAttr('withdraw_rewards', 'amount'));
        ev.amount = amtCoin ? cosmosAmount(amtCoin) : null;
        ev.tokens = ev.amount ? [ev.amount.symbol] : [];
        ev.whitelisted = ev.amount ? ev.amount.whitelisted : true;
        ev.summary = `ステーキング報酬を受け取り${ev.amount ? `（${ev.amount.amount} [42]）` : ''}：${ctx.entry(validator)?.label ?? `バリデーター …${validator.slice(-4).toUpperCase()}`} 分`;
        ev.notableReasons = ev.amount ? notableReasons(ev) : [];
        events.push(ev);
      } else if (m.typeUrl === COSMOS_ACTIONS.commission) {
        const validator = bech32ToHex(pfS(f, 1)[0] ?? '');
        if (!ctx.isActor(validator)) return;
        const ev = cosmosBase(ctx, hashUpper, height, blockTs, mi, validator, null, 'commission');
        const amtCoin = parseCoinAmountStr(evAttr('withdraw_commission', 'amount'));
        ev.amount = amtCoin ? cosmosAmount(amtCoin) : null;
        ev.tokens = ev.amount ? [ev.amount.symbol] : [];
        ev.whitelisted = ev.amount ? ev.amount.whitelisted : true;
        ev.summary = `バリデーター手数料報酬を受け取り${ev.amount ? `（${ev.amount.amount} [42]）` : ''}`;
        ev.notableReasons = ev.amount ? notableReasons(ev) : [];
        events.push(ev);
      }
    } catch { /* one malformed message must not kill the tx */ }
  });
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

// Resolve a pair's creation block/time ONCE, cached in pairs-creation.json.
// Primary source: Blockscout's creation_transaction_hash for the pair address
// (+ EVM RPC for the tx's block and its timestamp). Fallback: factory
// PairCreated logs scanned backwards in 10k-block chunks (RPC range limit).
const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cd57a1faf3cdda2601';
async function resolvePairCreation(pairAddr, creations, creationsPath) {
  pairAddr = lc(pairAddr);
  if (creations[pairAddr]?.createdTs) return creations[pairAddr];
  const save = (v) => { creations[pairAddr] = v; writeFileSync(creationsPath, JSON.stringify(creations, null, 1)); return v; };
  try {
    const r = await fetch(`${BLOCKSCOUT}/addresses/${pairAddr}`, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const j = await r.json();
      const h = j.creation_transaction_hash;
      if (h) {
        const [receipt] = await rpcBatch([{ method: 'eth_getTransactionReceipt', params: [h] }]);
        if (receipt?.blockNumber) {
          const blk = parseInt(receipt.blockNumber, 16);
          const [b] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['0x' + blk.toString(16), false] }]);
          if (b?.timestamp) return save({ createdBlock: blk, createdTs: parseInt(b.timestamp, 16), source: 'blockscout-creation-tx' });
        }
      }
    }
  } catch { /* fall through to log scan */ }
  try {
    const tip = Number(BigInt(await rpcOne('eth_blockNumber', [])));
    for (let end = tip; end > 0 && end > tip - 600000; end -= 10000) {
      const from = Math.max(0, end - 9999);
      const logs = (await rpcBatch([{ method: 'eth_getLogs', params: [{ address: FACTORY, topics: [PAIR_CREATED_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + end.toString(16) }] }]))[0];
      for (const log of logs ?? []) {
        const pairInLog = '0x' + String(log.data).slice(26, 66).toLowerCase();
        if (pairInLog === pairAddr) {
          const blk = parseInt(log.blockNumber, 16);
          const [b] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['0x' + blk.toString(16), false] }]);
          if (b?.timestamp) return save({ createdBlock: blk, createdTs: parseInt(b.timestamp, 16), source: 'factory-paircreated-log' });
        }
      }
    }
  } catch { /* leave unresolved; a later run can retry */ }
  return null;
}
// Ensure creation info exists for the pairs used by candidate (swap-buy /
// lp-add) events, bounded per call so an Actions run stays short.
async function ensureCreations(events, creations, creationsPath, cap = 8) {
  const wanted = [...new Set(events.filter((e) => (e.type === 'swap-buy' || e.type === 'lp-add') && e.pair).map((e) => lc(e.pair)))];
  let done = 0;
  for (const p of wanted) {
    if (creations[p]?.createdTs) continue;
    if (done >= cap) break;
    done++;
    await resolvePairCreation(p, creations, creationsPath).catch(() => null);
  }
}

// ---------------- main collector ----------------
async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const backfillIdx = args.indexOf('--backfill');
  const backfill = backfillIdx >= 0 ? Number(args[backfillIdx + 1]) : null;
  const rangeIdx = args.indexOf('--range');
  const range = rangeIdx >= 0 ? args[rangeIdx + 1].split(':').map(Number) : null;
  const cosmosBackfillIdx = args.indexOf('--cosmos-backfill');
  const cosmosBackfill = cosmosBackfillIdx >= 0 ? Number(args[cosmosBackfillIdx + 1]) : null;
  const pollMs = Number(process.env.POLL_MS ?? 10000);

  const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
  const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
  const cachePath = join(__dir, 'pairs-cache.json');
  const pairsCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const creationsPath = join(__dir, 'pairs-creation.json');
  const creations = existsSync(creationsPath) ? JSON.parse(readFileSync(creationsPath, 'utf8')) : {};
  const ctx = makeCtx(watchlist, registries, pairsCache);

  const statePath = join(__dir, 'state.json');
  const eventsPath = join(__dir, 'events.jsonl');
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { lastProcessedBlock: null, totalBlocksScanned: 0, totalTxsScanned: 0, totalEventsFound: 0, updatedAt: null };
  if (state.lastProcessedCosmosBlock === undefined) state.lastProcessedCosmosBlock = null;
  const allEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const seen = new Set(allEvents.map((e) => e.id));

  // Migration: enrich every stored event with v0.2.0 display/snipe fields
  // (chain, actorValidators, actorShared, contract note, pair age). Pair
  // creations for the small set of pairs already in the data are resolved
  // first (retro-flagging); unresolved pairs stay unflagged, never guessed.
  await ensureCreations(allEvents, creations, creationsPath, 12);
  let migrated = 0;
  for (const ev of allEvents) if (enrichEvent(ev, ctx, creations)) migrated++;
  if (migrated) {
    writeFileSync(eventsPath, allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`[collector] migration: enriched ${migrated} stored events (v0.2.0 fields)`);
  }
  const OTHER_REPEAT_WINDOW_BLOCKS = 360; // ~30 min at 5.4s/block
  const lastOtherByKey = new Map();
  for (const e of allEvents) if (e.type === 'other-contract') lastOtherByKey.set(`${e.actor}|${e.counterparty}|${e.method}`, Math.max(e.block ?? 0, lastOtherByKey.get(`${e.actor}|${e.counterparty}|${e.method}`) ?? 0));

  const saveState = () => { state.updatedAt = new Date().toISOString(); writeFileSync(statePath, JSON.stringify(state, null, 1)); };
  function writeFeed(latestBlock) {
    const sorted = [...allEvents].sort((a, b) => (b.block - a.block) || ((b.logIndex ?? -1) - (a.logIndex ?? -1)));
    const validators = watchlist.entries.filter((e) => e.tier === 'validator').map((v) => ({
      moniker: v.label, address: v.address, bech32: hexToBech32(v.address), isCore: v.isCore,
      relatedCount: watchlist.entries.filter((e) => e.tier === 'related' && e.relatedValidators.includes(v.label)).length,
    }));
    const feed = {
      generatedAt: new Date().toISOString(),
      status: {
        lastProcessedBlock: state.lastProcessedBlock, latestBlockSeen: latestBlock ?? null,
        lastProcessedCosmosBlock: state.lastProcessedCosmosBlock ?? null,
        lastProcessedAt: state.updatedAt, totalEvents: allEvents.length,
        watchSummary: watchlist.summary,
        notableRule: `注目ルール：①バリデーター本人の売買 ②${NOTABLE_42_THRESHOLD.toLocaleString()} [42]以上の移動`,
        snipeRule: SNIPE_RULE,
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
            if ((ev.type === 'swap-buy' || ev.type === 'lp-add') && ev.pair && !creations[lc(ev.pair)]?.createdTs) {
              await resolvePairCreation(ev.pair, creations, creationsPath).catch(() => null);
            }
            enrichEvent(ev, ctx, creations);
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

  // ---- Cosmos processing (tx_search per action; protobuf message decode) ----
  const blockTimeCache = new Map();
  async function cosmosBlockTs(height) {
    if (blockTimeCache.has(height)) return blockTimeCache.get(height);
    const res = await cometOne('block', { height: String(height) });
    const ts = Math.floor(new Date(res.block.header.time).getTime() / 1000);
    blockTimeCache.set(height, ts);
    return ts;
  }
  async function processCosmosItems(itemsByAction) {
    let newEvents = 0, decodedMsgs = 0;
    const items = Object.values(itemsByAction).flat();
    // dedupe the same tx returned by several action queries
    const byHash = new Map();
    for (const it of items) byHash.set(String(it.hash).toUpperCase(), it);
    const heights = [...new Set([...byHash.values()].map((t) => Number(t.height)))];
    for (const h of heights) await cosmosBlockTs(h).catch(() => null);
    for (const it of byHash.values()) {
      const ts = blockTimeCache.get(Number(it.height));
      if (ts == null) continue;
      const evs = classifyCosmosTx(ctx, it, ts);
      decodedMsgs += evs.length;
      for (const ev of evs) {
        enrichEvent(ev, ctx, creations);
        if (seen.has(ev.id)) continue;
        seen.add(ev.id); allEvents.push(ev);
        appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
        newEvents++;
      }
    }
    return { newEvents, decodedEvents: decodedMsgs, txs: byHash.size };
  }
  async function processCosmosRange(start, end) {
    const stats = {};
    const itemsByAction = {};
    for (const [name, action] of Object.entries(COSMOS_ACTIONS)) {
      const q = `message.action='${action}' AND tx.height>=${start} AND tx.height<=${end}`;
      const { txs, total } = await txSearchAll(q);
      itemsByAction[name] = txs;
      stats[name] = { searchTotal: total, returned: txs.length };
      console.log(`[cosmos] ${name}: tx_search total ${total}, returned ${txs.length} (heights ${start}..${end})`);
    }
    const r = await processCosmosItems(itemsByAction);
    console.log(`[cosmos] range ${start}..${end}: unique txs ${r.txs}, watched events +${r.newEvents}`);
    return { ...r, stats };
  }
  async function importCosmosHistory() {
    // One-time import used when the cosmos checkpoint is first initialized.
    // All-time non-EVM activity on this chain is small (~800 txs across the
    // six actions), so a full-history import is cheap and gives the feed its
    // historical Cosmos context (incl. Xenia-style small sends). Afterwards
    // the checkpoint takes over and only new ranges are queried.
    const itemsByAction = {};
    for (const [name, action] of Object.entries(COSMOS_ACTIONS)) {
      const { txs, total } = await txSearchAll(`message.action='${action}'`);
      itemsByAction[name] = txs;
      console.log(`[cosmos] history import ${name}: tx_search total ${total}, returned ${txs.length}`);
    }
    const r = await processCosmosItems(itemsByAction);
    console.log(`[cosmos] history import: unique txs ${r.txs}, watched events +${r.newEvents}`);
    return r;
  }

  const latest = Number(await rpcOne('eth_blockNumber', []).then((h) => BigInt(h)));
  console.log('[collector] chain tip:', latest, '| checkpoint:', state.lastProcessedBlock, '| cosmos checkpoint:', state.lastProcessedCosmosBlock, '| known events:', allEvents.length);

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
  if (cosmosBackfill != null) {
    const start = Math.max(0, latest - cosmosBackfill + 1);
    console.log(`[collector] --cosmos-backfill ${cosmosBackfill}: heights ${start}..${latest}`);
    await processCosmosRange(start, latest);
    state.totalEventsFound = allEvents.length;
    saveState();
    writeFeed(latest);
    console.log(`[collector] cosmos backfill done: total events ${allEvents.length}`);
    return;
  }
  if (state.lastProcessedBlock == null) {
    state.lastProcessedBlock = latest;
    saveState();
    writeFeed(latest);
    console.log('[collector] first run: checkpoint set to tip (use --backfill N to scan history)');
  }
  do {
    const tip = Number(await rpcOne('eth_blockNumber', []).then((h) => BigInt(h)));
    if (tip > state.lastProcessedBlock) {
      const start = state.lastProcessedBlock + 1;
      const end = Math.min(tip, start + 1999);
      const r = await processRange(start, end);
      console.log(`[collector] blocks ${start}..${end}: txs ${r.txs}, new events ${r.newEvents} (tip ${tip})`);
    } else if (once) {
      console.log('[collector] no new blocks');
    }
    // Cosmos pass over the same heights (cosmos height == EVM block number).
    try {
      if (state.lastProcessedCosmosBlock == null) {
        await importCosmosHistory();
        state.lastProcessedCosmosBlock = tip;
      } else if (tip > state.lastProcessedCosmosBlock) {
        await processCosmosRange(state.lastProcessedCosmosBlock + 1, tip);
        state.lastProcessedCosmosBlock = tip;
      }
      state.totalEventsFound = allEvents.length;
      saveState();
    } catch (e) {
      // A Cosmos RPC outage must not kill the EVM loop; the cosmos checkpoint
      // simply stays behind and the next pass catches up.
      console.error('[cosmos] pass failed (will retry next pass):', e.message);
    }
    writeFeed(tip);
    if (once) break;
    await sleep(pollMs);
  } while (true);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('[collector] FATAL', e); process.exit(1); });
