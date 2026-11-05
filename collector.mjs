#!/usr/bin/env node
// 42 Validator Tracker — collector (v0.4.2: EOA-only person graph —
// live auto-add is bytecode-gated (contracts route to the core
// registry, never to related); permanently excluded addresses are read
// from env EXCLUDED_ACTORS only and are purged/never re-added; the
// bridge-out totals chart is pre-aggregated per validator in
// feed.stats.bridge (all validators, unlimited depth, shared wallets
// counted into each connected validator's bar);
// v0.4.1: actorDepth on every event — the bridge-out totals chart
// splits each name's bar into depth segments (validator itself /
// depth-1 related / depth>=2 related);
// v0.4.0: six new sections — pair-created
// events from the Don't Panic factory, LP feed pinning, collector-computed
// staking stats, dormant-return flags (60d), new-counterparty flags with
// LIVE auto-add to the watchlist, and a 42/USDT price in feed.status;
// v0.3.2: Xenia reclassified from core to ordinary validator per user
// correction; v0.3.0: EVM side + Cosmos side, estimated tier +
// validator-list auto-refresh; v0.2.4: USDT-only bridge-out section,
// buys-only snipes, insider flag for X).
//
// Polls the 42 Chain EVM RPC for new blocks, decodes receipts with NO external
// dependencies (topic hashes are the standard ERC-20 / Uniswap V2 ones,
// verified against ethers.id() during development), classifies events that
// involve watched addresses (validators + their CONFIRMED direct related
// addresses from watchlist.json), appends them to events.jsonl and regenerates
// feed.json (latest 500 events + all snipe/bridge-out events, see
// selectFeedEvents) for the static frontend.
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
//  - WS4 concrete action classification: method calls that used to fall
//    into a bare "other-contract" bucket are classified by an explicit
//    (destination contract, selector) table built ONLY from verified ABIs
//    (GuppyWallet zaphod.ts / protocol.ts / research abi-*.json, standard
//    ERC-20/721 + Uniswap V2 signatures, and the 2026-11-01 FISH-reward
//    research). Unknown calls stay honest as "unclassified" with the
//    method selector + destination shown — names are never invented.
//    ERC-721 Transfer logs (4 topics) are decoded separately (they were
//    never misread as ERC-20: the ERC-20 branch requires exactly 3 topics),
//    and a mint (from 0x0) becomes an "nft-mint" event with tokenId.
//  - WS4b reward claims: Cosmos MsgWithdrawDelegatorReward is labelled
//    報酬請求（委任報酬）, MsgWithdrawValidatorCommission is
//    バリデーター報酬請求（コミッション）; on the EVM side the distribution
//    precompile (0x0801) claimRewards selector, the FISH reward contract
//    (0x4a1b11e7…, identified in the 2026-11-01 X liquidity-rewards
//    research) and Starlight claim() get reward-claim types. No address is
//    hard-coded as a reward contract without a research source.
//  - WS5 bridge-out (user-corrected direction): a watched wallet sending
//    funds OUT of 42 Chain via a known bridge contract is type "bridge-out"
//    with notableReasons marker 'bridge-out' and glows green in its own
//    section. INBOUND receipts are NOT special-cased: they stay plain
//    transfers.
//  - v0.2.3: bridge-out is USDT-ONLY (user rule). Only a movement of the
//    USDT token (transfer of USDT to a bridge target, or transferRemote on
//    the USDT BridgeRouter) is "bridge-out"; bridge sends of any other
//    token are recorded as plain "bridge-send-other" moves.
//  - v0.2.4: snipes are BUYS ONLY (user rule) — LP adds no longer count.
//    Plus the ⚠ Insider flag (isInsider): validator X itself or an
//    X-related wallet moving [42] or DONT (whitelist PANIC contract);
//    insider events are pinned into the feed like snipes/bridge-outs.
//  - v0.3.0 (Phase 3): ESTIMATED addresses. A third watch tier built from
//    the 2026-10-31 flow-map research (build-estimates.mjs): through-pool
//    matches (relaxed FIFO, 24h / 10%), 2-hop paths over confirmed legs,
//    and shared counterparties of >= 2 validators that are not already
//    watched. Estimated actors are watched live on BOTH sides like the
//    other tiers, but their events are tagged actorTier "estimated" with a
//    concrete estimateBasis, are NEVER flagged snipe / insider / bridge-out
//    (enrichEvent strips those), are NOT pinned into the feed, and appear
//    ONLY in the main feed with 推定 styling — the special sections and
//    the USDT totals stay confirmed-only by construction AND by explicit
//    frontend filters. Also: the validator list now auto-refreshes from
//    the chain on every run (refreshValidatorList): new bonded validators
//    are added as self-tier entries with their on-chain moniker (never an
//    invented name), departed ones are marked inactive but stay watched.
//  - v0.3.2 (user correction): Xenia is NOT core/system infrastructure.
//    The 2026-10-31 bubble-map ruling had put her in core category B
//    ("distributor-type") because she sent exactly 2 [42] to 18 validators;
//    the user overturned it — Xenia is an ordinary validator/person and her
//    seed distribution is her own activity. Her watchlist entry is now
//    isCore=false, build-watchlist strips core flags from validator-tier
//    entries, and enrichEvent re-derives actorIsCore/counterpartyIsCore
//    from the current watchlist so stored events are repaired too. The #1
//    holder 0x7a6f...0a25 keeps its core flag (Xenia only was corrected).
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
//   node collector.mjs --pairs-sync    # v0.4.0: pair-created events only
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
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 42-validator-tracker/0.3';
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
export const SNIPE_RULE = 'スナイプの定義：ペアが作られてから3時間以内に、バリデーター本人または直接関連ウォレットが、そのペアで買った（買い）動き。LP追加はスナイプに含みません';

// Known contracts among watched addresses, from the 2026-10-31 validator
// research (~/workspace/42-flowmap validator dossiers): 0x71b13838…30E0 is a
// CONTRACT holding 90%+ of the LP shares of several FISH pairs and is a shared
// counterparty of 8 validators — a shared service/LP contract, not a person.
// Only addresses verified in research are listed here; do not add guesses.
// (v0.4.2: under the EOA-only rule this address sits in the CORE tier like
// every other contract; the constant remains as its verified identity label
// and for the dormant-return eligibility exclusion.)
export const KNOWN_CONTRACTS = {
  '0x71b138382598fbc4b890d2d20a14f9dedb1430e0': 'コントラクト（複数のFISHペアのLPシェアを保有する共有コントラクト）',
};

// ---------------- WS4/WS4b/WS5: known contracts & action table ----------------
// Every address below is copied from a verified source (file:symbol noted).
// Nothing here is guessed from an address's appearance.
export const GUIDE_ADDR = '0xf349e469c474048ded6f9b914309e76880ed1bbd'; // chains.ts INFINITE_NFTS.theGuide (also watchlist 'Guide/Fluke')
export const ZG13_ADDR = '0x8f0c0b0da44f945f5c32f358292616da3a07fc9d'; // chains.ts INFINITE_NFTS.zg13
export const STARLIGHT_ADDR = '0xebc32e52a1aa52d8a0cd71402c4ffdf316f0db07'; // chains.ts INFINITE_CONTRACTS.starlightLedger
export const ST42_LIVE_ADDR = '0x78f40e828a92af9e137ff7660e52ac8b0f1d121e'; // protocol.ts ST42_ADDRESS (live vault+token)
export const ST42_VAULT_ADDR = '0x0f93a9b0dbf2d1829928fe40cbc155e0b5b2d35e'; // chains.ts INFINITE_CONTRACTS.st42Vault (dormant, same ABI)
export const ST42_BOOK_ADDR = '0x458f6b41d093bed5abbc1527dabdf5499a85294f'; // chains.ts INFINITE_CONTRACTS.st42Book
export const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000800'; // protocol.ts STAKING_PRECOMPILE
export const DISTRIBUTION_PRECOMPILE = '0x0000000000000000000000000000000000000801'; // protocol.ts DISTRIBUTION_PRECOMPILE
export const MAILBOX_ADDR = '0xac70cdd7f2b712aef7a20661e0c2e96e1da1d63e'; // chains.ts INFINITE_CONTRACTS.hyperlaneMailbox
export const W42_ADDR = '0x8980eb04bab4f5dfe9cc0768b5d6a8c0448a8f77'; // ZAPHOD_FRONTEND.md §3: wrapped native "Wrapped 42"/W42
export const FISH_REWARD_ADDR = '0x4a1b11e7acf1d99cf8cee3b1f3cae9218d9cd04e'; // 42-flowmap/x-liquidity-rewards.html: FISH報酬コントラクト
export const FISH_DISTRIBUTOR = '0xbfc5dd3a9434bed286853f03b353eacde6d84f29'; // same research: FISH報酬ディストリビューター（運営ウォレット）
export const FISH_TOKEN_ADDR = '0x2c32120a12b754272d9e85c57f64b50ca2c43513'; // registries.tokens FISH
export const NFT_MARKETPLACE_ADDR = '0x77e924e8c75083a723606b5634497d416ad16cb0'; // ZAPHOD_FRONTEND.md §3 (Infinite marketplace)

// Bridge contracts on the 42 Chain (Infinite) side, from chains.ts:
// INFINITE_CONTRACTS.bridgeRouter{Qom,Usdt,Usdc,Wbtc} (the Zaphod
// BridgeRouter wrappers) + every BRIDGE-table row's infiniteBridgeRouter
// and infiniteRouter (Hyperlane warp routers). The mailbox is bridge
// infrastructure too but holds no tokens, so it is NOT a transfer target.
export const BRIDGE_ROUTER_USDT = '0x8667682b62caceda9e87b3caa21d5b09d9ae13c3'; // BridgeRouter USDT (chains.ts)
// v0.2.3 (user rule): the green ブリッジ出金 section is USDT-ONLY. Only a
// movement of this exact token out through a bridge counts as 'bridge-out';
// bridge sends of any other token are plain 'bridge-send-other' records.
export const USDT_TOKEN = '0xc2684966e5c95b2bc636fb4a1f3da9ad23d94753'; // 42 Chain USDT (18 decimals, bridged)
export const BRIDGE_SEND_TARGETS = new Set([
  '0x049a78fe311cf1c23f09cdd4f12420ffc917c8db', // BridgeRouter QOM (+ BRIDGE row QOM wrapper)
  '0x8667682b62caceda9e87b3caa21d5b09d9ae13c3', // BridgeRouter USDT
  '0xcdbf8da81f0a24f25bcd23c6232704bbfa410bd4', // BridgeRouter USDC
  '0xb436c84a634cceecc13d29dc3f933625522c5e6f', // BridgeRouter WBTC
  '0x4aba9dbe8a990c19501c1c4c3e677f775006d2e2', // BRIDGE row BABY wrapper
  '0x82ba5d61a70677f7f53a9894c63dfb61fd8bcb65', // BRIDGE row CAW wrapper
  '0x056c116c09acb788d038e7ddc167249c26493d6e', // BRIDGE row FATHER wrapper
  '0x0d198200dc673e96217ddea9560d26ae0d092074', // BRIDGE row HAWK wrapper
  '0x3bc94e9f417561ca37559e07dfc65496fce94557', // BRIDGE row KET wrapper
  '0xcb893a7e5f2932531f6e04c0fc3b17ac4884475f', // BRIDGE row O wrapper
  '0xa2093426c03ba6f0f6049532b6f13f1e36566358', // BRIDGE row OSAK wrapper
  '0xf4440822c681ce4cb80b5a3a508876ee23b40f1b', // warp router QOM
  '0x49b525d647068e17892a66e08d197e7faa036d3e', // warp router BABY
  '0xa8493dbb1be229fbbc9127d6d2e387dbea2ae214', // warp router CAW
  '0xae3fb59a4c950447386e7d2ca54ab05c857b817e', // warp router FATHER
  '0xbd0c6e7da96f71cfd2e6651d697b048baf5c91cd', // warp router HAWK
  '0xb1b313b3767c73398935e5bcdd7914340e73f3dd', // warp router KET
  '0xe62ba8a1df1ed3628f2c22a245f7a47a76573cb5', // warp router O
  '0xb477ab5a53d8361b735bd812095325a35fc29b1b', // warp router OSAK
]);
// Destination labels for addresses that may not be in the watchlist.
export const DEST_LABELS = {
  [GUIDE_ADDR]: 'Guide/Fluke',
  [ZG13_ADDR]: 'Zaphod Girls The Thirteen（NFT）',
  [STARLIGHT_ADDR]: 'Starlight',
  [FISH_REWARD_ADDR]: 'FISH報酬コントラクト',
  [DISTRIBUTION_PRECOMPILE]: '報酬配布プリコンパイル（0x0801）',
  [STAKING_PRECOMPILE]: 'ステーキングプリコンパイル（0x0800）',
  [MAILBOX_ADDR]: 'Hyperlaneメールボックス',
  [NFT_MARKETPLACE_ADDR]: 'NFTマーケット',
  [W42_ADDR]: 'W42（Wrapped 42）',
  [ST42_LIVE_ADDR]: 'st42バルト',
  [ST42_BOOK_ADDR]: 'st42注文板（St42Book）',
};
export const NFT_COLLECTIONS = {
  [GUIDE_ADDR]: { name: 'Guide', symbol: 'GUIDE' },
  [ZG13_ADDR]: { name: 'Zaphod Girls The Thirteen', symbol: 'ZG13' },
};
// WS5 definition (printed on the site), narrowed to USDT only in v0.2.3
// (user: 「ブリッジはusdtを外部にブリッジだけに絞って」): bridge-out =
// a validator-self or direct-related wallet sending USDT OUT of 42 Chain
// to an external chain through a bridge. Bridge sends of other tokens are
// recorded as plain moves and never enter this section; inbound receipts
// are plain transfers, never glowing.
export const BRIDGE_OUT_RULE = 'ブリッジ出金の定義：バリデーター本人または直接関連ウォレットが、USDTをブリッジ経由で42チェーンから外部チェーンへ送り出した動き。専用の「ブリッジ出金（USDT・外部へ）」欄で緑色に光って表示されます（注目欄には入れません）。USDT以外の銘柄のブリッジ送信は通常の動きとして記録し、この欄には入れません。入金（42チェーン側での受取）は通常の送金・受取として扱い、特別表示はしません';

