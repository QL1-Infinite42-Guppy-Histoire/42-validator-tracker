#!/usr/bin/env node
// Cosmos decoding checks (v0.2.0):
//  1) bech32 encode/decode roundtrip for a known address (panda42).
//  2) A live MsgSend tx (height 4205008, hash E7215843…) decoded from its raw
//     protobuf bytes must match the tx's own `transfer` event WITH msg_index
//     (the fee-leg-excluded ground truth from the verified research recipe):
//     from infinite1s4wlsn… / to infinite1dp0yh37… / 900000000000000000000drop.
// Requires network (CometBFT RPC). Run: node test-cosmos.mjs
import { bech32ToHex, decodeCosmosMessages, hexToBech32, parseProto } from './collector.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++; };

const panda = '0xc032b9c05386a81b0221a575db9cf666ebc30547';
const b32 = hexToBech32(panda);
console.log('panda42 bech32:', b32);
check('bech32 roundtrip', bech32ToHex(b32) === panda && b32.startsWith('infinite1'));

const r = await fetch('https://comet-rpc.infinitepanda.xyz', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx_search', params: { query: "message.action='/cosmos.bank.v1beta1.MsgSend' AND tx.height=4205008", per_page: '5', page: '1' } }),
});
const j = await r.json();
const t = j.result.txs[0];
check('sample tx found', !!t && t.hash.startsWith('E7215843'));
const msgs = decodeCosmosMessages(t.tx);
check('one MsgSend message', msgs.length === 1 && msgs[0].typeUrl === '/cosmos.bank.v1beta1.MsgSend');
const f = parseProto(msgs[0].value);
const strs = (ff, n) => ff.filter((x) => x.field === n && x.wire === 2).map((x) => x.value.toString('utf8'));
const coinField = f.find((x) => x.field === 3 && x.wire === 2);
const cf = parseProto(coinField.value);
const decoded = { from: strs(f, 1)[0], to: strs(f, 2)[0], denom: strs(cf, 1)[0], amount: strs(cf, 2)[0] };
console.log('decoded:', decoded);
const leg = (t.tx_result.events || []).find((e) => e.type === 'transfer' && e.attributes.some((a) => a.key === 'msg_index'));
const attr = (k) => leg.attributes.find((a) => a.key === k)?.value;
check('from matches msg_index leg', decoded.from === attr('sender'));
check('to matches msg_index leg', decoded.to === attr('recipient'));
check('amount+denom matches msg_index leg', decoded.amount + decoded.denom === attr('amount'));
process.exit(fails ? 1 : 0);
