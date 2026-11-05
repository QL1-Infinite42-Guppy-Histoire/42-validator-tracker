#!/usr/bin/env node
// WS1 regression test (v0.2.0): headline shows the ACTOR only.
// A shared counterparty's event (originally the block-4272345 event of
// a contract shared by 8 validators, rendered by the v0.1.0 whoLabel as
// a join of all 8 names — as if the validators acted together) must
// render with an actor-only headline, a capped relation line
// (first name + count), and the 共有の相手先 badge + note; a
// validator-self event renders its own name with NO relation list.
// Fixture since v0.4.2: an event of a depth-1 EOA shared by 3
// validators (the old contract fixture's actor events were purged when
// contracts left the person tiers). Fixture since v0.5.2: the #1 holder
// 0x7a6f6d4e...0a25 — after the related-definition tightening it is the
// remaining depth-1 wallet shared by exactly 3 validators (HeraMoon /
// Xenia / panda42); the previous fixture (0x2fcfc230...ecaf) dropped to
// 2 relations (Metal Raptor was a one-off contact) and is no longer
// "shared" under the >=3 rule.
// Run: node test-render.mjs  (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { enrichEvent, makeCtx } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const watchlist = JSON.parse(readFileSync(join(__dir, 'watchlist.json'), 'utf8'));
const registries = JSON.parse(readFileSync(join(__dir, 'registries.json'), 'utf8'));
const ctx = makeCtx(watchlist, registries, {});
const events = readFileSync(join(__dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evRelated = events.find((e) => e.actor === '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25' && e.actorTier === 'related' && e.actorShared);
const evPanda = events.find((e) => e.block === 4272345 && e.actorLabel === 'panda42' && e.type === 'transfer');
if (!evRelated || !evPanda) { console.error('FAIL: fixture events not found in events.jsonl'); process.exit(1); }
for (const ev of [evRelated, evPanda]) enrichEvent(ev, ctx, {});

const html = readFileSync(join(__dir, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const els = {};
const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', addEventListener() {}, appendChild(c) { this.options.push(c); } });
const sandbox = { document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl() }, fetch: async () => ({ json: async () => ({ status: {}, validators: [], events: [] }) }), setInterval() {}, console };
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__api={renderEvent, whoLabel};', sandbox);
const { renderEvent, whoLabel } = sandbox.__api;

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++; };

console.log('new headline:', whoLabel(evRelated));
check('related headline is actor-only', whoLabel(evRelated) === '残高1位アドレス');
const relHtml = renderEvent(evRelated);
const relNames = evRelated.actorValidators || [];
check('relation line capped (first + count)', relNames.length >= 3 && relHtml.includes(`関係バリデーター：<b class="rel-name">${relNames[0]}</b> ほか${relNames.length - 1}名`), relNames.join(','));
check('shared-counterparty badge present', relHtml.includes('共有の相手先'));
check('shared note present', relHtml.includes('複数のバリデーターと取引する共通の相手先です（バリデーター本人ではありません）'));
check('no full name join anywhere', !relHtml.includes(relNames.slice(0, 2).join('・')) && !relHtml.includes(relNames.slice(0, 2).join('・')));
console.log('panda42 headline:', whoLabel(evPanda));
check('validator-self headline is own name', whoLabel(evPanda) === 'panda42');
check('validator-self has NO relation list', !renderEvent(evPanda).includes('関係バリデーター'));

// ---- WS4/WS5 fixture rendering (stored data has 0 real bridge-out events,
// ---- so the green-glow path is verified with fixture events here) ----
const base = { ts: 1762000000, block: 4272000, chain: 'evm', txHash: '0x' + 'cd'.repeat(32), logIndex: 0, counterparty: '0x8667682b62caceda9e87b3caa21d5b09d9ae13c3', counterpartyLabel: 'ブリッジルーター', counterpartyIsCore: false, validatorNames: ['panda42'], actorValidators: [], actorShared: false, whitelisted: true, tokens: ['USDT'] };
const fxSelf = { ...base, id: 'fx1', type: 'bridge-out', actor: evPanda.actor, actorLabel: 'panda42', actorTier: 'validator', actorIsCore: false, summary: 'ブリッジで外部へ送信：10 USDT をブリッジ経由で外部チェーンへ', notableReasons: ['bridge-out'] };
const fxSelfHtml = renderEvent(fxSelf);
check('WS5 validator bridge-out glows (class)', fxSelfHtml.includes('ev bridgeout') || fxSelfHtml.includes('bridgeout'));
check('WS5 validator bridge-out badge wording', fxSelfHtml.includes('バリデーター本人のブリッジで外部へ送信'));
check('WS5 marker not shown as raw reason text', !fxSelfHtml.includes('⭐注目：bridge-out'));
const fxRel = { ...base, id: 'fx2', type: 'bridge-out', actor: '0x2fcfc23071e355aa75a6373d779bf5e220b8ecaf', actorLabel: null, actorTier: 'related', actorIsCore: false, actorValidators: ['DRIVESTATS', 'Zap'], actorShared: true, summary: 'ブリッジで外部へ送信：5 USDT をブリッジ経由で外部チェーンへ', notableReasons: ['bridge-out'] };
const fxRelHtml = renderEvent(fxRel);
check('WS5 related bridge-out badge wording', fxRelHtml.includes('関連ウォレットのブリッジで外部へ送信'));
check('WS5 related bridge-out headline is actor only', whoLabel(fxRel) === '関連 0x…ECAF');
const fxIn = { ...base, id: 'fx3', type: 'transfer', actor: evPanda.actor, actorLabel: 'panda42', actorTier: 'validator', actorIsCore: false, direction: 'in', summary: '10 USDT を受取', notableReasons: [] };
check('WS5 inbound receipt does NOT glow', !renderEvent(fxIn).includes('bridgeout'));
const fxApprove = events.find((e) => e.type === 'approve');
check('WS4 stored approve event exists after migration', !!fxApprove);
if (fxApprove) check('WS4 approve renders concrete label', renderEvent(fxApprove).includes('使用許可（approve）'));
const fxUnc = events.find((e) => e.type === 'unclassified');
check('WS4 stored unclassified event exists (honest remainder)', !!fxUnc);
if (fxUnc) check('WS4 unclassified renders method + destination', renderEvent(fxUnc).includes('未分類の操作') && renderEvent(fxUnc).includes('0x98869d1f'));
const fxFish = events.find((e) => e.type === 'reward-claim-fish');
check('WS4b stored FISH reward claim exists', !!fxFish);
if (fxFish) check('WS4b FISH claim renders its label', renderEvent(fxFish).includes('報酬請求（FISH配布）'));
process.exit(fails ? 1 : 0);