// ---------------- v0.2.4: ⚠ Insider section (validator X) ----------------
// User rule: a dedicated warning-style section at the very top of the site
// showing ONLY validator X's own moves and X-related wallets' moves in
// [42] and DONT. Relations are the watchlist's CONFIRMED direct relations
// only (no estimates): the actor must be X itself, or a related-tier,
// non-pair, non-core address whose relatedValidators include 'X'. (The
// FISH/42 pair and the DEX router also carry an X relation in the
// watchlist, but they are infrastructure — they appear as counterparties,
// never as the acting wallet. Xenia is a separate validator and is not
// part of X's insider set either.)
export const X_VALIDATOR_ADDR = '0xdb34ff92995c74d170755a563a1a2c35a3db4738'; // watchlist validator entry, moniker 'X'
export const DONT_TOKEN = '0xfaa842c8871f7f99c183f77871f79ce07dd056cd'; // whitelist PANIC contract == DONT
export const INSIDER_RULE = 'インサイダー欄：リスティング当日（2026年6月30日）14時00分（日本時間）より前に、バリデーターX（Rioshi）本人とX（Rioshi）の直接関連アドレスが行った [42] と DONT（PANIC）の「買い」だけを表示します。それ以外の動きは通常の記録に含まれます';
export const ESTIMATED_RULE = '推定アドレスについて（v0.3.0 / Phase 3）：直接の送金が確認できないつながりを、次の3つの方法で推定したアドレスです。①プール経由（プールの反対側の売買と、金額差10%以内・24時間以内で一致）②2ホップ経由（バリデーター→このアドレス→バリデーターの両レッグとも確認済みの送金）③共通の相手先（2名以上のバリデーターと直接取引した第三者で、まだ確定関連に入っていないもの）。推定アドレスの動きは「最新の動き」にだけ、推定バッジと根拠つきで表示します。インサイダー／スナイプ／注目／ブリッジ出金／総額グラフの特別欄は、確定情報（本人＋直接関連）だけを使い、推定は一切含みません';

