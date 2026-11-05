#!/usr/bin/env node
// Decoder unit check against KNOWN historical flows from
// ~/workspace/42-flowmap/flows.jsonl (finalized, independently verified data).
//
// For each fixture we fetch the REAL tx + receipt from the live RPC, run them
// through collector.mjs's decode+classify, and compare classification and raw
// amounts with the expected values taken from flows.jsonl:
//
//  Fixture 1 (swap): block 2267395, tx 0xe7bc8184…
//    flows.jsonl: Metal Raptor (validator) swap in pair 0xfac6a978… (USDT/42):
//    in  USDT 93440759000000000000 (93.440759)
//    out [42] 839106471668449024760 (839.106…)
//    => expected: one swap event, actor = Metal Raptor, sold USDT / bought 42.
//    Our 買い/売り rule: USDT -> [42] is "swap-buy" (買い of [42]).
//
//  Fixture 2 (transfer): block 1743641, tx 0x1b3f4e0e…
//    flows.jsonl: ERC-20 transfer of DONT (whitelist symbol PANIC) token
//    0xfaa842c8… from 0x79b7bf24… to panda42 (validator)
//    0xc032b9c0…, amount 5000000000000000000000000 (5,000,000).
//    => expected: one transfer event, actor = panda42, direction "in".
//
// Usage: node test-decoder.mjs   (exit code 0 = all pass)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTx, makeCtx } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker-test';

async function rpc(method, params) {
  let err;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.result) return j.result;
      err = new Error(JSON.stringify(j.error ?? j));
    } catch (e) { err = e; }
  }
  throw err;
}

const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const ctx = makeCtx(watchlist, registries, {});

const FIXTURES = [
  {
    name: 'swap (Metal Raptor, USDT -> 42)',
    hash: '0xe7bc8184a7bf3e06d0a0e1e71f836bd52eccfa6e0edbe2e44963e4ff698dde10',
    block: 2267395, ts: 1782797602,
    check(evs) {
      const ev = evs.find((e) => e.type === 'swap-buy' || e.type === 'swap-sell');
      if (!ev) return `no swap event (got: ${evs.map((e) => e.type).join(',') || 'none'})`;
      if (ev.actor !== '0x1077c77b5e56cea994e3f385e50f9ff4fa2e3514') return `actor mismatch: ${ev.actor}`;
      if (ev.actorTier !== 'validator') return `tier mismatch: ${ev.actorTier}`;
      if (ev.type !== 'swap-buy') return `type mismatch (rule USDT->[42]=買い): ${ev.type}`;
      if (ev.sold.token !== '0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753' || ev.sold.amountRaw !== '93440759000000000000') return `sold mismatch: ${JSON.stringify(ev.sold)}`;
      if (ev.bought.token !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || ev.bought.amountRaw !== '839106471668449024760') return `bought mismatch: ${JSON.stringify(ev.bought)}`;
      const expectPrice = 93.440759 / 839.106471668449;
      if (Math.abs(ev.price - expectPrice) > 1e-6) return `price mismatch: ${ev.price} vs ${expectPrice}`;
      return null;
    },
  },
  {
    name: 'transfer (panda42 receives 5,000,000 DONT/PANIC)',
    hash: '0x1b3f4e0ef595c18c0539df2b88cc619f98fd8752a95e3aa2cfbd2c10053bca3b',
    block: 1743641, ts: 1779857704,
    check(evs) {
      const ev = evs.find((e) => e.type === 'transfer');
      if (!ev) return `no transfer event (got: ${evs.map((e) => e.type).join(',') || 'none'})`;
      if (ev.actor !== '0xc032b9c05386a81b0221a575db9cf666ebc30547') return `actor mismatch: ${ev.actor}`;
      if (ev.direction !== 'in') return `direction mismatch: ${ev.direction}`;
      if (ev.amount.token !== '0xfaa842c8871f7f99c183f77871f79ce07dd056cd' || ev.amount.amountRaw !== '5000000000000000000000000') return `amount mismatch: ${JSON.stringify(ev.amount)}`;
      if (ev.amount.symbol !== 'PANIC') return `symbol mismatch (whitelist name): ${ev.amount.symbol}`;
      return null;
    },
  },
];

let failed = 0;
for (const f of FIXTURES) {
  const [tx, receipt] = [await rpc('eth_getTransactionByHash', [f.hash]), await rpc('eth_getTransactionReceipt', [f.hash])];
  if (!tx || !receipt) { console.log(`FAIL ${f.name}: RPC returned no tx/receipt`); failed++; continue; }
  const evs = classifyTx(ctx, tx, receipt, f.ts, f.block);
  const problem = f.check(evs);
  if (problem) { console.log(`FAIL ${f.name}: ${problem}`); failed++; }
  else console.log(`PASS ${f.name}: ${evs.map((e) => `${e.type} | ${e.summary}`).join(' ; ')}`);
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FIXTURE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
