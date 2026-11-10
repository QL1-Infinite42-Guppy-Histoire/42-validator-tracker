#!/usr/bin/env node
// English page regression test (v0.2.3): en.html must render every stored
// event type with an English type label and an English summary composed
// from the structured fields — the stored Japanese summary / actionLabel
// must never leak into the English page. Also checks the section logic
// inputs (bridge-out = USDT only after the v0.2.3 demotion).
// Run: node test-en.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const events = readFileSync(join(__dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const html = readFileSync(join(__dir, 'en.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const els = {};
const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', addEventListener() {}, appendChild(c) { this.options.push(c); } });
const sandbox = { document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl() }, fetch: async () => ({ json: async () => ({ status: {}, validators: [], events: [] }) }), setInterval() {}, console };
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__api={renderEvent, summaryEn, TYPE_EN};', sandbox);
const { renderEvent, summaryEn, TYPE_EN } = sandbox.__api;

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const JA = /[぀-ヿ一-鿿]/;

// every TYPE_EN key of the JP map exists (parity with index.html TYPE_JA)
const jpHtml = readFileSync(join(__dir, 'index.html'), 'utf8');
const jpTypes = [...jpHtml.match(/const TYPE_JA = \{([^}]*)\}/)[1].matchAll(/'([^']+)':/g)].map((m) => m[1]);
for (const t of jpTypes) check(`TYPE_EN covers '${t}'`, !!TYPE_EN[t]);

// render one stored event per present type; output must be Japanese-free
const byType = {};
for (const e of events) (byType[e.type] ??= []).push(e);
for (const [t, evs] of Object.entries(byType)) {
  const out = evs.slice(0, 25).map((e) => renderEvent(e)).join('\n');
  check(`render '${t}' x${Math.min(25, evs.length)} has no Japanese`, !JA.test(out), JA.test(out) ? (out.match(/.{0,30}[぀-ヿ一-鿿]+.{0,30}/)?.[0] ?? '') : '');
  check(`summaryEn '${t}' has no Japanese`, !JA.test(summaryEn(evs[0])), summaryEn(evs[0]));
}
// render ALL stored events (full sweep) — no Japanese anywhere
const all = events.map((e) => renderEvent(e)).join('\n');
check(`full sweep (${events.length} events) has no Japanese`, !JA.test(all), (all.match(/.{0,40}[぀-ヿ一-鿿]+.{0,40}/)?.[0] ?? ''));

// section membership after v0.2.3 demotion
const bo = events.filter((e) => e.type === 'bridge-out');
const bso = events.filter((e) => e.type === 'bridge-send-other');
check('stored bridge-out >= 12 (v0.2.3 migration baseline; v0.5.3 scope cut removed the evidence-tier senders)', bo.length >= 12, String(bo.length));
check('stored bridge-out are all USDT', bo.every((e) => e.amount?.symbol === 'USDT'));
check('stored bridge-send-other >= 11 (v0.2.3 demotions; backfills may add more)', bso.length >= 11, String(bso.length));
check('bridge-send-other kept no marker', bso.every((e) => !(e.notableReasons || []).includes('bridge-out')));
check('EN bridge badge wording (validator)', renderEvent({ ...bo.find((e) => e.actorTier === 'validator') }).includes("Validator's own USDT bridge-out"));

// v0.2.4 stored-data invariants: buys-only snipes (the prelist flag/section was removed 2026-11-10)
const snipes = events.filter((e) => e.isSnipe);
check('stored snipes are buys only (>= 51; the 52nd belonged to a one-off candidate purged in v0.5.2)', snipes.length >= 51 && snipes.every((e) => e.type === 'swap-buy'), String(snipes.length));
check('no LP add carries a snipe flag', events.every((e) => e.type !== 'lp-add' || !e.isSnipe));
const anchor = events.find((e) => e.txHash === '0x1f5bc6205f0c8e9f1b204cd6f40e1398fe98adcecbaac284e8f60f2d9f3d6cc1');
check('listing-day anchor buy (0xa8d5d100, 2026-06-30 13:31 JST) remains a normal record, unflagged', !!anchor && anchor.actor === '0xa8d5d10095d0d94b758e2d74c00107cfca311fd3' && !('isPrelist' in anchor));
check('anchor renders in English without Japanese', !!anchor && !JA.test(renderEvent(anchor)), anchor ? summaryEn(anchor) : '');

// template-level checks
check('en.html links back to index.html', html.includes('href="index.html"'));
check('en.html has English section headings', html.includes('Snipe Alerts') && html.includes('Bridge Withdrawals (USDT, outbound)') && html.includes('Trading') && html.includes('Trading summary') && html.includes('Latest activity'));
check('en.html has no prelist section (removed 2026-11-10)', !html.includes('sec-prelist') && !html.includes('id="prelists"'));
check('jp index.html has no prelist section (removed 2026-11-10)', !jpHtml.includes('sec-prelist') && !jpHtml.includes('id="prelists"'));
check('en.html template contains no Japanese summary text', !html.includes('ブリッジで外部へ送信：') && !html.includes('を送金'));

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