// ---------------- v0.4.0: pairs / dormant / new faces / price ----------------
// The 42/USDT pair (Don't Panic factory) whose reserves price [42].
export const PAIR_42_USDT = '0xfac6a97837fd3ef5876e18457eea52415296c613';
export const DEAD_ADDR = '0x000000000000000000000000000000000000dead'; // burn sink, not a person
// Verified system contracts (all already constants above from chains.ts /
// research): never auto-added as "related wallets", never flagged as new
// faces, never traversed by the closure. The FISH reward contract is a
// mechanical distribution contract (2026-11-01 research), so it belongs
// here; the FISH DISTRIBUTOR (0xbfc5...4f29) is an operator WALLET and is
// deliberately NOT in this set.
export const KNOWN_SYSTEM_CONTRACTS = new Set([
  FACTORY, ROUTER, GUIDE_ADDR, ZG13_ADDR, STARLIGHT_ADDR, ST42_LIVE_ADDR, ST42_VAULT_ADDR, ST42_BOOK_ADDR,
  STAKING_PRECOMPILE, DISTRIBUTION_PRECOMPILE, MAILBOX_ADDR, W42_ADDR, FISH_REWARD_ADDR, NFT_MARKETPLACE_ADDR,
  ...BRIDGE_SEND_TARGETS,
]);
// Addresses that must never become related-tier entries (auto-add / new
// faces): core infrastructure from the watchlist (pairs, routers,
// precompiles — everything isCore except the #1 holder, who is a person
// wallet and a legitimate seed), pair contracts, token contracts, the
// factory, the zero/burn addresses, and the verified system contracts.
const HOLDER_ADDR = '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25';
// v0.4.2: permanent exclusions (owner-requested). The addresses are NEVER
// written anywhere in this repository (it is public, so a plaintext list
// would itself be a disclosure): they are supplied only at runtime via
// the EXCLUDED_ACTORS environment variable — a GitHub Actions secret in
// production, a plain env var for local runs. An excluded address is
// never watched, never auto-added, never traversed by the closure, and
// events where it is the actor are never recorded.
export function excludedActorsFromEnv(env = process.env) {
  const raw = env.EXCLUDED_ACTORS ?? '';
  return new Set(raw.split(/[\s,]+/).map((a) => lc(a.trim())).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
}
export function isPermanentlyExcluded(addr, env = process.env) {
  return !!addr && excludedActorsFromEnv(env).has(lc(addr));
}
export function buildExcludedSet(watchlist, registries) {
  const s = new Set([ZERO, DEAD_ADDR, FACTORY, ...KNOWN_SYSTEM_CONTRACTS]);
  for (const e of watchlist.entries) if (e.isCore && e.address !== HOLDER_ADDR) s.add(e.address);
  for (const a of Object.keys(registries.pairs ?? {})) s.add(lc(a));
  for (const a of Object.keys(registries.tokens ?? {})) s.add(lc(a));
  for (const a of excludedActorsFromEnv()) s.add(a);
  return s;
}
// Dormant-return definition (printed on the site): a watched wallet (self /
// related / core-labelled EOA — pair and known contracts excluded,
// estimated excluded) that moves again after >= 60 days of silence in the
// recorded history.
export const DORMANT_THRESHOLD_SECS = 60 * 86400;
export const DORMANT_RULE = '休眠復帰の定義：監視アドレス（バリデーター本人・関連・中核ラベルのEOA。ペア等のコントラクトと推定アドレスは除く）が、このサイトの記録の中で60日以上動きがなかった後に動いた場合、その復帰した動きに「○○日ぶりの動き」と表示します';
// Build one 'pair-created' event from a resolved creation record. The
// display rule (at least one side whitelisted) is applied render-side via
// pairWhitelist; nonWhitelistedSide drives the 対象外トークン caution badge.
export function buildPairCreatedEvent(ctx, pairAddr, creation, firstMint) {
  pairAddr = lc(pairAddr);
  const pair = ctx.pairs[pairAddr];
  if (!pair || !creation?.createdTs) return null;
  const i0 = ctx.tokenInfo(pair.token0), i1 = ctx.tokenInfo(pair.token1);
  const creator = creation.creator ? lc(creation.creator) : null;
  const ce = creator ? ctx.entry(creator) : null;
  const pairLabel = `${i0.symbol}/${i1.symbol} ペア`;
  const fm = firstMint ? {
    block: firstMint.block, ts: firstMint.ts, txHash: firstMint.txHash ?? null,
    amount0: amountObj(ctx, pair.token0, firstMint.a0), amount1: amountObj(ctx, pair.token1, firstMint.a1),
  } : null;
  return {
    id: `pair-created:${pairAddr}`,
    chain: 'evm', type: 'pair-created',
    ts: creation.createdTs, block: creation.createdBlock, txHash: creation.txHash ?? null, logIndex: null,
    actor: creator ?? pairAddr, actorLabel: ce?.label ?? null, actorTier: ce?.tier ?? null, actorIsCore: !!ce?.isCore,
    counterparty: pairAddr, counterpartyLabel: pairLabel, counterpartyIsCore: true,
    pair: pairAddr, pairLabel, tokens: [i0.symbol, i1.symbol], pairSymbols: [i0.symbol, i1.symbol],
    pairWhitelist: [!!i0.whitelisted, !!i1.whitelisted],
    nonWhitelistedSide: !(i0.whitelisted && i1.whitelisted),
    whitelisted: true,
    firstMint: fm,
    validatorNames: creator ? validatorNamesFor(ctx, ce, pairAddr) : [],
    notableReasons: [],
    summary: `新しいペア ${i0.symbol}/${i1.symbol} が作成されました` + (fm ? `（最初の流動性：${fm.amount0.amount} ${fm.amount0.symbol} ＋ ${fm.amount1.amount} ${fm.amount1.symbol}）` : ''),
  };
}
// Staking aggregates for the 🏦 section, computed by the collector over the
// FULL stored history (the frontend never recomputes from the 500-window).
// Attribution is conservative: commission counts per-validator only when
// the actor IS the validator (an operator-side account shared by several
// validators is ambiguous -> totals only); delegation in/out counts
// per-validator only when the counterparty resolves to a validator entry.
export function computeStakingStats(events, ctx) {
  const TYPES = ['delegate', 'undelegate', 'redelegate', 'reward', 'commission'];
  const totals = {}; for (const t of TYPES) totals[t] = { count: 0, raw: 0n };
  const per = new Map();
  const perFor = (name) => { if (!per.has(name)) per.set(name, { moniker: name, commissionCount: 0, commissionRaw: 0n, delegateInCount: 0, delegateInRaw: 0n, undelegateOutCount: 0, undelegateOutRaw: 0n }); return per.get(name); };
  let unattributedCommission = 0, unattributedDelegate = 0, unattributedUndelegate = 0;
  let minBlock = null, maxBlock = null, minTs = null, maxTs = null;
  for (const ev of events) {
    if (ev.block != null) { minBlock = minBlock == null ? ev.block : Math.min(minBlock, ev.block); maxBlock = maxBlock == null ? ev.block : Math.max(maxBlock, ev.block); }
    if (ev.ts != null) { minTs = minTs == null ? ev.ts : Math.min(minTs, ev.ts); maxTs = maxTs == null ? ev.ts : Math.max(maxTs, ev.ts); }
    if (!TYPES.includes(ev.type)) continue;
    totals[ev.type].count++;
    const raw = ev.amount?.symbol === '42' && ev.amount?.amountRaw ? BigInt(ev.amount.amountRaw) : 0n;
    totals[ev.type].raw += raw;
    if (ev.type === 'commission') {
      const ae = ctx.entry(ev.actor);
      if (ae?.tier === 'validator' && ae.label) { const p = perFor(ae.label); p.commissionCount++; p.commissionRaw += raw; }
      else unattributedCommission++;
    } else if (ev.type === 'delegate' || ev.type === 'undelegate') {
      const ce = ev.counterparty ? ctx.entry(ev.counterparty) : null;
      if (ce?.tier === 'validator' && ce.label) {
        const p = perFor(ce.label);
        if (ev.type === 'delegate') { p.delegateInCount++; p.delegateInRaw += raw; } else { p.undelegateOutCount++; p.undelegateOutRaw += raw; }
      } else if (ev.type === 'delegate') unattributedDelegate++; else unattributedUndelegate++;
    }
  }
  const fmt = (raw) => fmtNum(raw.toString(), 18);
  const totalsOut = {}; for (const t of TYPES) totalsOut[t] = { count: totals[t].count, amount42: fmt(totals[t].raw) };
  const perValidator = [...per.values()]
    .map((p) => ({ moniker: p.moniker, commissionCount: p.commissionCount, commission42: fmt(p.commissionRaw), delegateInCount: p.delegateInCount, delegateIn42: fmt(p.delegateInRaw), undelegateOutCount: p.undelegateOutCount, undelegateOut42: fmt(p.undelegateOutRaw), _c: p.commissionRaw, _d: p.delegateInRaw }))
    .filter((p) => p.commissionCount || p.delegateInCount || p.undelegateOutCount)
    .sort((a, b) => (b._c > a._c ? 1 : b._c < a._c ? -1 : b._d > a._d ? 1 : b._d < a._d ? -1 : 0))
    .map(({ _c, _d, ...rest }) => rest);
  return { range: { fromBlock: minBlock, toBlock: maxBlock, fromTs: minTs, toTs: maxTs }, totals: totalsOut, perValidator, unattributed: { commission: unattributedCommission, delegate: unattributedDelegate, undelegate: unattributedUndelegate } };
}
// Bridge-out totals chart aggregation (v0.4.2, user rule change):
// PER-VALIDATOR attribution instead of v0.4.1's count-once rule.
//  - One bar per validator — ALL validators, zero bars included.
//  - A validator's bar sums the bridge-outs (USDT) of EVERY wallet
//    connected to it (its relatedValidators attribution, unlimited
//    depth). A shared wallet is counted in EACH connected validator's
//    bar, so the bars intentionally do NOT sum to the grand total.
//  - Segments per bar: 0 = the validator itself; 1 = a related wallet
//    that transacted DIRECTLY with that validator (research-confirmed
//    original related entry naming the validator, or an actor<->
//    counterparty edge with the validator in the recorded events);
//    2 = connected only through other wallets (inherited attribution).
//  - Senders are personal wallets only: validator + related tiers.
//    Estimated actors stay excluded (as before), and contract actors
//    no longer exist in the person tiers at all (v0.4.2 EOA-only rule).
//  - The deduplicated grand total (each bridge-out counted once) and
//    its global-depth segment totals are reported alongside.
export function computeBridgeChart(events, ctx) {
  const valAddr = new Map(); // moniker -> address
  for (const [, e] of ctx.watch) if (e.tier === 'validator' && e.label) valAddr.set(e.label, e.address);
  const adj = new Set();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const ev of events) {
    if (ev.actor && ev.counterparty) adj.add(key(lc(ev.actor), lc(ev.counterparty)));
  }
  const depthOf = (en) => (en.tier === 'validator' ? 0 : (en.depth ?? 1));
  const per = new Map();
  for (const name of valAddr.keys()) per.set(name, { moniker: name, seg: [0, 0, 0], total: 0, count: 0 });
  let total = 0, count = 0; const segTotals = [0, 0, 0];
  const amtOf = (e) => parseFloat(String((e.amount && e.amount.amount) || '0').replace(/,/g, '')) || 0;
  for (const ev of events) {
    if (ev.type !== 'bridge-out') continue;
    const ae = ctx.entry(ev.actor);
    if (!ae || (ae.tier !== 'validator' && ae.tier !== 'related')) continue;
    const a = amtOf(ev);
    total += a; count++;
    const gd = depthOf(ae);
    segTotals[gd <= 0 ? 0 : gd === 1 ? 1 : 2] += a;
    const names = ae.tier === 'validator' ? (ae.label ? [ae.label] : []) : [...(ae.relatedValidators ?? [])];
    for (const name of names) {
      const g = per.get(name);
      if (!g) continue;
      let s;
      if (ae.tier === 'validator' && ae.label === name) s = 0;
      else if ((!ae.autoAdded && (ae.relatedValidators ?? []).includes(name)) || (valAddr.get(name) && adj.has(key(ae.address, valAddr.get(name))))) s = 1;
      else s = 2;
      g.seg[s] += a; g.total += a; g.count++;
    }
  }
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const perValidator = [...per.values()]
    .map((g) => ({ moniker: g.moniker, seg: g.seg.map(r6), total: r6(g.total), count: g.count }))
    .sort((x, y) => (y.total - x.total) || x.moniker.localeCompare(y.moniker));
  return { total: r6(total), count, segTotals: segTotals.map(r6), perValidator };
}
// Deterministic history pass (v0.4.0): derives isDormantReturn /
// dormantDays and isNewCounterparty from the FULL event history in
// chronological order. Recomputed from scratch on every run, so Actions
// merges and backfills always converge to the same flags.
//  - New counterparty: the first event (chronologically) whose
//    counterparty was never seen before. The known set starts from every
//    NON-autoAdded watchlist address (auto-added addresses were unknown
//    before their first appearance, so their first event still flags),
//    all pair/token contracts and the verified system contracts.
//  - Dormant return: per eligible actor (validator / related tier, not a
//    pair, not core, not a known contract — estimated actors are a
//    different tier and never eligible), an event whose previous event by
//    the same actor is >= DORMANT_THRESHOLD_SECS older.
// ev.watchlistAdded is NOT touched here: it is set only at live-add time.
export function computeHistoryFlags(events, ctx) {
  let changed = 0;
  const set = (ev, k, v) => { if (JSON.stringify(ev[k]) !== JSON.stringify(v)) { ev[k] = v; changed++; } };
  const clear = (ev, k) => { if (k in ev) { delete ev[k]; changed++; } };
  const known = new Set([ZERO, DEAD_ADDR, FACTORY, ...KNOWN_SYSTEM_CONTRACTS]);
  for (const [addr, e] of ctx.watch) if (!e.autoAdded) known.add(addr);
  for (const a of Object.keys(ctx.pairs)) known.add(lc(a));
  for (const a of Object.keys(ctx.tokens)) known.add(lc(a));
  const sorted = [...events].sort((a, b) => (a.ts - b.ts) || ((a.block ?? 0) - (b.block ?? 0)) || ((a.logIndex ?? -1) - (b.logIndex ?? -1)) || String(a.id).localeCompare(String(b.id)));
  const lastByActor = new Map();
  let dormantCount = 0, newfaceCount = 0, longestDays = 0;
  for (const ev of sorted) {
    // new counterparty (first appearance in the whole recorded history)
    const cp = ev.counterparty ? lc(ev.counterparty) : null;
    if (cp && cp !== lc(ev.actor) && !known.has(cp)) { set(ev, 'isNewCounterparty', true); newfaceCount++; }
    else if (ev.isNewCounterparty) clear(ev, 'isNewCounterparty');
    if (cp) known.add(cp);
    // Watched actors are known by definition; an UNWATCHED actor (a pair
    // creator on a pair-created event) must not silently become "known" —
    // its first appearance as someone's counterparty still counts.
    if (ev.actor && ctx.watch.has(lc(ev.actor))) known.add(lc(ev.actor));
    // dormant return
    const ae = ctx.entry(ev.actor);
    const eligible = !!ae && (ae.tier === 'validator' || ae.tier === 'related') && !ae.isPair && !ae.isCore && !KNOWN_CONTRACTS[lc(ev.actor)];
    const prev = lastByActor.get(lc(ev.actor));
    if (eligible && prev != null && ev.ts - prev >= DORMANT_THRESHOLD_SECS) {
      const days = Math.floor((ev.ts - prev) / 86400);
      set(ev, 'isDormantReturn', true); set(ev, 'dormantDays', days); set(ev, 'dormantSinceTs', prev);
      dormantCount++; if (days > longestDays) longestDays = days;
    } else {
      if (ev.isDormantReturn) clear(ev, 'isDormantReturn');
      if ('dormantDays' in ev) clear(ev, 'dormantDays');
      if ('dormantSinceTs' in ev) clear(ev, 'dormantSinceTs');
    }
    if (ev.actor) lastByActor.set(lc(ev.actor), ev.ts);
  }
  return { changed, dormantCount, newfaceCount, longestDays };
}
// Live auto-add (v0.4.0, user rule; scope narrowed in v0.5.3): when a
// CONFIRMED watched wallet (validator / depth-1 related) transacts with
// an address that is not watched yet, that address can join the watchlist
// under the depth-1 rules only (see maybeAutoAddLive: a first direct
// contact with a validator becomes a CANDIDATE; deeper counterparties are
// never adopted — v0.5.3 retired depth>=2 adoption and the evidence gate
// entirely). Estimated actors never trigger an add (an
// estimate is never promoted by proxy), pairs and known system/token
// contracts never get added (they live on the core side), and an address
// reachable only through an estimated wallet is not added either (it can
// still be added later through a confirmed contact).
// Returns the new entry, or null when nothing was added.
export function planAutoAdd(watchlist, ctx, ev, excluded) {
  const cp = ev.counterparty ? lc(ev.counterparty) : null;
  if (!cp || cp === lc(ev.actor)) return null;
  const ae = ctx.entry(ev.actor);
  if (!ae || (ae.tier !== 'validator' && ae.tier !== 'related')) return null;
  if (ctx.watch.has(cp) || excluded.has(cp) || ctx.pairs[cp]) return null;
  const names = ae.tier === 'validator' ? (ae.label ? [ae.label] : []) : [...(ae.relatedValidators ?? [])];
  if (!names.length) return null;
  const depth = (ae.depth ?? (ae.tier === 'validator' ? 0 : 1)) + 1;
  return { cp, names, depth, actor: lc(ev.actor), ts: ev.ts, txHash: ev.txHash ?? null };
}
export function applyAutoAdd(watchlist, ctx, plan) {
  const entry = {
    address: plan.cp, tier: 'related', label: null, isCore: false, isPair: false, watch: true,
    validators: [], relatedValidators: plan.names,
    autoAdded: true, addedVia: 'live', addedAt: plan.ts, firstSeenTx: plan.txHash,
    via: { address: plan.actor, validators: plan.names }, depth: plan.depth,
  };
  if (plan.evidence) entry.evidence = plan.evidence;
  watchlist.entries.push(entry);
  ctx.watch.set(plan.cp, entry);
  return entry;
}
export function maybeAutoAdd(watchlist, ctx, ev, excluded) {
  const plan = planAutoAdd(watchlist, ctx, ev, excluded);
  return plan ? applyAutoAdd(watchlist, ctx, plan) : null;
}
// v0.4.2 (user rule: 仕組み系は全部排除): the live auto-add is bytecode-
// gated. A counterparty carrying contract bytecode is NEVER added as a
// related wallet; it is registered on the core side instead (label only,
// for counterparty display). Person tiers are EOA-only.
const codeCache = new Map();
export async function isContractAddress(addr) {
  addr = lc(addr);
  if (codeCache.has(addr)) return codeCache.get(addr);
  let isC = false;
  try {
    const [code] = await rpcBatch([{ method: 'eth_getCode', params: [addr, 'latest'] }]);
    isC = !!code && code !== '0x';
  } catch { isC = false; } // RPC trouble: fall back to the sync rules; the periodic audit is the systematic gate
  codeCache.set(addr, isC);
  return isC;
}
export function registerCoreContract(watchlist, ctx, addr, label) {
  addr = lc(addr);
  const existing = ctx.entry(addr);
  if (existing) return existing;
  const entry = {
    address: addr, tier: 'core', label: label ?? 'コントラクト（未分類）', isCore: true, isPair: !!ctx.pairs[addr], watch: false,
    validators: [], relatedValidators: [],
    coreNote: 'ライブ収集中にバイトコードありと判定し中核へ登録（v0.4.2：仕組み系は人の関連に入れない）',
  };
  watchlist.entries.push(entry);
  ctx.watch.set(addr, entry);
  return entry;
}
// ---- Wallet-evidence rules (v0.4.2; RETIRED in v0.5.3) ----
// v0.5.3 (user decision 「1段目までにする」): the tracker covers depth-1
// only. The evidence gate below is no longer used by the live auto-add —
// depth>=2 newcomers are never adopted. evidenceCodesFor /
// assessEvidenceFromEvents are kept solely because the historical repair
// scripts (repair-evidence.mjs) and their tests reference them.
// (v0.4.2 rule, for the record: depth>=2 related addresses were tracked
// ONLY with evidence that they are the validator's own wallet.
// evidenceCodesFor is the single threshold implementation:
// repair-evidence.mjs feeds it flow-index statistics.)
//   STRONG (one is enough):
//     bidirectional       — fund movements in BOTH directions with the
//                           validator itself or its depth-1 wallets
//     funded-delegation   — received funds from the self side and
//                           delegated at least half of the [42]
//                           received to that validator
//     concentrated-repeat — >=5 transfers with the self side, and at
//                           least half of all its validator-side
//                           transfers are with this validator's side
//   WEAK (two needed):
//     one-way-repeat      — >=3 one-way transfers FROM the self side
//     delegation          — any delegation to that validator
//     synchronized        — a swap-buy within 10 minutes of a
//                           self-side wallet's swap-buy
export function evidenceCodesFor({ inN = 0, outN = 0, totalVS = 0, received42 = 0n, delegated42 = 0n, delegateCount = 0, sync = false }) {
  const strong = [], weak = [];
  if (inN >= 1 && outN >= 1) strong.push('bidirectional');
  if (inN >= 1 && received42 > 0n && delegated42 > 0n && delegated42 * 2n >= received42) strong.push('funded-delegation');
  if (inN + outN >= 5 && totalVS > 0 && (inN + outN) * 2 >= totalVS) strong.push('concentrated-repeat');
  if (outN === 0 && inN >= 3) weak.push('one-way-repeat');
  if (delegateCount >= 1) weak.push('delegation');
  if (sync) weak.push('synchronized');
  return { strong, weak, adopted: strong.length >= 1 || weak.length >= 2 };
}
// The "self side" of a validator: its own address + its depth-1
// (original, research-confirmed) related wallets.
export function selfSideMembers(ctx, name) {
  const members = new Set();
  for (const [, e] of ctx.watch) {
    if (e.tier === 'validator' && e.label === name) members.add(e.address);
    else if (e.tier === 'related' && !e.autoAdded && (e.relatedValidators ?? []).includes(name)) members.add(e.address);
  }
  return members;
}
const is42Amount = (a) => !!a && (a.token === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || a.denom === 'drop');
export function assessEvidenceFromEvents(addr, names, ctx, events) {
  addr = lc(addr);
  const allSide = new Set();
  for (const [, e] of ctx.watch) {
    if (e.tier === 'validator') allSide.add(e.address);
    else if (e.tier === 'related' && !e.autoAdded) allSide.add(e.address);
  }
  let totalVS = 0;
  const candBuys = [];
  for (const ev of events) {
    if (ev.type === 'transfer' && ev.counterparty) {
      if (ev.actor === addr && allSide.has(ev.counterparty)) totalVS++;
      else if (ev.counterparty === addr && allSide.has(ev.actor)) totalVS++;
    }
    if (ev.type === 'swap-buy' && ev.actor === addr) candBuys.push(ev.ts);
  }
  const adopted = {};
  for (const name of names) {
    const S = selfSideMembers(ctx, name);
    let inN = 0, outN = 0, delegateCount = 0, sync = false;
    let received42 = 0n, delegated42 = 0n;
    const sideBuys = [];
    for (const ev of events) {
      if (ev.type === 'transfer' && ev.counterparty) {
        if (ev.counterparty === addr && S.has(ev.actor)) { inN++; if (is42Amount(ev.amount)) { try { received42 += BigInt(ev.amount.amountRaw ?? '0'); } catch {} } }
        else if (ev.actor === addr && S.has(ev.counterparty)) outN++;
      } else if (ev.type === 'delegate' && ev.actor === addr && (ev.validatorNames ?? []).includes(name)) {
        delegateCount++;
        try { delegated42 += BigInt(ev.amount?.amountRaw ?? '0'); } catch {}
      } else if (ev.type === 'swap-buy' && S.has(ev.actor)) sideBuys.push(ev.ts);
    }
    if (candBuys.length && sideBuys.length) {
      outer: for (const t of candBuys) for (const s of sideBuys) if (Math.abs(t - s) <= 600) { sync = true; break outer; }
    }
    const r = evidenceCodesFor({ inN, outN, totalVS, received42, delegated42, delegateCount, sync });
    if (r.adopted) adopted[name] = [...r.strong, ...r.weak];
  }
  return adopted;
}
// ---- One-off candidates (v0.5.2, user-approved tightening) ----
// A depth-1 "related" (confirmed) relation now requires DIRECT dealings
// with the validator itself: at least 2 direct value transfers, or a
// two-way exchange (1+ each way — which also totals 2). A first, one-off
// one-way contact does NOT make an address related: it becomes a
// CANDIDATE (tier 'candidate', watch:false — never displayed, its own
// events are never recorded). Every later direct transfer between the
// validator and the candidate is observed here; the moment the count
// against that validator reaches 2, the candidate is promoted to
// related and recording starts. The unit is one transfer leg, matching
// the flow-index aggregates (flows.jsonl tt/cs legs + native sends).
const CANDIDATE_TRANSFER_TYPES = new Set(['transfer', 'bridge-send-other', 'nft-transfer']);
export function directPairOf(ev, ctx) {
  if (!ev || !CANDIDATE_TRANSFER_TYPES.has(ev.type) || !ev.from || !ev.to) return null;
  const f = lc(ev.from), t = lc(ev.to);
  if (f === t) return null;
  const fe = ctx.entry(f), te = ctx.entry(t);
  if (fe?.tier === 'validator' && te?.tier !== 'validator') return { validator: fe, other: t, dir: 'out' };
  if (te?.tier === 'validator' && fe?.tier !== 'validator') return { validator: te, other: f, dir: 'in' };
  return null;
}
export function observeCandidateInteraction(watchlist, ctx, ev) {
  const pair = directPairOf(ev, ctx);
  if (!pair) return null;
  const ce = ctx.entry(pair.other);
  if (!ce || ce.tier !== 'candidate') return null;
  const name = pair.validator.label;
  const st = ((ce.directStats ??= {})[name] ??= { out: 0, in: 0 });
  st[pair.dir] += 1;
  if (st.out + st.in < 2) return { observed: ce };
  const names = Object.entries(ce.directStats).filter(([, s]) => s.out + s.in >= 2).map(([n]) => n);
  ce.tier = 'related'; ce.watch = true;
  ce.relatedValidators = names.sort();
  ce.promotedAt = ev.ts ?? null;
  ce.addedVia = 'live';
  return { promoted: ce };
}
// Live variant used by the collection loops: plans the add, checks the
// counterparty's bytecode, and either applies the related add (returns
// the new related entry) or registers a core contract (returns
// { contract }). Returns null when nothing was added.
// v0.4.2 gates: contracts never enter the person tiers (routed to the
// core registry); unlimited automatic expansion is stopped.
// v0.5.2 gate: a depth-1 newcomer (first direct contact with a
// validator) enters as a one-off CANDIDATE, not as related — see
// observeCandidateInteraction above. Candidate interactions with a
// validator are observed (and may promote) before anything else.
// v0.5.3: depth>=2 adoption is RETIRED (user decision: depth-1 only).
// A counterparty of a related wallet is never adopted, with or without
// evidence; it can still join later through its own direct dealings
// with a validator (the candidate path above).
export async function maybeAutoAddLive(watchlist, ctx, ev, excluded, opts = {}) {
  const isContractFn = opts.isContractFn ?? isContractAddress;
  const obs = observeCandidateInteraction(watchlist, ctx, ev);
  if (obs) return obs;
  const plan = planAutoAdd(watchlist, ctx, ev, excluded);
  if (!plan) return null;
  if (await isContractFn(plan.cp)) {
    const label = DEST_LABELS[plan.cp] ?? KNOWN_CONTRACTS[plan.cp] ?? null;
    return { contract: registerCoreContract(watchlist, ctx, plan.cp, label) };
  }
  if (plan.depth <= 1) {
    const entry = {
      address: plan.cp, tier: 'candidate', label: null, isCore: false, isPair: false, watch: false,
      validators: [], relatedValidators: [],
      autoAdded: true, addedVia: 'live-candidate', addedAt: plan.ts, firstSeenTx: plan.txHash,
      via: { address: plan.actor, validators: plan.names }, directStats: {},
    };
    watchlist.entries.push(entry);
    ctx.watch.set(plan.cp, entry);
    const pair = directPairOf(ev, ctx);
    if (pair && pair.other === plan.cp) {
      const st = (entry.directStats[pair.validator.label] ??= { out: 0, in: 0 });
      st[pair.dir] += 1;
    }
    return { candidate: entry };
  }
  if (plan.depth >= 2) {
    // v0.5.3: depth>=2 adoption retired — never adopted (the v0.4.2
    // evidence gate that used to run here is gone). The address may
    // still become a depth-1 candidate through its own direct dealings
    // with a validator.
    return null;
  }
  return applyAutoAdd(watchlist, ctx, plan);
}
// Recompute the derived watchlist summary counts after any mutation
// (validator refresh keeps its own fields; the research-derived link
// counts are left untouched).
export function recomputeWatchlistSummary(watchlist) {
  const s = (watchlist.summary ??= {});
  const cnt = (t) => watchlist.entries.filter((e) => e.tier === t).length;
  s.validators = cnt('validator'); s.related = cnt('related'); s.core = cnt('core'); s.estimated = cnt('estimated');
  s.candidates = cnt('candidate');
  s.directRelated = s.related;
  s.coreLabelOnly = s.core;
  s.coreFlaggedTotal = watchlist.entries.filter((e) => e.isCore).length;
  s.watchedActors = watchlist.entries.filter((e) => e.watch).length;
  s.totalEntries = watchlist.entries.length;
  s.autoAdded = watchlist.entries.filter((e) => e.autoAdded).length;
  s.autoAddedClosure = watchlist.entries.filter((e) => e.autoAdded && e.addedVia === 'closure-v0.4.0').length;
  s.autoAddedLive = watchlist.entries.filter((e) => e.autoAdded && e.addedVia === 'live').length;
  return s;
}
export function isInsiderEvent(ev, ctx) {
  const ae = ctx.entry(ev.actor);
  if (!ae) return false;
  // v0.4.0: the Insider definition says DIRECTLY related — the recursive
  // closure entries (depth >= 2) are related, but not direct, so they stay
  // out of this section even when X is among their inherited names.
  const xSide = (ae.tier === 'validator' && ae.label === 'X')
    || (ae.tier === 'related' && !ae.isPair && !ae.isCore && (ae.depth ?? 1) <= 1 && (ae.relatedValidators ?? []).includes('X'));
  if (!xSide) return false;
  const addrs = [ev.amount?.token, ev.sold?.token, ev.bought?.token, ...((ev.amounts ?? []).map((a) => a.token)), ev.counterparty].filter(Boolean).map(lc);
  if (addrs.includes(W42) || addrs.includes(DONT_TOKEN)) return true;
  const syms = ev.tokens ?? [];
  return syms.includes('42') || syms.includes('PANIC') || syms.includes('DONT');
}

