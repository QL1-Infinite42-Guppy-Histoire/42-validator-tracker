#!/usr/bin/env node
// WS4 / WS4b / WS5 verification (v0.2.0):
//  1) REAL Guide settle tx (test-fixtures/guide-settle.json, fetched from the
//     live RPC: tx 0x9b4c04d7…, block 4241815, input selector 0x39c2ebb9 =
//     settle(uint256,bytes)): its receipt's 4-topic Transfer log is a Guide
//     mint of tokenId 4015 to 0xaf67478a…. The decoder must put it in
//     nftTransfers (NOT in ERC-20 transfers), and classifyTx — with the
//     recipient added as a watched fixture entry — must yield exactly one
//     nft-mint event "Guide #4015".
//  2) Synthetic method-call classifications (watched sender = panda42):
//     approve -> 使用許可（approve）, FISH self-claim 0x5c74910f ->
//     reward-claim-fish, distributor batch 0x0fb39e45 (sender = the FISH
//     distributor 0xbfc5…4f29) -> reward-distribution-fish, FISH burn
//     0x87157886 -> token-burn, unknown 0x98869d1f -> unclassified with the
//     selector + destination in the summary, Guide settle by a watched
//     sender with NO mint log -> fluke-settle, Starlight claim ->
//     reward-claim-starlight.
//  3) WS5 bridge-out: an ERC-20 transfer OUT from a validator to the USDT
//     BridgeRouter (0x8667682b…) becomes type bridge-out with the
//     'bridge-out' notable marker; the INBOUND direction (router ->
//     validator) stays a plain transfer with no marker.
// Run: node test-ws4.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTx, decodeReceiptLogs, enrichEvent, makeCtx } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

// ---- 1) real Guide settle fixture ----
const fixture = JSON.parse(readFileSync(join(__dir, 'test-fixtures/guide-settle.json'), 'utf8'));
const dec = decodeReceiptLogs(fixture.receipt);
check('settle receipt: ERC-721 mint decoded as nftTransfer', dec.nftTransfers.length === 1 && dec.nftTransfers[0].tokenId === '4015' && dec.nftTransfers[0].from === '0x0000000000000000000000000000000000000000', JSON.stringify(dec.nftTransfers));
check('settle receipt: mint NOT misread as ERC-20 transfer', dec.transfers.length === 0, `transfers=${dec.transfers.length}`);
const wl2 = structuredClone(watchlist);
wl2.entries.push({ address: '0xaf67478ab949ce0ac9c4c21156133c679bd6200c', tier: 'related', label: null, isCore: false, isPair: false, watch: true, validators: [], relatedValidators: ['panda42'] });
const ctx2 = makeCtx(wl2, registries, {});
const ts = parseInt(fixture.mintLog.blockTimestamp, 16);
const evs = classifyTx(ctx2, fixture.tx, fixture.receipt, ts, parseInt(fixture.tx.blockNumber, 16));
const mint = evs.find((e) => e.type === 'nft-mint');
check('settle classify: exactly one nft-mint event', evs.length === 1 && !!mint, evs.map((e) => e.type).join(','));
check('settle classify: summary names Guide #4015', !!mint && mint.summary.includes('Guide #4015'), mint?.summary);
check('settle classify: nft fields carry collection + tokenId', !!mint && mint.nft?.collection === '0xf349e469c474048ded6f9b914309e76880ed1bbd' && mint.nft?.tokenId === '4015');

// ---- 2) synthetic method calls ----
const ctx = makeCtx(watchlist, registries, {});
const PANDA = '0xc032b9c05386a81b0221a575db9cf666ebc30547';
const KEEPER = '0xbfc5dd3a9434bed286853f03b353eacde6d84f29';
const emptyReceipt = { status: '0x1', logs: [] };
const mkTx = (from, to, input) => ({ hash: '0x' + 'ab'.repeat(32), from, to, value: '0x0', input, blockNumber: 4272000 });
const one = (from, to, input) => classifyTx(ctx, mkTx(from, to, input), emptyReceipt, 1762000000, 4272000);

