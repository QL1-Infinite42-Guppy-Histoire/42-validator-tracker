#!/usr/bin/env node
// Contract audit (v0.4.1): eth_getCode for every non-validator watchlist
// entry (related + estimated tiers), cross-referenced against the verified
// known-address sets (collector constants, registries, KNOWN_CONTRACTS).
//
// Trigger: 0xf2ecb173…f015 had been carried as a Metal Raptor related
// WALLET (depth 1) and the closure expansion traversed THROUGH it, pulling
// in its many users (incl. 0xa33e223b…3a23) as depth-2 "related wallets".
// The address is in fact a bridge-type CONTRACT (user-verified bytecode:
// references the USDT token, carries a "1.1.0" version string, Hyperlane
// warp style) — a piece of infrastructure, not a person. Protocol
// contracts are not person wallets and must never be closure transit.
//
// Decisions written to contract-audit.json:
//   eoa           — no bytecode; a wallet. No change.
//   stay-related  — contract, but a verified PERSON-side holding contract
//                   (collector KNOWN_CONTRACTS, from the validator
//                   dossiers — e.g. the shared LP-holding contract
//                   0x71b13838…30E0). Stays related, stays a transit node.
//   core-flagged  — contract already flagged isCore (pairs / routers
//                   carried as labelled related entries). Already not an
//                   actor and never traversed; no change.
//   core          — protocol contract not currently core-flagged:
//                   repair-closure.mjs reclassifies it to the core tier.
//   review        — contract with no verified classification either way;
//                   decided manually below (REVIEW_DECISIONS) with the
//                   evidence recorded, never guessed silently.
// Run: node audit-contracts.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_SEND_TARGETS, DEST_LABELS, KNOWN_CONTRACTS, KNOWN_SYSTEM_CONTRACTS, buildExcludedSet } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const lc = (a) => (a ? String(a).toLowerCase() : a);
const RPC_HOSTS = ['https://evm-rpc.infinitepanda.xyz', 'https://evm-rpc-infinite.mschihuahua.org'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.3';

const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const excluded = buildExcludedSet(watchlist, registries);

// Manual decisions for the two cases already established by evidence.
// (The 'review' bucket, if any, gets its decisions appended here with the
// evidence in the reason string before the audit result is applied.)
const OVERRIDES = {
  '0xf2ecb173b63699c49ace3faae80af5ce677af015': {
    decision: 'core', label: 'ブリッジ系コントラクト',
    reason: 'ユーザー確認（2026-11-05）：バイトコードあり。コード内に版数文字列 "1.1.0" と USDT トークン（0xc2684966…）への参照を持つブリッジ系（Hyperlane warp 系）コントラクト。個人のウォレットではない',
  },
};
const CORE_BY_NAME = (label, name) => ({
  decision: 'core', label,
  reason: `Blockscout のコントラクト名「${name}」で同定したプロトコル／アプリ系コントラクト。個人のウォレットではない`,
});
const KEEP = (reason) => ({ decision: 'keep', reason });
const REVIEW_DECISIONS = {
  // ---- identified protocol / app contracts (Blockscout contract names) ----
  '0x388f7d825f745c673c71d695c125ce9a51f18b35': CORE_BY_NAME('PaymentMasterRouterV4', 'PaymentMasterRouterV4'),
  '0x551845e9186669b690966616d903eff85a90508e': CORE_BY_NAME('FaucetDistributor', 'FaucetDistributor'),
  '0x985f6ecb68f308ea4c3b5fc9c5b187f4ee1dfa23': CORE_BY_NAME('DepositPool', 'DepositPool（ERC1967Proxy）'),
  '0x9c2911d9ec8bf8fd4de37747228eee670c4ee492': CORE_BY_NAME('FoxxStaking', 'FoxxStaking'),
  '0x263d005f47aaffb212e3591c8d2cdced81d7db3a': CORE_BY_NAME('FoxxStaking', 'FoxxStaking'),
  '0x5981f34acdde6f60607be174791bb657dc31d9be': CORE_BY_NAME('FoxxStakingVault', 'FoxxStakingVault'),
  '0xc6dbc941beb3a962fe81bd5724ac17ad3c0419ab': CORE_BY_NAME('FoxxStakingVault', 'FoxxStakingVault'),
  '0x916fb1a761d0db8888c3f79d6c614c9fff73b657': CORE_BY_NAME('ブリッジルーター', 'BridgeRouter'),
  '0x59d6e50f5b0559a088e3eaac21e520be18453704': CORE_BY_NAME('ブリッジルーター', 'BridgeRouter'),
  '0x635d333954e598f4e396153e8e0c1086bd35bd4a': CORE_BY_NAME('ブリッジルーター', 'BridgeRouter'),
  '0xeed5b2bcff223f8e4d43eecf6b55ac69a6f26a70': CORE_BY_NAME('First Ground', 'First Ground'),
  '0x5a3c9b142cbfd0ca9130fba515e0a3cabe1e0b7e': CORE_BY_NAME('First Ground', 'First Ground'),
  '0x24d0abb2a08037fef3da0da85d23ed35c1b1b980': CORE_BY_NAME('LiquidityLocker（流動性ロッカー）', 'LiquidityLocker'),
  '0x01d814a76a11a3c2ebb701de90e5c9a4317929be': CORE_BY_NAME('GoldenFoxCrown（NFT）', 'GoldenFoxCrown'),
  '0x0d1e66935c10fe61fa410b0cde3f50582b031b3f': CORE_BY_NAME('FoxxOnePaymentRouterV1', 'FoxxOnePaymentRouterV1'),
  '0xbf9c8301c1b32374b8a76554e8d2abccd89367ac': CORE_BY_NAME('FoxxOneFeaturedRegistry', 'FoxxOneFeaturedRegistry'),
  '0xf9d4d773802abd6e825a6249618b0450ea6b8107': CORE_BY_NAME('ValidatorAnnounce', 'ValidatorAnnounce'),
  '0x9adfc495b653df7191841d2086950686c97d8536': CORE_BY_NAME('FeeForwarder', 'FeeForwarder'),
  // identical bytecode (1,505 B) to FoxxOnePaymentRouterV1 = same contract code, another instance
  '0xc46b052a170ca8d108ee740cbe1d2058eef0d8aa': {
    decision: 'core', label: 'FoxxOnePaymentRouterV1',
    reason: 'FoxxOnePaymentRouterV1 とバイトコードが完全一致（1,505 B）＝同一コードの別インスタンス。決済ルーターはプロトコル系',
  },
  // ---- NFT token contracts: one identical 133-byte bytecode group; named
  // members are NFT collections, so the whole group is token contracts ----
  ...Object.fromEntries([
    ['0x70931d2902790c0e7aab80727255df877fb31dbe', '42 Improbabilities'],
    ['0x734b2dacf82abf9290af398cedb2f379cfc556cf', "Guppy's Prayer"],
    ['0xdf16ef67bfae88d06995f6de3e7ae2cb67a9d892', "Guppy's Prayer"],
    ['0xca2fe87f4902001279e4d4b2a557ad6ee626be56', 'Guppys Prayer'],
    ['0x1b414531d825b9caa201142c0e5d4fc3b4b6d8bc', 'Guppys Moonlit Dream'],
    ['0x97a04cbfcc480c0f4631c1c86018c51eb1337584', 'InfiniteDrivePunkz'],
    ['0x8c111d68671a38415c1efb46cf65cca32c8a7e6c', 'Infinite Gyudon Knights'],
    ['0xdac40f0a3c21805679685c7712f1268688317e39', 'Thirteen Roses'],
    ['0x5d97e27f087fbea25c61767df2beb9d5485ac1fe', 'I AM LUCKY!'],
    ['0x7d2593dae4c8db8c0924ccd6212ce0a01d02b39c', 'IID Punks'],
    ['0x5896dbe9e9a1201d62f73c5c79e5d311b5fa14b3', 'The Thirteenth Hour'],
    ['0x3523c2b4ef58ccf50520dcecbaf27852fda5676c', null],
    ['0x2c818800cfd0bb9f00f98194d06b9338bd2b1964', null],
    ['0x8ce09d4e98d477ad732a0d524b91ceef9fc01436', null],
  ].map(([a, n]) => [a, {
    decision: 'core', label: n ? `${n}（NFT）` : 'NFTコントラクト',
    reason: n
      ? `Blockscout のコントラクト名「${n}」で同定した NFT トークンコントラクト（133 B の同一バイトコード群）。トークン本体は中核`
      : '133 B の同一バイトコード群の一員で、同群の同定済みメンバーはすべて NFT コレクション。トークン本体と判断し中核へ',
  }])),
  // ---- kept: no verified protocol identity; person-side / unidentified ----
  '0x95feabdecca6cbc808d231895b80703905be3b83': KEEP('名称未検証の大型コントラクトだが、既知プロトコル群との照合一致なし。唯一の展開側の子は LiquidityLocker（別途同定され中核化）であり、それを除けば大量ファネル型の通過点ではないため、証拠不足のまま関連に維持'),
  '0x08354d56d3b054381cc94e5d1f33afd032f1c480': KEEP('名称未検証・活動は送金1件のみで、プロトコル系の証拠なし。展開の通過点でもない（子0件）ため関連に維持'),
  '0x9f19a936de2e628eb5b46e03a01f1269dff2b45a': KEEP('LP保有コントラクトと同サイズ（1,167 B）の保有型とみられるコントラクト。単一バリデーター圏のみ・子0件。プロトコル系の証拠がないため関連に維持'),
  '0x051bbfce088bc150727169d3b21dbaeacfaf133a': KEEP('単一運営者（0x769a8f96…）のデプロイしたコントラクト群の一員。公共プロトコルの証拠がなく、関連に維持'),
  '0xf08d8c956d929a1d1166bbe5aeb7a5a70d47dc01': KEEP('単一運営者（0x769a8f96…）のデプロイした売買実行コントラクト。プロトコル系ではなく個人側の自動売買とみて関連に維持'),
  '0xed697927cf6f7b5200eeb530588dd5700d3100cc': KEEP('単一運営者（0x769a8f96…）のデプロイしたコントラクト。公共プロトコルの証拠がなく、関連に維持'),
  '0xe5c35f94dd36a96e955da58fe4048b1e073e5221': KEEP('運営者 0x2fcfc230… がデプロイした同一バイトコード（2,023 B）の小規模コントラクトの一方。公共プロトコルの証拠がなく、子もないため関連に維持'),
  '0xafad9d2074cacb83bc42ee07f9d1e85af84de32a': KEEP('運営者 0x2fcfc230… がデプロイした同一バイトコード（2,023 B）の小規模コントラクトの一方。公共プロトコルの証拠がなく、子もないため関連に維持'),
  '0xd5b83c0086466781dc7c9079a889009c97ce9057': KEEP('運営者 0x2fcfc230… のデプロイしたコントラクト。公共プロトコルの証拠がないため関連に維持'),
  '0x0b2a031c27620660f0ac0f1507b59ab774e0b6d5': KEEP('運営者 0x2fcfc230… のデプロイしたコントラクト。活動実績がほぼなく、プロトコル系の証拠もないため関連に維持'),
  '0xfa69cb9a144052096f24d35bfa80b0b58dd174cf': KEEP('名称未検証のコントラクト。相手方イベント14件のみ・子0件で通過点ではなく、プロトコル系の証拠もないため関連に維持'),
  '0x98fd9e32eaf45e0adf7f5c8bd7714f24a5dc0e88': KEEP('推定区分の共通相手先コントラクト。プロトコル系と同定できる証拠がないため、推定区分のまま維持（確定関連にも中核にもしない）'),
  '0xfcebe4797ed94bac6d09503f04fa13d997675553': KEEP('推定区分の売買実行コントラクト（スワップ約2,800件）。DEX 等のプロトコル本体ではなく個人側の自動売買とみて、推定区分のまま維持'),
};

async function rpcBatch(calls) {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params })));
  let lastErr;
  for (const host of RPC_HOSTS) {
    try {
      const r = await fetch(host, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const out = new Array(calls.length);
      for (const item of j) out[item.id] = item.result ?? null;
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const targets = watchlist.entries.filter((e) => e.tier === 'related' || e.tier === 'estimated');
console.log(`audit targets: ${targets.length} (related + estimated)`);
const codes = new Map();
const BATCH = 40;
for (let i = 0; i < targets.length; i += BATCH) {
  const chunk = targets.slice(i, i + BATCH);
  const res = await rpcBatch(chunk.map((e) => ({ method: 'eth_getCode', params: [e.address, 'latest'] })));
  chunk.forEach((e, j) => codes.set(e.address, res[j] ?? '0x'));
  console.log(`  getCode ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
}
const [tip] = await rpcBatch([{ method: 'eth_blockNumber', params: [] }]);

const results = {};
const counts = {};
for (const e of targets) {
  const code = codes.get(e.address) ?? '0x';
  const isContract = !!code && code !== '0x';
  const rec = { tier: e.tier, isCore: !!e.isCore, codeBytes: isContract ? (code.length - 2) / 2 : 0, isContract };
  if (!isContract) rec.decision = 'eoa';
  else if (OVERRIDES[e.address]) { rec.decision = OVERRIDES[e.address].decision; rec.label = OVERRIDES[e.address].label; rec.reason = OVERRIDES[e.address].reason; }
  else if (KNOWN_CONTRACTS[e.address]) { rec.decision = 'stay-related'; rec.reason = `調査で確認済みの個人側保有コントラクト：${KNOWN_CONTRACTS[e.address]}`; }
  else if (e.isCore) { rec.decision = 'core-flagged'; rec.reason = '既に中核フラグ付き（ペア／ルーター等のラベル付きエントリ）。アクターにも展開の経由にも使われていない'; }
  else if (KNOWN_SYSTEM_CONTRACTS.has(e.address) || BRIDGE_SEND_TARGETS.has(e.address)) { rec.decision = 'core'; rec.reason = 'collector の検証済み仕組み系アドレス群（KNOWN_SYSTEM_CONTRACTS / BRIDGE_SEND_TARGETS）に一致'; }
  else if (DEST_LABELS[e.address]) { rec.decision = 'core'; rec.label = DEST_LABELS[e.address]; rec.reason = `検証済みの宛先ラベル「${DEST_LABELS[e.address]}」を持つプロトコルコントラクト`; }
  else if ((registries.pairs ?? {})[e.address]) { rec.decision = 'core'; rec.reason = 'ペアレジストリに登録されたペアコントラクト'; }
  else if ((registries.tokens ?? {})[e.address]) { rec.decision = 'core'; rec.label = registries.tokens[e.address].symbol; rec.reason = 'トークンレジストリに登録されたトークン本体'; }
  else if (REVIEW_DECISIONS[e.address]) {
    const rd = REVIEW_DECISIONS[e.address];
    rec.decision = rd.decision === 'keep' ? (e.tier === 'estimated' ? 'stay-estimated' : 'stay-related') : rd.decision;
    rec.label = rd.label; rec.reason = rd.reason;
  }
  else { rec.decision = 'review'; rec.reason = '既知のプロトコル／個人いずれの照合にも一致しないコントラクト。要手動判定'; }
  // extra evidence for the trigger address: USDT reference inside the code
  if (e.address === '0xf2ecb173b63699c49ace3faae80af5ce677af015') {
    rec.codeRefsUsdt = code.includes('c2684966e5c95b2bc636fb4a1f3da9ad23d94753');
    rec.codeHasVersion110 = code.includes('312e312e30'); // ASCII "1.1.0"
  }
  results[e.address] = rec;
  counts[rec.decision] = (counts[rec.decision] ?? 0) + 1;
}
const out = { generatedAt: new Date().toISOString(), version: 'v0.4.1', rpcTip: parseInt(tip, 16), targets: targets.length, counts, results };
writeFileSync(join(__dir, 'contract-audit.json'), JSON.stringify(out, null, 1));
console.log('decisions:', JSON.stringify(counts));
for (const [a, r] of Object.entries(results)) if (r.decision === 'core' || r.decision === 'review') console.log(` ${r.decision.toUpperCase()} ${a} (${r.codeBytes} bytes) — ${r.reason}`);