// Method-call event types that keep the v0.1.0 repetition suppression
// (same actor + destination + method within ~360 blocks). Transfers, swaps,
// LP and NFT events are NEVER suppressed.
export const METHOD_EVENT_TYPES = new Set([
  'approve', 'fluke-commit', 'fluke-reveal', 'fluke-boost', 'fluke-settle', 'fluke-seed',
  'guide-write', 'guide-append', 'starlight-register', 'reward-claim-starlight',
  'st42-deposit', 'st42-redeem-request', 'st42-claim', 'st42-instant-exit', 'st42-order',
  'reward-claim-fish', 'reward-distribution-fish', 'token-burn', 'reward-claim-staking',
  'bridge-out', 'bridge-send-other', 'bridge-delivery', 'dex-swap', 'wrap', 'unwrap', 'nft-approve-all',
  'delegate', 'undelegate', 'redelegate', 'unclassified', 'other-contract',
]);

// --- selector table (all selectors verified with ethers.id() against the
// --- signature strings; sources: wallet zaphod.ts / protocol.ts human ABIs,
// --- research/abi-fluke.json (Guide core + Starlight ledger verbatim),
// --- research/abi-st42vault.json / abi-st42book.json, ERC-20/721 standards,
// --- Uniswap V2 router/pair standards, Hyperlane mailbox/bridge ABIs) ---
const S = {
  approve: '0x095ea7b3', // approve(address,uint256)
  transfer: '0xa9059cbb', // transfer(address,uint256)
  transferFrom: '0x23b872dd', // transferFrom(address,address,uint256)
  safeTransferFrom3: '0x42842e0e', // safeTransferFrom(address,address,uint256)
  safeTransferFrom4: '0xb88d4fde', // safeTransferFrom(address,address,uint256,bytes)
  safeTransferFrom1155: '0xf242432a', // safeTransferFrom(address,address,uint256,uint256,bytes)
  setApprovalForAll: '0xa22cb465', // setApprovalForAll(address,bool)
  flukeCommit: '0xf4f98ad5', // commit(uint256)
  flukeReveal: '0x9348cef7', // reveal(uint256,uint256)
  flukeBoost: '0x40be7bec', // boost(uint256,uint256)
  flukeSettle: '0x39c2ebb9', // settle(uint256,bytes)
  flukeSeed: '0x166a00e4', // seed(uint256,uint256)
  guideWrite: '0x216a3382', // write(uint256,string)
  guideAppend: '0xe2a89b71', // append(uint256,string,uint256)
  starlightRegister: '0x7a34289d', // register(uint256[])
  starlightClaim: '0x6ba4c138', // claim(uint256[])
  starlightClaimToken: '0x7d76838e', // claimToken(uint256[],address)
  st42Deposit: '0xd0e30db0', // deposit()
  st42DepositTo: '0xb760faf9', // depositTo(address)
  st42RequestRedeem: '0xaa2f892d', // requestRedeem(uint256)
  st42Claim: '0x379607f5', // claim(uint256)
  st42ClaimTo: '0x30e1198b', // claimTo(uint256,address)
  st42InstantExit: '0xeb8738f5', // instantExit(uint256,uint256)
  bookPlaceBid: '0x9979ef45', // placeBid(uint256)
  bookPlaceAsk: '0x75a8b702', // placeAsk(uint256,uint256)
  bookMarketBuy: '0x69a29ed8', // marketBuy(uint256[],uint256,uint256)
  bookMarketSell: '0xf5f884dc', // marketSell(uint256[],uint256,uint256,uint256)
  bookCancel: '0x40e58ee5', // cancel(uint256)
  stakingDelegate: '0x53266bbb', // delegate(address,string,uint256)
  stakingUndelegate: '0x3edab33c', // undelegate(address,string,uint256)
  stakingRedelegate: '0x54b826f5', // redelegate(address,string,string,uint256)
  distClaimRewards: '0x2efe8a5f', // claimRewards(address,uint32)
  transferRemote: '0x81b4e8b4', // transferRemote(uint32,bytes32,uint256)
  mailboxDispatch: '0xfa31de01', // dispatch(uint32,bytes32,bytes)
  mailboxProcess: '0x7c39d130', // process(bytes,bytes)
  fishClaim: '0x5c74910f', // FISH reward contract: self-claim (2026-11-01 research, function id as recorded there)
  fishDistribute: '0x0fb39e45', // FISH reward contract via distributor: batch distribution (same research)
  fishBurn: '0x87157886', // FISH token: operator burn function (same research; name as recorded there)
  w42Withdraw: '0x2e1a7d4d', // withdraw(uint256)
  routerAddLiq: '0xe8e33700', routerAddLiqETH: '0xf305d719',
  routerRemoveLiq: '0xbaa2abde', routerRemoveLiqETH: '0x02751cec',
  pairSwap: '0x022c0d9f', // swap(uint256,uint256,address,bytes)
  pairMint: '0x6a627842', // mint(address)
  pairBurn: '0x89afcb44', // burn(address)
  pairSkim: '0xbc25cf77', // skim(address)
  pairSync: '0xfff6cae9', // sync()
};
const ROUTER_SWAP_SELS = new Set([
  '0x38ed1739', '0x7ff36ab5', '0x18cbafe5', '0x8803dbee', '0x4a25d94a', '0xfb3bdb41',
  '0x5c11d795', '0xb6f9de95', '0x791ac947', // swapExact*/swapTokens* (+SupportingFeeOnTransferTokens variants)
]);