let ev = one(PANDA, '0x2c32120a12b754272d9e85c57f64b50ca2c43513', '0x095ea7b3' + '000000000000000000000000bf07dfe35746894bae373f63f4bf2379f9bafec0' + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')[0];
check('approve -> approve type + label', ev?.type === 'approve' && ev.actionLabel === '使用許可（approve）', ev?.summary);
check('approve summary names token + spender label', !!ev && ev.summary.includes('FISH') && ev.summary.includes('DEXルーター'), ev?.summary);

ev = one(PANDA, '0x4a1b11e7acf1d99cf8cee3b1f3cae9218d9cd04e', '0x5c74910f' + '00'.repeat(32))[0];
check('FISH self-claim -> reward-claim-fish', ev?.type === 'reward-claim-fish' && ev.actionLabel === '報酬請求（FISH配布）', ev?.summary);

ev = one(KEEPER, '0x4a1b11e7acf1d99cf8cee3b1f3cae9218d9cd04e', '0x0fb39e45' + '00'.repeat(32))[0];
check('FISH batch -> reward-distribution-fish', ev?.type === 'reward-distribution-fish', ev?.summary);

ev = one(KEEPER, '0x2c32120a12b754272d9e85c57f64b50ca2c43513', '0x87157886' + '00'.repeat(32))[0];
check('FISH burn fn -> token-burn', ev?.type === 'token-burn', ev?.summary);

ev = one(PANDA, '0x9f19a936de2e628eb5b46e03a01f1269dff2b45a', '0x98869d1f' + '00'.repeat(32))[0];
check('unknown -> unclassified (not その他の操作)', ev?.type === 'unclassified' && ev.summary.includes('0x98869d1f') && ev.summary.includes('B45A') && !ev.summary.includes('その他の操作'), ev?.summary);

ev = one(PANDA, '0xf349e469c474048ded6f9b914309e76880ed1bbd', '0x39c2ebb9' + '00'.repeat(64))[0];
check('Guide settle (no mint log) -> fluke-settle', ev?.type === 'fluke-settle' && ev.actionLabel === 'Fluke確定（Guide新規発行）', ev?.summary);

ev = one(PANDA, '0xebc32e52a1aa52d8a0cd71402c4ffdf316f0db07', '0x6ba4c138' + '00'.repeat(32))[0];
check('Starlight claim -> reward-claim-starlight', ev?.type === 'reward-claim-starlight' && ev.actionLabel === 'Starlight報酬請求', ev?.summary);

ev = one(PANDA, '0x0000000000000000000000000000000000000801', '0x2efe8a5f' + '00'.repeat(64))[0];
check('0x0801 claimRewards -> reward-claim-staking', ev?.type === 'reward-claim-staking', ev?.summary);

ev = one(PANDA, '0x8667682b62caceda9e87b3caa21d5b09d9ae13c3', '0x81b4e8b4' + '00'.repeat(96))[0];
check('USDT BridgeRouter transferRemote -> bridge-out + marker', ev?.type === 'bridge-out' && (ev.notableReasons ?? []).includes('bridge-out'), ev?.summary);

// v0.2.3: bridge-out is USDT-only — other token routers and bare mailbox
// dispatches are plain bridge-send-other records with NO marker.
ev = one(PANDA, '0x049a78fe311cf1c23f09cdd4f12420ffc917c8db', '0x81b4e8b4' + '00'.repeat(96))[0];
check('QOM BridgeRouter transferRemote -> bridge-send-other, no marker', ev?.type === 'bridge-send-other' && !(ev.notableReasons ?? []).includes('bridge-out'), ev?.summary);

ev = one(PANDA, '0xac70cdd7f2b712aef7a20661e0c2e96e1da1d63e', '0xfa31de01' + '00'.repeat(96))[0];
check('mailbox dispatch -> bridge-send-other, no marker', ev?.type === 'bridge-send-other' && !(ev.notableReasons ?? []).includes('bridge-out'), ev?.summary);

// ---- 3) WS5 transfer-direction bridge detection ----
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const ROUTER_BRIDGE = '0x8667682b62caceda9e87b3caa21d5b09d9ae13c3';
const USDT = '0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753';
const transferReceipt = (from, to) => ({ status: '0x1', logs: [{ address: USDT, topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], data: '0x' + (1000n * 10n ** 18n).toString(16).padStart(64, '0'), logIndex: '0x0' }] });
let evs2 = classifyTx(ctx, mkTx(PANDA, USDT, '0xa9059cbb'), transferReceipt(PANDA, ROUTER_BRIDGE), 1762000000, 4272000);
check('USDT transfer OUT to bridge router -> bridge-out', evs2.length === 1 && evs2[0].type === 'bridge-out' && evs2[0].notableReasons.includes('bridge-out'), JSON.stringify(evs2.map((e) => e.type)));
evs2 = classifyTx(ctx, mkTx(ROUTER_BRIDGE, USDT, '0xa9059cbb'), transferReceipt(ROUTER_BRIDGE, PANDA), 1762000000, 4272000);
check('transfer IN from bridge router -> plain transfer, no marker', evs2.length === 1 && evs2[0].type === 'transfer' && !(evs2[0].notableReasons ?? []).includes('bridge-out'), JSON.stringify(evs2.map((e) => e.type)));

