#!/usr/bin/env node
// WS1 regression test (v0.2.0): headline shows the ACTOR only.
// The block-4272345 event for 0x71b13838…30E0 (a shared counterparty of 8
// validators) used to render with the v0.1.0 whoLabel as:
//   "farmer・Metal Raptor・PhoenixRing・HeraMoon・ayc・panda42・Xenia・light888 関連"
// which reads as if 8 validators acted together. The fixed renderer must
// produce headline "関連 0x…30E0", a capped relation line
// "関係バリデーター：farmer ほか7名", the 共有の相手先 badge + note, and for a
// validator-self event (panda42, same block) headline "panda42" with NO
// relation name list. Run: node test-render.mjs  (exit 1 on failure)
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
const evRelated = events.find((e) => e.block === 4272345 && e.actor === '0x71b138382598fbc4b890d2d20a14f9dedb1430e0');
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

const OLD_HEADLINE = 'farmer・Metal Raptor・PhoenixRing・HeraMoon・ayc・panda42・Xenia・light888 関連';
let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++; };

console.log('old (v0.1.0) headline for the …30E0 event:', OLD_HEADLINE);
console.log('new headline:', whoLabel(evRelated));
check('related headline is actor-only', whoLabel(evRelated) === '関連 0x…30E0');
const relHtml = renderEvent(evRelated);
check('relation line capped (first + count)', relHtml.includes('関係バリデーター：farmer ほか7名'));
check('shared-counterparty badge present', relHtml.includes('共有の相手先'));
check('shared note present', relHtml.includes('複数のバリデーターと取引する共通の相手先です（バリデーター本人ではありません）'));
check('contract note present for 0x71b1…', relHtml.includes('コントラクト'));
check('no full name join anywhere', !relHtml.includes('Metal Raptor・PhoenixRing'));
console.log('panda42 headline:', whoLabel(evPanda));
check('validator-self headline is own name', whoLabel(evPanda) === 'panda42');
check('validator-self has NO relation list', !renderEvent(evPanda).includes('関係バリデーター'));
process.exit(fails ? 1 : 0);