function destLabelFor(ctx, addr) {
  addr = lc(addr);
  return DEST_LABELS[addr] ?? ctx.entry(addr)?.label ?? null;
}
function tokenSymbolFor(ctx, addr) {
  const info = ctx.tokenInfo(addr);
  return info && !String(info.symbol).startsWith('…') ? info.symbol : null;
}
// Classify one method call by (destination, selector). Returns
// {type, actionLabel, summary} — for unknown calls the honest
// {type:'unclassified'} form with method + destination in the summary.
// mintAmounts: [{symbol, amount}] of tokens minted TO the actor in the same
// tx (e.g. a FISH reward claim mints the claimed FISH) — live path only.
export function classifyMethodCall(ctx, to, input, mintAmounts = []) {
  to = lc(to);
  const sel = (input ?? '').slice(0, 10).toLowerCase();
  const destLabel = destLabelFor(ctx, to);
  const destShort = '…' + to.slice(-4).toUpperCase();
  const destDisp = destLabel ? `${destLabel}（${destShort}）` : destShort;
  const mintNote = mintAmounts.length ? `：${mintAmounts.map((m) => `${m.amount} ${m.symbol}`).join(' ＋ ')} を受け取り` : '';
  const R = (type, actionLabel, summary) => ({ type, actionLabel, summary });

  // --- contract-scoped tables first (selector collisions resolved here) ---
  if (to === FISH_REWARD_ADDR) {
    if (sel === S.fishClaim) return R('reward-claim-fish', '報酬請求（FISH配布）', `報酬請求（FISH配布）${mintNote || '：FISH報酬コントラクトへ請求'}`);
    if (sel === S.fishDistribute) return R('reward-distribution-fish', 'FISH報酬の一括配布', `FISH報酬の一括配布（報酬コントラクト経由）${mintNote}`);
  }
  if (to === FISH_TOKEN_ADDR && sel === S.fishBurn) {
    return R('token-burn', 'FISHバーン（運営）', 'FISHのバーン処理（運営側の定期バーン関数）');
  }
  if (to === GUIDE_ADDR) {
    if (sel === S.flukeCommit) return R('fluke-commit', 'Fluke参加', 'Fluke参加（commit）');
    if (sel === S.flukeReveal) return R('fluke-reveal', 'Fluke めくる', 'Fluke めくる（reveal）');
    if (sel === S.flukeBoost) return R('fluke-boost', 'Flukeブースト', 'Flukeブースト（boost）');
    if (sel === S.flukeSettle) return R('fluke-settle', 'Fluke確定（Guide新規発行）', 'Fluke確定（settle）：Guideが新規発行されます');
    if (sel === S.flukeSeed) return R('fluke-seed', 'Flukeプール入金', 'Flukeの賞金プールへ入金（seed）');
    if (sel === S.guideWrite) return R('guide-write', 'Guideテキスト書き込み', 'Guideにテキストを書き込み（write）');
    if (sel === S.guideAppend) return R('guide-append', 'Guideテキスト追記', 'Guideにテキストを追記（append）');
  }
  if (to === STARLIGHT_ADDR) {
    if (sel === S.starlightRegister) return R('starlight-register', 'Starlight登録', 'StarlightにGuideを登録（register）');
    if (sel === S.starlightClaim || sel === S.starlightClaimToken) return R('reward-claim-starlight', 'Starlight報酬請求', `Starlight報酬請求（claim）${mintNote}`);
  }
  if (to === ST42_LIVE_ADDR || to === ST42_VAULT_ADDR) {
    if (sel === S.st42Deposit || sel === S.st42DepositTo) return R('st42-deposit', 'st42預け入れ', 'st42に預け入れ（deposit）');
    if (sel === S.st42RequestRedeem) return R('st42-redeem-request', 'st42引出申請', 'st42の引出を申請（requestRedeem）');
    if (sel === S.st42Claim || sel === S.st42ClaimTo) return R('st42-claim', 'st42受取', 'st42を受け取り（claim）');
    if (sel === S.st42InstantExit) return R('st42-instant-exit', 'st42即時出金', 'st42を即時出金（instantExit）');
  }
  if (to === ST42_BOOK_ADDR) {
    if (sel === S.bookPlaceBid) return R('st42-order', 'st42買い注文', 'st42注文板に買い注文（placeBid）');
    if (sel === S.bookPlaceAsk) return R('st42-order', 'st42売り注文', 'st42注文板に売り注文（placeAsk）');
    if (sel === S.bookMarketBuy) return R('st42-order', 'st42成行買い', 'st42注文板で成行買い（marketBuy）');
    if (sel === S.bookMarketSell) return R('st42-order', 'st42成行売り', 'st42注文板で成行売り（marketSell）');
    if (sel === S.bookCancel) return R('st42-order', 'st42注文キャンセル', 'st42注文をキャンセル（cancel）');
  }
  if (to === STAKING_PRECOMPILE) {
    if (sel === S.stakingDelegate) return R('delegate', '委任', 'ステーキングプリコンパイルで委任（delegate）');
    if (sel === S.stakingUndelegate) return R('undelegate', '委任解除', 'ステーキングプリコンパイルで委任解除（undelegate）');
    if (sel === S.stakingRedelegate) return R('redelegate', '委任先変更', 'ステーキングプリコンパイルで委任先変更（redelegate）');
  }
  if (to === DISTRIBUTION_PRECOMPILE && sel === S.distClaimRewards) {
    return R('reward-claim-staking', '報酬請求（ステーキング報酬）', `ステーキング報酬を請求（claimRewards／報酬配布プリコンパイル 0x0801）${mintNote}`);
  }
  if (BRIDGE_SEND_TARGETS.has(to) && sel === S.transferRemote) {
    // v0.2.3: bridge-out is USDT-only — only the USDT BridgeRouter's
    // transferRemote moves USDT; every other token router is a plain
    // bridge send of a non-USDT token.
    if (to === BRIDGE_ROUTER_USDT) return R('bridge-out', 'ブリッジ送信（USDT・外部へ）', 'ブリッジ送信（USDT・外部へ）：USDTをブリッジ経由で外部チェーンへ送金（transferRemote）');
    return R('bridge-send-other', 'ブリッジ送信（USDT以外）', 'ブリッジ送信（USDT以外）：USDT以外の銘柄をブリッジ経由で外部チェーンへ送金（transferRemote）');
  }
  if (to === MAILBOX_ADDR) {
    // A bare mailbox dispatch does not prove a USDT movement -> never bridge-out.
    if (sel === S.mailboxDispatch) return R('bridge-send-other', 'ブリッジ送信（USDT以外）', 'ブリッジ送信（USDT以外）：メールボックス経由でメッセージ送信（dispatch）');
    if (sel === S.mailboxProcess) return R('bridge-delivery', 'ブリッジ配送処理', 'ブリッジ配送の処理（Hyperlaneメールボックスの process）');
  }
  if (to === W42_ADDR) {
    if (sel === S.st42Deposit) return R('wrap', 'W42化（ラップ）', '[42]をW42に変換（deposit）');
    if (sel === S.w42Withdraw) return R('unwrap', 'W42解除', 'W42を[42]に戻す（withdraw）');
  }
  if (to === ROUTER) {
    if (ROUTER_SWAP_SELS.has(sel)) return R('dex-swap', 'DEXスワップ', 'DEXルーターでスワップ（詳細はログで判別できなかった呼び出し）');
    if (sel === S.routerAddLiq || sel === S.routerAddLiqETH) return R('lp-add', 'LP追加', 'DEXルーターで流動性提供の呼び出し');
    if (sel === S.routerRemoveLiq || sel === S.routerRemoveLiqETH) return R('lp-remove', 'LP解除', 'DEXルーターで流動性解除の呼び出し');
  }
  if (ctx.pairs[to]) {
    if (sel === S.pairSwap) return R('dex-swap', 'DEXスワップ', 'ペアでスワップ（swap）');
    if (sel === S.pairMint) return R('lp-add', 'LP追加', 'ペアに流動性提供（mint）');
    if (sel === S.pairBurn) return R('lp-remove', 'LP解除', 'ペアから流動性解除（burn）');
    if (sel === S.pairSkim) return R('dex-swap', 'ペア余剰回収', 'ペアの余剰分を回収（skim）');
    if (sel === S.pairSync) return R('dex-swap', 'ペア同期', 'ペアの準備金を同期（sync）');
  }
  // --- generic token / NFT standards (any destination) ---
  if (sel === S.approve) {
    const sym = tokenSymbolFor(ctx, to) ?? destDisp;
    let spender = null, amtNote = '';
    const data = (input ?? '').slice(10);
    if (data.length >= 128) {
      const spenderAddr = '0x' + data.slice(24, 64).toLowerCase();
      spender = destLabelFor(ctx, spenderAddr) ?? ('…' + spenderAddr.slice(-4).toUpperCase());
      const amt = BigInt('0x' + data.slice(64, 128));
      amtNote = amt === (2n ** 256n - 1n) ? '（無制限）' : '';
    }
    return R('approve', '使用許可（approve）', `${sym}の使用許可（approve）${spender ? `：${spender} に利用を許可` : ''}${amtNote}`);
  }
  if (sel === S.setApprovalForAll) return R('nft-approve-all', 'NFT一括使用許可', `NFTの一括使用許可（setApprovalForAll／宛先 ${destDisp}）`);
  if (sel === S.safeTransferFrom3 || sel === S.safeTransferFrom4 || sel === S.safeTransferFrom1155) {
    return R('nft-transfer', 'NFT送金', `NFTを送金（宛先 ${destDisp}）`);
  }
  if (sel === S.transfer || sel === S.transferFrom) return R('transfer', '送金・受取', `トークン送金の呼び出し（宛先 ${destDisp}）`);
  // --- honest fallback: never a bare "その他の操作" ---
  return R('unclassified', null, `未分類の操作（メソッド ${sel || '—'}／宛先 ${destDisp}）`);
}

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
  const out = { transfers: [], swaps: [], mints: [], burns: [], nftTransfers: [] };
  for (const log of receipt?.logs ?? []) {
    const t0 = log.topics?.[0];
    const emitter = lc(log.address);
    const li = typeof log.logIndex === 'string' ? parseInt(log.logIndex, 16) : (log.logIndex ?? 0);
    if (t0 === TOPIC.transfer && log.topics.length === 3) {
      out.transfers.push({ token: emitter, from: topicAddr(log.topics[1]), to: topicAddr(log.topics[2]), amountRaw: u256(log.data).toString(), logIndex: li });
    } else if (t0 === TOPIC.transfer && log.topics.length === 4) {
      // ERC-721 Transfer (tokenId in topic 3). Kept strictly separate from
      // the ERC-20 branch above (exactly-3-topics), so a Guide settle mint
      // was never misread as a fungible transfer — it simply fell through
      // to the generic method bucket before WS4.
      out.nftTransfers.push({ token: emitter, from: topicAddr(log.topics[1]), to: topicAddr(log.topics[2]), tokenId: u256(log.topics[3]).toString(), logIndex: li });
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
    // always count (validators are people, never core — v0.3.2 user
    // correction for Xenia), and the #1 holder 0x7a6f...0a25
    // (distributor-type core, but a real actor).
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
  // v0.3.2 repair: core flags are re-derived from the CURRENT watchlist on
  // every migration pass, so a reclassification reaches stored events.
  // (Xenia's stored events carried actorIsCore/counterpartyIsCore=true from
  // the overturned distributor-type ruling; her entry is isCore=false now.)
  set('actorIsCore', !!ae?.isCore);
  const ce0 = ev.counterparty ? ctx.entry(ev.counterparty) : null;
  set('counterpartyIsCore', !!ce0?.isCore);
  // v0.4.1: actor depth, re-derived from the CURRENT watchlist on every
  // migration pass (same repair mechanism as the core flags). The bridge-out
  // totals chart segments each name's bar by this depth: validator itself
  // = 0; a related entry's explicit depth (closure entries carry theirs);
  // an original related entry without an explicit depth = 1; anything else
  // (core / unknown / estimated) = null.
  set('actorDepth', ae?.tier === 'validator' ? 0 : (ae?.depth ?? (ae?.tier === 'related' ? 1 : null)));
  // v0.4.2: depth>=2 related actors carry their wallet-evidence codes
  // (why they are tracked at all); null for everyone else.
  set('actorEvidence', ae?.tier === 'related' && (ae?.depth ?? 1) >= 2 ? (ae.evidence ?? null) : null);
  const rel = ae?.tier === 'validator' ? [] : [...(ae?.relatedValidators ?? [])];
  set('actorValidators', rel);
  set('actorShared', ev.actorTier !== 'validator' && rel.length >= 3);
  set('actorContractNote', KNOWN_CONTRACTS[lc(ev.actor)] ?? null);
  // WS4 migration: reclassify stored method-call events (the old bare
  // 'other-contract' bucket, and any already-classified method type) from
  // their stored (counterparty, method) pair. Amount enrichment from mint
  // logs is not available for stored events (receipts are not stored), so
  // their summaries carry no claimed amount — the live path adds it.
  if (ev.chain !== 'cosmos' && ev.method && ev.counterparty && METHOD_EVENT_TYPES.has(ev.type) && (ev.type === 'other-contract' || !('actionLabel' in ev))) {
    const cls = classifyMethodCall(ctx, ev.counterparty, ev.method);
    set('type', cls.type);
    set('actionLabel', cls.actionLabel);
    set('destLabel', destLabelFor(ctx, ev.counterparty));
    set('summary', cls.summary);
    if (cls.type === 'bridge-out' && !(ev.notableReasons ?? []).includes('bridge-out')) {
      set('notableReasons', [...(ev.notableReasons ?? []), 'bridge-out']);
    }
  }
  // WS5 migration (v0.2.3: USDT-only): a stored plain transfer OUT of USDT
  // to a known bridge contract is a bridge-out. (Inbound receipts stay
  // plain transfers; non-USDT sends are handled by the demotion below.)
  if (ev.chain !== 'cosmos' && ev.type === 'transfer' && ev.direction === 'out' && ev.to && BRIDGE_SEND_TARGETS.has(lc(ev.to)) && ev.amount?.symbol === 'USDT') {
    set('type', 'bridge-out');
    set('summary', `ブリッジで外部へ送信：${ev.amount?.amount ?? ''} ${ev.amount?.symbol ?? ''} をブリッジ経由で外部チェーンへ`);
    if (!(ev.notableReasons ?? []).includes('bridge-out')) set('notableReasons', [...(ev.notableReasons ?? []), 'bridge-out']);
  }
  // v0.2.3 demotion: any stored 'bridge-out' that is NOT a USDT movement
  // becomes a plain 'bridge-send-other' record (no green section, no
  // 'bridge-out' notable marker). USDT-ness is decided by the moved
  // token's symbol; amount-less method-call events keep bridge-out only
  // when they are a transferRemote call to the USDT BridgeRouter itself.
  if (ev.chain !== 'cosmos' && ev.type === 'bridge-out') {
    let isUsdt;
    if (ev.amount?.symbol) isUsdt = ev.amount.symbol === 'USDT';
    else if (ev.method && ev.counterparty) isUsdt = lc(ev.counterparty) === BRIDGE_ROUTER_USDT && ev.method === S.transferRemote;
    else isUsdt = false;
    if (!isUsdt) {
      set('type', 'bridge-send-other');
      set('summary', `ブリッジ送信（USDT以外）：${ev.amount?.amount ?? ''} ${ev.amount?.symbol ?? ''} をブリッジ経由で外部チェーンへ`);
      set('notableReasons', (ev.notableReasons ?? []).filter((r) => r !== 'bridge-out'));
    }
  }
  // WS4b migration: Cosmos reward/commission summaries get the fixed
  // reward-claim labels (amounts already stored on the events).
  if (ev.chain === 'cosmos' && ev.type === 'reward') {
    set('actionLabel', '報酬請求（委任報酬）');
    const vName = ev.counterparty ? (ctx.entry(ev.counterparty)?.label ?? `バリデーター …${ev.counterparty.slice(-4).toUpperCase()}`) : '';
    set('summary', `報酬請求（委任報酬）：${vName} 分${ev.amount ? ` ${ev.amount.amount} [42]` : ''}`);
  }
  if (ev.chain === 'cosmos' && ev.type === 'commission') {
    set('actionLabel', 'バリデーター報酬請求（コミッション）');
    set('summary', `バリデーター報酬請求（コミッション）${ev.amount ? `：${ev.amount.amount} [42]` : ''}`);
  }
  if ((ev.type === 'swap-buy' || ev.type === 'lp-add') && ev.pair) {
    const c = creations[lc(ev.pair)];
    if (c?.createdTs) {
      set('pairCreatedTs', c.createdTs);
      const age = ev.ts - c.createdTs;
      set('pairAgeSecs', age);
      // v0.2.4 (Part D, user rule): snipes are BUYS ONLY — an LP add never
      // counts as a snipe, however fresh the pair is.
      // v0.4.0: the snipe definition also says SELF or DIRECTLY related —
      // recursive closure entries (depth >= 2) do not snipe-flag.
      const snipeActor = ae?.tier === 'validator' || (ae?.tier === 'related' && (ae.depth ?? 1) <= 1);
      set('isSnipe', ev.type === 'swap-buy' && snipeActor && age >= 0 && age <= SNIPE_WINDOW_SECS);
    }
  }
  // Part D demotion: a stored non-buy event that still carries the old
  // (pre-v0.2.4) snipe flag loses it. The event itself is kept as a normal
  // record — only the flag is removed.
  if (ev.type !== 'swap-buy' && ev.isSnipe) set('isSnipe', false);
  // v0.2.4 (Part C): insider flag for the ⚠ Insider section (validator X).
  // v0.4.0: pair-created events are never insider/snipe material.
  set('isInsider', ev.type === 'pair-created' ? false : isInsiderEvent(ev, ctx));
  // v0.3.0 (Phase 3): estimated tier guard. An estimated actor's events keep
  // the 推定 tag + the concrete basis from the watchlist entry, and NEVER
  // carry the confirmed-only markers: no snipe, no insider, no bridge-out
  // (its bridge sends are demoted to the plain bridge-send-other type, so
  // the USDT totals chart cannot include them), no shared-counterparty
  // badge, and no feed pinning (selectFeedEvents pins on those flags).
  const estEntry = ctx.entry(ev.actor);
  if (estEntry?.tier === 'estimated') {
    if (ev.actorTier !== 'estimated') set('actorTier', 'estimated');
    const basis = { type: estEntry.basisType, validators: estEntry.relatedValidators ?? [], text: estEntry.basisText ?? '', textEn: estEntry.basisTextEn ?? '' };
    if (JSON.stringify(ev.estimateBasis) !== JSON.stringify(basis)) { ev.estimateBasis = basis; changed = true; }
    if (ev.isSnipe) set('isSnipe', false);
    if (ev.isInsider) set('isInsider', false);
    if (ev.actorShared) set('actorShared', false);
    if (ev.type === 'bridge-out') {
      set('type', 'bridge-send-other');
      if (typeof ev.summary === 'string') set('summary', ev.summary.replace('ブリッジで外部へ送信：', 'ブリッジで外部へ送信（推定アドレスのため特別欄の対象外）：'));
    }
    if ((ev.notableReasons ?? []).includes('bridge-out')) set('notableReasons', ev.notableReasons.filter((r) => r !== 'bridge-out'));
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

  // ---- NFT (ERC-721) transfers & mints ----
  // A mint (from 0x0) becomes an nft-mint event with collection + tokenId
  // (e.g. a Fluke settle minting a new Guide). Ordinary ERC-721 transfers
  // become nft-transfer. If a watched actor is involved these are the
  // informative events of the tx, so they take precedence over the generic
  // method bucket; fungible legs of the same tx are not double-recorded.
  for (const t of dec.nftTransfers) {
    const isMint = t.from === ZERO, isBurn = t.to === ZERO;
    const actor = isMint ? (ctx.isActor(t.to) ? lc(t.to) : null)
      : isBurn ? (ctx.isActor(t.from) ? lc(t.from) : null)
      : transferActor(t.from, t.to);
    if (!actor) continue;
    const coll = NFT_COLLECTIONS[t.token];
    const collName = coll?.name ?? ctx.entry(t.token)?.label ?? tokenSymbolFor(ctx, t.token) ?? ('NFT …' + t.token.slice(-4).toUpperCase());
    const outgoing = actor === t.from;
    const type = isMint ? 'nft-mint' : 'nft-transfer';
    const ev = baseEvent(ctx, txN, blockTs, actor, isMint ? t.token : (outgoing ? t.to : t.from), type, t.logIndex);
    ev.direction = isMint ? 'in' : (outgoing ? 'out' : 'in');
    ev.nft = { collection: t.token, collectionName: collName, tokenId: t.tokenId };
    ev.from = t.from; ev.to = t.to;
    ev.tokens = [coll?.symbol ?? collName];
    ev.whitelisted = true;
    ev.summary = isMint ? `NFTミント：${collName} #${t.tokenId} を新規発行で受取`
      : isBurn ? `NFTバーン：${collName} #${t.tokenId}`
      : outgoing ? `NFT送金：${collName} #${t.tokenId} を送金` : `NFT受取：${collName} #${t.tokenId} を受取`;
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
      // WS5 (corrected) + v0.2.3: sending TO a known bridge contract is a
      // bridge send, but only a USDT movement is a 'bridge-out' (green
      // section); other tokens are plain 'bridge-send-other' records.
      // Receiving FROM a bridge contract stays a plain inbound transfer.
      const bridgeTarget = outgoing && BRIDGE_SEND_TARGETS.has(t.to);
      const bridgeOut = bridgeTarget && lc(t.token) === USDT_TOKEN;
      const evType = bridgeOut ? 'bridge-out' : bridgeTarget ? 'bridge-send-other' : 'transfer';
      const ev = baseEvent(ctx, txN, blockTs, actor, outgoing ? t.to : t.from, evType, t.logIndex);
      ev.direction = outgoing ? 'out' : 'in';
      ev.amount = amountObj(ctx, t.token, t.amountRaw);
      ev.from = t.from; ev.to = t.to;
      ev.tokens = [ev.amount.symbol];
      ev.whitelisted = ev.amount.whitelisted;
      ev.summary = bridgeOut
        ? `ブリッジで外部へ送信：${ev.amount.amount} ${ev.amount.symbol} をブリッジ経由で外部チェーンへ`
        : bridgeTarget
          ? `ブリッジ送信（USDT以外）：${ev.amount.amount} ${ev.amount.symbol} をブリッジ経由で外部チェーンへ`
          : outgoing ? `${ev.amount.amount} ${ev.amount.symbol} を送金` : `${ev.amount.amount} ${ev.amount.symbol} を受取`;
      ev.notableReasons = notableReasons(ev);
      if (bridgeOut && !ev.notableReasons.includes('bridge-out')) ev.notableReasons.push('bridge-out');
      events.push(ev);
    }
    const value = BigInt(tx.value ?? '0x0');
    if (value > 0n) {
      const actor = transferActor(from, to);
      if (actor) {
        const outgoing = actor === from;
        // Native value is always [42], never USDT -> never bridge-out
        // (v0.2.3); a native send to a bridge contract is bridge-send-other.
        const bridgeTarget = outgoing && !!to && BRIDGE_SEND_TARGETS.has(to);
        const bridgeOut = false;
        const ev = baseEvent(ctx, txN, blockTs, actor, outgoing ? to : from, bridgeTarget ? 'bridge-send-other' : 'transfer', null);
        ev.direction = outgoing ? 'out' : 'in';
        ev.amount = amountObj(ctx, W42, value.toString());
        ev.from = from; ev.to = to;
        ev.tokens = ['42'];
        ev.whitelisted = true;
        ev.summary = bridgeTarget
          ? `ブリッジ送信（USDT以外）：${ev.amount.amount} [42] をブリッジ経由で外部チェーンへ`
          : outgoing ? `${ev.amount.amount} [42] を送金` : `${ev.amount.amount} [42] を受取`;
        ev.notableReasons = notableReasons(ev);
        if (bridgeOut && !ev.notableReasons.includes('bridge-out')) ev.notableReasons.push('bridge-out');
        events.push(ev);
      }
    }
    if (events.length) return events;
  }

  // ---- method call by a watched sender (WS4 concrete classification) ----
  if (from && ctx.isActor(from) && to && (tx.input ?? '0x') !== '0x') {
    // Tokens minted TO the sender in this same tx (e.g. a FISH reward claim
    // mints the claimed amount) enrich the summary with the real amount.
    const mintAmounts = [];
    for (const t of dec.transfers) {
      if (t.from !== ZERO || t.to !== from) continue;
      const a = amountObj(ctx, t.token, t.amountRaw);
      mintAmounts.push({ symbol: a.symbol, amount: a.amount });
    }
    const cls = classifyMethodCall(ctx, to, tx.input, mintAmounts);
    const ev = baseEvent(ctx, txN, blockTs, from, to, cls.type, null);
    ev.method = (tx.input ?? '').slice(0, 10).toLowerCase();
    ev.actionLabel = cls.actionLabel;
    ev.destLabel = destLabelFor(ctx, to);
    ev.tokens = [];
    ev.whitelisted = true;
    ev.summary = cls.summary;
    ev.notableReasons = [];
    if (cls.type === 'bridge-out') ev.notableReasons.push('bridge-out');
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
        ev.actionLabel = '報酬請求（委任報酬）';
        ev.summary = `報酬請求（委任報酬）：${ctx.entry(validator)?.label ?? `バリデーター …${validator.slice(-4).toUpperCase()}`} 分${ev.amount ? ` ${ev.amount.amount} [42]` : ''}`;
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
        ev.actionLabel = 'バリデーター報酬請求（コミッション）';
        ev.summary = `バリデーター報酬請求（コミッション）${ev.amount ? `：${ev.amount.amount} [42]` : ''}`;
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
          const [b, tx] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['0x' + blk.toString(16), false] }, { method: 'eth_getTransactionByHash', params: [h] }]);
          if (b?.timestamp) return save({ createdBlock: blk, createdTs: parseInt(b.timestamp, 16), source: 'blockscout-creation-tx', txHash: lc(h), creator: tx?.from ? lc(tx.from) : null });
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
          const [b, tx] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['0x' + blk.toString(16), false] }, { method: 'eth_getTransactionByHash', params: [log.transactionHash] }]);
          if (b?.timestamp) return save({ createdBlock: blk, createdTs: parseInt(b.timestamp, 16), source: 'factory-paircreated-log', txHash: lc(log.transactionHash), creator: tx?.from ? lc(tx.from) : null });
        }
      }
    }
  } catch { /* leave unresolved; a later run can retry */ }
  return null;
}
// Resolve a pair's FIRST Mint (v0.4.0, for the 新規ペア速報 section's
// 「最初の流動性」). Scans Mint logs on the pair from its creation block,
// at most 200k blocks forward (~12 days — pairs that ever get used are
// minted on almost immediately; a pair with no mint in that window is
// recorded as firstMint null, never guessed). Cached in pairs-creation.json.
async function resolveFirstMint(pairAddr, creations, creationsPath) {
  pairAddr = lc(pairAddr);
  const info = creations[pairAddr];
  if (!info?.createdTs || 'firstMint' in info) return info?.firstMint ?? null;
  const save = (v) => { info.firstMint = v; writeFileSync(creationsPath, JSON.stringify(creations, null, 1)); return v; };
  try {
    const tip = Number(BigInt(await rpcOne('eth_blockNumber', [])));
    const last = Math.min(tip, info.createdBlock + 200000);
    for (let start = info.createdBlock; start <= last; start += 10000) {
      const end = Math.min(last, start + 9999);
      const logs = (await rpcBatch([{ method: 'eth_getLogs', params: [{ address: pairAddr, topics: [TOPIC.mint], fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }] }]))[0];
      if (logs?.length) {
        const log = logs[0];
        const blk = parseInt(log.blockNumber, 16);
        const [b] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['0x' + blk.toString(16), false] }]);
        const d = String(log.data).slice(2);
        return save({ block: blk, ts: b?.timestamp ? parseInt(b.timestamp, 16) : info.createdTs, txHash: lc(log.transactionHash), a0: u256('0x' + d.slice(0, 64)).toString(), a1: u256('0x' + d.slice(64, 128)).toString() });
      }
    }
  } catch { /* leave unresolved; a later run can retry */ }
  return null;
}
// Register a pair created by the Don't Panic factory (live detection):
// creation record + pair tokens in ctx/cache + a core-side watchlist
// entry, so the pair is core infrastructure (never a "related wallet",
// never auto-added, never a new face).
function registerCreatedPair(ctx, watchlist, pairsCache, cachePath, creations, creationsPath, { pair, token0, token1, block, ts, txHash, creator }) {
  pair = lc(pair);
  if (!creations[pair]) {
    creations[pair] = { createdBlock: block, createdTs: ts, source: 'factory-paircreated-log', txHash: txHash ? lc(txHash) : null, creator: creator ? lc(creator) : null };
    writeFileSync(creationsPath, JSON.stringify(creations, null, 1));
  }
  if (!ctx.pairs[pair]) {
    ctx.pairs[pair] = { token0: lc(token0), token1: lc(token1) };
    pairsCache[pair] = ctx.pairs[pair];
    writeFileSync(cachePath, JSON.stringify(pairsCache, null, 1));
  }
  if (!ctx.watch.has(pair)) {
    const i0 = ctx.tokenInfo(token0), i1 = ctx.tokenInfo(token1);
    const entry = { address: pair, tier: 'core', label: `${i0.symbol}/${i1.symbol} ペア`, isCore: true, isPair: true, watch: false, validators: [], relatedValidators: [] };
    watchlist.entries.push(entry);
    ctx.watch.set(pair, entry);
  }
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

// ---------------- validator-list auto-refresh (Phase 3 / v0.3.0) ----------------
// The bonded validator set is read from the chain itself: an abci_query of
// /cosmos.staking.v1beta1.Query/Validators with an EMPTY request returns all
// validators with their status (3 = BONDED) and description.moniker, and the
// operator address (bech32 valoper) decodes to the same 20 bytes as the
// account address. Verified live 2026-11-05: 25 validators total, 23 bonded,
// exactly the watchlist's 23 (monikers all matching).
export async function fetchChainValidators() {
  const res = await cometOne('abci_query', { path: '/cosmos.staking.v1beta1.Query/Validators', data: '', prove: false });
  const valueB64 = res?.response?.value;
  if (!valueB64) throw new Error('abci_query Validators: empty response value');
  const top = parseProto(Buffer.from(valueB64, 'base64'));
  const out = [];
  for (const vf of top.filter((f) => f.field === 1 && f.wire === 2)) {
    const f = parseProto(vf.value);
    const operator = pfS(f, 1)[0];
    if (!operator) continue;
    const status = Number(f.find((x) => x.field === 4 && x.wire === 0)?.value ?? 0n);
    const descBytes = pfB(f, 7)[0];
    const moniker = descBytes ? (pfS(parseProto(descBytes), 1)[0] ?? '') : '';
    let address;
    try { address = lc(bech32ToHex(operator)); } catch { continue; }
    out.push({ address, operator, moniker, status, bonded: status === 3 });
  }
  return out;
}

const shortAddrLabel = (a) => '0x' + a.slice(2, 6).toUpperCase() + '…' + a.slice(-4).toUpperCase();

// Compare the watchlist's validator tier with the chain's CURRENT bonded
// set. New bonded validators are appended as self-tier entries (moniker
// from chain data; a short-address label when the chain has no moniker —
// never an invented name). Validators no longer bonded stay watched and
// are marked inactive. Nothing is ever removed. Persists watchlist.json
// only when something changed. Returns { added, bonded, total, changed }.
export async function refreshValidatorList(watchlist, { fetchValidators = fetchChainValidators, log = console.log, persist = true } = {}) {
  const chain = await fetchValidators();
  const bonded = chain.filter((v) => v.bonded);
  const bondedSet = new Set(bonded.map((v) => v.address));
  const byAddr = new Map(watchlist.entries.map((e) => [e.address, e]));
  const added = [];
  let changed = false;
  for (const v of bonded) {
    if (byAddr.has(v.address)) continue;
    const label = v.moniker || shortAddrLabel(v.address);
    const entry = { address: v.address, tier: 'validator', label, isCore: false, isPair: false, watch: true, operator: v.operator, validators: [label], relatedValidators: [], autoAdded: new Date().toISOString().slice(0, 10) };
    watchlist.entries.push(entry);
    byAddr.set(v.address, entry);
    added.push(label);
    changed = true;
    log(`[collector] validator auto-added from chain: ${label} (${v.address}, operator ${v.operator})`);
  }
  for (const e of watchlist.entries) {
    if (e.tier !== 'validator') continue;
    const inactive = !bondedSet.has(e.address);
    if (inactive && !e.inactive) { e.inactive = true; changed = true; log(`[collector] validator no longer bonded — kept watched, marked inactive: ${e.label} (${e.address})`); }
    if (!inactive && e.inactive) { delete e.inactive; changed = true; log(`[collector] validator bonded again — inactive mark removed: ${e.label} (${e.address})`); }
  }
  const s = (watchlist.summary ??= {});
  s.validators = watchlist.entries.filter((e) => e.tier === 'validator').length;
  s.watchedActors = watchlist.entries.filter((e) => e.watch).length;
  s.totalEntries = watchlist.entries.length;
  if (changed && persist) writeFileSync(join(__dir, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
  return { added, bonded: bonded.length, total: chain.length, changed };
}

// Feed selection: the latest 500 events, PLUS pinned categories
// (deduplicated, sort order preserved). Snipe / bridge-out / insider events
// are pinned without a cap (they feed the ⚠/🎯/🌉 sections and the
// historical backfills must stay visible permanently). v0.4.0 adds capped
// pins for the new sections: pair-created (latest 100), LP moves (latest
// 150), dormant returns (latest 200 — the flags are rare by construction),
// and new-counterparty first appearances (latest 100).
export function selectFeedEvents(sorted) {
  const head = sorted.slice(0, 500);
  const seenIds = new Set(head.map((e) => e.id));
  const take = (pred, cap) => {
    const out = [];
    for (const e of sorted) {
      if (out.length >= cap) break;
      if (!seenIds.has(e.id) && pred(e)) { seenIds.add(e.id); out.push(e); }
    }
    return out;
  };
  const pinned = sorted.filter((e) => (e.isSnipe || e.type === 'bridge-out' || e.isInsider) && !seenIds.has(e.id));
  for (const e of pinned) seenIds.add(e.id);
  return [
    ...head, ...pinned,
    ...take((e) => e.type === 'pair-created', 100),
    ...take((e) => (e.type === 'lp-add' || e.type === 'lp-remove') && e.actorTier !== 'estimated', 150),
    ...take((e) => !!e.isDormantReturn, 200),
    ...take((e) => !!e.isNewCounterparty, 100),
  ];
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
  const pairsSync = args.includes('--pairs-sync'); // v0.4.0: pair-created sync only, uncapped
  const pollMs = Number(process.env.POLL_MS ?? 10000);

  const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
  // Phase 3: refresh the validator tier from the chain BEFORE the ctx is
  // built, so a validator that bonded since the last run is watched from
  // this run on. A chain/RPC failure never blocks collection — the stored
  // watchlist is used as-is and the refresh retries next run.
  let validatorRefresh = null;
  try {
    validatorRefresh = await refreshValidatorList(watchlist);
    console.log(`[collector] validator auto-refresh: chain ${validatorRefresh.total} validators / ${validatorRefresh.bonded} bonded; watchlist ${watchlist.summary.validators} self-tier; added this run: ${validatorRefresh.added.length ? validatorRefresh.added.join(', ') : 'none'}`);
  } catch (e) {
    console.error('[collector] validator auto-refresh failed (continuing with stored watchlist):', e.message);
  }
  const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
  const cachePath = join(__dir, 'pairs-cache.json');
  const pairsCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const creationsPath = join(__dir, 'pairs-creation.json');
  const creations = existsSync(creationsPath) ? JSON.parse(readFileSync(creationsPath, 'utf8')) : {};
  const ctx = makeCtx(watchlist, registries, pairsCache);
  // v0.4.0: exclusion set for auto-add / new faces (static inputs; pairs
  // created live during the run are added to it as they are registered).
  const excluded = buildExcludedSet(watchlist, registries);
  let watchlistDirty = false;
  const persistWatchlist = () => {
    if (!watchlistDirty) return;
    recomputeWatchlistSummary(watchlist);
    writeFileSync(join(__dir, 'watchlist.json'), JSON.stringify(watchlist, null, 1));
    watchlistDirty = false;
    console.log(`[collector] watchlist updated: ${watchlist.entries.length} entries (related ${watchlist.summary.related}, auto-added ${watchlist.summary.autoAdded})`);
  };
  // v0.4.0: [42] price from the 42/USDT pair reserves (getReserves), with a
  // local price history for the ~24h change. The pool is small, so the
  // figure is labelled an estimate on the site.
  const priceHistoryPath = join(__dir, 'price-history.jsonl');
  let priceInfo = null;
  async function refreshPrice() {
    try {
      const [res] = await rpcBatch([{ method: 'eth_call', params: [{ to: PAIR_42_USDT, data: '0x0902f1ac' }, 'latest'] }]);
      if (!res || res === '0x') return;
      const r0 = u256('0x' + res.slice(2, 66)); // token0 = USDT
      const r1 = u256('0x' + res.slice(66, 130)); // token1 = [42] (0xeeee)
      if (r1 === 0n) return;
      const price = Number((r0 * 100000000n) / r1) / 1e8;
      const now = Math.floor(Date.now() / 1000);
      let hist = [];
      if (existsSync(priceHistoryPath)) hist = readFileSync(priceHistoryPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const last = hist[hist.length - 1];
      if (!last || now - last.ts >= 240) { appendFileSync(priceHistoryPath, JSON.stringify({ ts: now, price }) + '\n'); hist.push({ ts: now, price }); }
      let old = null;
      for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].ts <= now - 86400) { old = hist[i]; break; } }
      priceInfo = { usdt: price, updatedAt: new Date(now * 1000).toISOString(), change24hPct: old ? Math.round(((price - old.price) / old.price) * 10000) / 100 : null };
    } catch (e) { console.error('[collector] price refresh failed (continuing):', e.message); }
  }

  const statePath = join(__dir, 'state.json');
  const eventsPath = join(__dir, 'events.jsonl');
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { lastProcessedBlock: null, totalBlocksScanned: 0, totalTxsScanned: 0, totalEventsFound: 0, updatedAt: null };
  if (state.lastProcessedCosmosBlock === undefined) state.lastProcessedCosmosBlock = null;
  const allEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // v0.4.2: permanently excluded actors (env-supplied, see
  // excludedActorsFromEnv) never keep stored events: purge any that are
  // present (e.g. recorded before the exclusion took effect) on every run.
  const permExcluded = excludedActorsFromEnv();
  if (permExcluded.size) {
    const beforePurge = allEvents.length;
    for (let i = allEvents.length - 1; i >= 0; i--) if (permExcluded.has(lc(allEvents[i].actor))) allEvents.splice(i, 1);
    if (allEvents.length !== beforePurge) {
      writeFileSync(eventsPath, allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
      console.log(`[collector] migration: dropped ${beforePurge - allEvents.length} stored events by permanently excluded actors`);
    }
  }
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
  for (const e of allEvents) if (METHOD_EVENT_TYPES.has(e.type) && e.method) lastOtherByKey.set(`${e.actor}|${e.counterparty}|${e.method}`, Math.max(e.block ?? 0, lastOtherByKey.get(`${e.actor}|${e.counterparty}|${e.method}`) ?? 0));

  const saveState = () => { state.updatedAt = new Date().toISOString(); writeFileSync(statePath, JSON.stringify(state, null, 1)); };
  function writeFeed(latestBlock) {
    const sorted = [...allEvents].sort((a, b) => (b.block - a.block) || ((b.logIndex ?? -1) - (a.logIndex ?? -1)));
    const validators = watchlist.entries.filter((e) => e.tier === 'validator').map((v) => ({
      moniker: v.label, address: v.address, bech32: hexToBech32(v.address), isCore: v.isCore,
      relatedCount: watchlist.entries.filter((e) => e.tier === 'related' && e.relatedValidators.includes(v.label)).length,
      selfActivity: allEvents.filter((e) => e.actor === v.address).length,
      // v0.5.2: "related activity" = activity BY the validator's related
      // addresses only (the actor's own relations). The old validatorNames
      // union also swept in fellow validators' events (validator<->validator
      // links, e.g. Xenia's 2-[42] seeds) and counterparty-side mentions;
      // those are not the related addresses' activity and no longer count.
      relatedActivity: allEvents.filter((e) => e.actor !== v.address && (e.actorValidators ?? []).includes(v.label)).length,
      autoAddedCount: watchlist.entries.filter((e) => e.autoAdded && e.relatedValidators.includes(v.label)).length,
      estimatedCount: watchlist.entries.filter((e) => e.tier === 'estimated' && e.relatedValidators.includes(v.label)).length,
      ...(v.inactive ? { inactive: true } : {}),
    }));
    const feed = {
      generatedAt: new Date().toISOString(),
      status: {
        lastProcessedBlock: state.lastProcessedBlock, latestBlockSeen: latestBlock ?? null,
        lastProcessedCosmosBlock: state.lastProcessedCosmosBlock ?? null,
        lastProcessedAt: state.updatedAt, totalEvents: allEvents.length,
        watchSummary: watchlist.summary,
        notableRule: `注目ルール：①バリデーター本人の売買 ②${NOTABLE_42_THRESHOLD.toLocaleString()} [42]以上の移動（ブリッジで外部へ送信は専用の緑色の欄に分けて表示）`,
        snipeRule: SNIPE_RULE,
        bridgeOutRule: BRIDGE_OUT_RULE,
        insiderRule: INSIDER_RULE,
        estimatedRule: ESTIMATED_RULE,
        dormantRule: DORMANT_RULE,
        ...(validatorRefresh ? {
          chainValidators: { bonded: validatorRefresh.bonded, total: validatorRefresh.total, checkedAt: new Date().toISOString() },
          ...(validatorRefresh.added.length ? { validatorsAdded: validatorRefresh.added } : {}),
        } : {}),
        actionRule: '操作の種類は、宛先コントラクトとメソッドから判別できた範囲で具体名を表示します（Fluke参加・NFTミント・報酬請求など）。判別できないものは「未分類の操作（メソッド／宛先）」と正直に表示します。',
        ...(priceInfo ? { price: priceInfo } : {}),
      },
      stats: { staking: computeStakingStats(allEvents, ctx), bridge: computeBridgeChart(allEvents, ctx) },
      validators,
      events: selectFeedEvents(sorted),
    };
    writeFileSync(join(__dir, 'feed.json'), JSON.stringify(feed, null, 1));
    return feed;
  }

  // v0.4.0: deterministic history flags (dormant returns / new
  // counterparties) over the full stored history; rewrites events.jsonl
  // only when a flag actually changed.
  function refreshHistoryFlags() {
    const r = computeHistoryFlags(allEvents, ctx);
    if (r.changed) {
      writeFileSync(eventsPath, allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
      console.log(`[collector] history flags: ${r.changed} fields updated (dormant returns ${r.dormantCount}, longest ${r.longestDays}d; new-counterparty events ${r.newfaceCount})`);
    }
    return r;
  }
  // v0.4.0: pair-created events for every Don't Panic factory pair whose
  // creation is known (or resolvable within the op budget). Creations
  // entries gain txHash/creator/firstMint as they are resolved.
  const initialCheckpoint = state.lastProcessedBlock;
  async function syncPairEvents(cap = 6) {
    let ops = 0, added = 0;
    const candidates = Object.keys(ctx.pairs).filter((p) => {
      const reg = registries.pairs[p];
      return !reg?.factory || lc(reg.factory) === FACTORY; // Don't Panic factory pairs only
    }).sort((a, b) => (creations[a]?.createdBlock ?? Infinity) - (creations[b]?.createdBlock ?? Infinity));
    for (const pairAddr of candidates) {
      let info = creations[pairAddr];
      if (!info?.createdTs) {
        if (ops >= cap) continue;
        ops++;
        info = await resolvePairCreation(pairAddr, creations, creationsPath).catch(() => null);
        if (!info) continue;
      }
      if (info.createdTs && !info.txHash && ops < cap) {
        ops++;
        // cached entries from before v0.4.0 lack the creation tx: re-resolve
        // the tx hash + creator via Blockscout once.
        try {
          const r = await fetch(`${BLOCKSCOUT}/addresses/${pairAddr}`, { headers: { 'User-Agent': UA } });
          if (r.ok) {
            const j = await r.json();
            if (j.creation_transaction_hash) {
              const [tx] = await rpcBatch([{ method: 'eth_getTransactionByHash', params: [j.creation_transaction_hash] }]);
              info.txHash = lc(j.creation_transaction_hash);
              info.creator = tx?.from ? lc(tx.from) : null;
              writeFileSync(creationsPath, JSON.stringify(creations, null, 1));
            }
          }
        } catch { /* leave for a later run */ }
      }
      if (!('firstMint' in info) && ops < cap) { ops++; await resolveFirstMint(pairAddr, creations, creationsPath).catch(() => null); }
      const id = `pair-created:${pairAddr}`;
      if (seen.has(id)) continue;
      const ev = buildPairCreatedEvent(ctx, pairAddr, info, info.firstMint ?? null);
      if (!ev) continue;
      enrichEvent(ev, ctx, creations);
      if (initialCheckpoint != null && info.createdBlock <= initialCheckpoint) ev.backfill = true;
      seen.add(ev.id); allEvents.push(ev);
      appendFileSync(eventsPath, JSON.stringify(ev) + '\n');
      added++;
    }
    if (added) { state.totalEventsFound = allEvents.length; saveState(); console.log(`[collector] pair-created events: +${added} (total events ${allEvents.length})`); }
    return added;
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
          // v0.4.0: a PairCreated log from the Don't Panic factory registers
          // the new pair immediately (creation record + core-side entry),
          // so this same tx's first swap/LP classifies against it and the
          // pair itself is never treated as a new counterparty.
          for (const log of receipt.logs ?? []) {
            if (lc(log.address) === FACTORY && log.topics?.[0] === PAIR_CREATED_TOPIC) {
              const pairAddr = '0x' + String(log.data).slice(26, 66).toLowerCase();
              registerCreatedPair(ctx, watchlist, pairsCache, cachePath, creations, creationsPath, {
                pair: pairAddr, token0: topicAddr(log.topics[1]), token1: topicAddr(log.topics[2]),
                block: meta.block, ts: meta.ts, txHash: meta.tx.hash, creator: meta.tx.from,
              });
              excluded.add(pairAddr);
              watchlistDirty = true;
              console.log(`[collector] new pair registered: ${pairAddr} (block ${meta.block})`);
            }
          }
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
            if (isPermanentlyExcluded(ev.actor)) continue; // v0.4.2: excluded actors are never recorded
            // Repetition suppression for METHOD-CALL events ONLY (the WS4
            // successors of "other-contract", counted/reported under their
            // detailed classification names): a keeper-like related address
            // (0xbfc5…4f29, 43k+ txs in the flowmap snapshot) repeats the
            // same call every few blocks and would flood the feed.
            // Transfers / swaps / LP / NFT events are NEVER suppressed
            // (standing rule: watched transfers are tracked no matter how
            // small/frequent).
            if (METHOD_EVENT_TYPES.has(ev.type)) {
              const key = `${ev.actor}|${ev.counterparty}|${ev.method}`;
              const last = lastOtherByKey.get(key);
              if (last != null && meta.block - last < OTHER_REPEAT_WINDOW_BLOCKS) continue;
              lastOtherByKey.set(key, meta.block);
            }
            // v0.4.0 live auto-add: a first-appearance counterparty of a
            // confirmed watched wallet joins the watchlist on the spot
            // (recursive — auto-added wallets trigger adds themselves).
            // Runs BEFORE the append so the watchlistAdded marker is
            // persisted with the event itself.
            // v0.4.2: bytecode-gated — a contract counterparty is
            // registered on the core side instead of becoming a related
            // wallet (see maybeAutoAddLive).
            const addRes = await maybeAutoAddLive(watchlist, ctx, ev, excluded, { events: allEvents });
            if (addRes?.contract) {
              watchlistDirty = true;
              console.log(`[collector] counterparty is a contract — registered as core, not related: ${addRes.contract.address}`);
            } else if (addRes?.candidate) {
              watchlistDirty = true;
              console.log(`[collector] first direct contact with a validator — held as one-off candidate (not related): ${addRes.candidate.address}`);
            } else if (addRes?.promoted) {
              watchlistDirty = true;
              console.log(`[collector] candidate promoted to related ${addRes.promoted.address} (direct dealings reached 2: ${addRes.promoted.relatedValidators.join(', ')})`);
            } else if (addRes?.observed) {
              watchlistDirty = true;
            } else if (addRes) {
              ev.watchlistAdded = true;
              watchlistDirty = true;
              console.log(`[collector] auto-added related address ${addRes.address} (depth ${addRes.depth}, via ${addRes.via.address}: ${addRes.relatedValidators.join(', ')})`);
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
        if (isPermanentlyExcluded(ev.actor)) continue; // v0.4.2: excluded actors are never recorded
        const addRes = await maybeAutoAddLive(watchlist, ctx, ev, excluded, { events: allEvents });
        if (addRes?.contract) {
          watchlistDirty = true;
          console.log(`[collector] counterparty is a contract — registered as core, not related (cosmos): ${addRes.contract.address}`);
        } else if (addRes?.candidate) {
          watchlistDirty = true;
          console.log(`[collector] first direct contact with a validator — held as one-off candidate (not related, cosmos): ${addRes.candidate.address}`);
        } else if (addRes?.promoted) {
          watchlistDirty = true;
          console.log(`[collector] candidate promoted to related (cosmos) ${addRes.promoted.address} (direct dealings reached 2: ${addRes.promoted.relatedValidators.join(', ')})`);
        } else if (addRes?.observed) {
          watchlistDirty = true;
        } else if (addRes) {
          ev.watchlistAdded = true;
          watchlistDirty = true;
          console.log(`[collector] auto-added related address (cosmos) ${addRes.address} (depth ${addRes.depth}, via ${addRes.via.address}: ${addRes.relatedValidators.join(', ')})`);
        }
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

  if (pairsSync) {
    console.log('[collector] --pairs-sync: pair-created events only (uncapped)');
    await refreshPrice();
    await syncPairEvents(Infinity);
    refreshHistoryFlags();
    persistWatchlist();
    writeFeed(latest);
    console.log(`[collector] pairs-sync done: total events ${allEvents.length}`);
    return;
  }
  if (range) {
    const [a, b] = range;
    console.log(`[collector] --range ${a}:${b}`);
    const r = await processRange(a, b);
    refreshHistoryFlags();
    persistWatchlist();
    writeFeed(latest);
    console.log(`[collector] done: blocks ${b - a + 1}, txs ${r.txs}, new watched events ${r.newEvents}, total events ${allEvents.length}`);
    return;
  }
  if (backfill != null) {
    const start = Math.max(0, latest - backfill + 1);
    console.log(`[collector] --backfill ${backfill}: blocks ${start}..${latest}`);
    const r = await processRange(start, latest);
    refreshHistoryFlags();
    persistWatchlist();
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
    refreshHistoryFlags();
    persistWatchlist();
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
    // v0.4.0 passes: price, pair-created events, history flags, watchlist.
    await refreshPrice();
    await syncPairEvents(6).catch((e) => console.error('[collector] pair sync failed (will retry next pass):', e.message));
    refreshHistoryFlags();
    persistWatchlist();
    writeFeed(tip);
    if (once) break;
    await sleep(pollMs);
  } while (true);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('[collector] FATAL', e); process.exit(1); });