// v0.2.3 transfer path: non-USDT token to a bridge target is
// bridge-send-other; USDT to ANY bridge target is still bridge-out.
const FISH = '0x2c32120a12b754272d9e85c57f64b50ca2c43513';
const QOM_ROUTER = '0x049a78fe311cf1c23f09cdd4f12420ffc917c8db';
const tokenReceipt = (token, from, to) => ({ status: '0x1', logs: [{ address: token, topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], data: '0x' + (1000n * 10n ** 18n).toString(16).padStart(64, '0'), logIndex: '0x0' }] });
evs2 = classifyTx(ctx, mkTx(PANDA, FISH, '0xa9059cbb'), tokenReceipt(FISH, PANDA, ROUTER_BRIDGE), 1762000000, 4272000);
check('FISH transfer OUT to bridge router -> bridge-send-other, no marker', evs2.length === 1 && evs2[0].type === 'bridge-send-other' && !(evs2[0].notableReasons ?? []).includes('bridge-out'), JSON.stringify(evs2.map((e) => e.type)));
evs2 = classifyTx(ctx, mkTx(PANDA, USDT, '0xa9059cbb'), tokenReceipt(USDT, PANDA, QOM_ROUTER), 1762000000, 4272000);
check('USDT transfer OUT to QOM bridge router -> bridge-out (token decides)', evs2.length === 1 && evs2[0].type === 'bridge-out' && evs2[0].notableReasons.includes('bridge-out'), JSON.stringify(evs2.map((e) => e.type)));

// ---- 4) v0.2.4: buys-only snipes ----
const X_ADDR = '0xdb34ff92995c74d170755a563a1a2c35a3db4738';
const X_REL = '0xa8d5d10095d0d94b758e2d74c00107cfca311fd3'; // confirmed X-related wallet (listing-day buyer)
const XENIA = '0x63cdac6ee8746b47de9cd259ddadab8918f0f341';
const FARMER = '0x46c7ca2e2ef5304cbf9baf5ae2a2ede7dcd5de41';
const NATIVE42 = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const DONT = '0xfaa842c8871f7f99c183f77871f79ce07dd056cd';

const PAIR = '0x46cce7b6b48e1627d7e3f69a68f425cba833dcc3'; // FISH/42 pair
const creations = { [PAIR]: { createdTs: 1762000000 - 600 } };
const mkEv = (type, extra = {}) => ({ chain: 'evm', actor: PANDA, actorTier: 'validator', type, pair: PAIR, ts: 1762000000, tokens: [], validatorNames: [], ...extra });
const evBuy = mkEv('swap-buy'); enrichEvent(evBuy, ctx, creations);
check('snipe: buy 10 min after pair creation -> isSnipe true', evBuy.isSnipe === true);
const evLp = mkEv('lp-add'); enrichEvent(evLp, ctx, creations);
check('snipe: LP add 10 min after pair creation -> isSnipe false (buys only)', evLp.isSnipe === false);
const evLpOld = mkEv('lp-add', { isSnipe: true }); enrichEvent(evLpOld, ctx, creations);
check('snipe: stored LP add with legacy flag -> flag removed, event kept', evLpOld.isSnipe === false && evLpOld.type === 'lp-add');

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
