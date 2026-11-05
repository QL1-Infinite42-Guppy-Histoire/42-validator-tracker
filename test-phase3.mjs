#!/usr/bin/env node
// Phase 3 (v0.3.0) regression tests:
//  - watchlist merge integrity: the 223 pre-existing entries are untouched
//    (counts per tier + spot checks), the estimated tier is well-formed.
//  - estimated tier tagging in enrichEvent: estimateBasis attached,
//    actorTier 'estimated', and the confirmed-only markers (isSnipe /
//    isInsider / bridge-out type+reason / actorShared) are stripped even
//    when the raw event would otherwise qualify.
//  - selectFeedEvents never pins an (enriched) estimated event.
//  - refreshValidatorList: adds a new bonded validator with its chain
//    moniker, marks a departed one inactive, never removes anything.
//  - stored data invariants: every stored estimated event carries a basis
//    and no confirmed-only flags; feed.json exposes estimated events,
//    estimatedCount per validator, chainValidators + estimatedRule.
//  - frontend statics (JP + EN + home pages): estimated styles + toggle +
//    confirmed-only filter guards, the X (Rioshi) display helpers, and the
//    top-right language switch on all four pages.
// Run: node test-phase3.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichEvent, makeCtx, refreshValidatorList, selectFeedEvents } from './collector.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
const watchlist = JSON.parse(read('watchlist.json'));
const registries = JSON.parse(read('registries.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));
const JA = /[぀-ヿ一-鿿]/;

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const cnt = (t) => watchlist.entries.filter((e) => e.tier === t).length;

// ---------- watchlist merge integrity ----------
// v0.4.0: the related tier grew by the full-history closure (auto-added
// entries). v0.4.1 contract audit + closure repair: 34 protocol contracts
// moved related -> core and 47 closure entries reachable only through
// contracts were removed — original related 104, core 124.
// v0.4.2: full bytecode census (no exceptions) moved 17 more originals
// to core (original related 87, core 153), the EOA-only repair removed
// 49 closure entries, and the evidence gate kept only 12 of the
// remaining depth>=2 entries (84 general addresses deleted).
const autoAddedEntries = watchlist.entries.filter((e) => e.autoAdded);
check('validator tier still 23', cnt('validator') === 23, String(cnt('validator')));
check('original related tier now 50 after the v0.5.2 tightening (non-autoAdded; 37 one-off contacts demoted to candidates)', watchlist.entries.filter((e) => e.tier === 'related' && !e.autoAdded).length === 50, String(watchlist.entries.filter((e) => e.tier === 'related' && !e.autoAdded).length));
check('related tier = 50 + closure/live auto-added', cnt('related') === 50 + autoAddedEntries.length, String(cnt('related')));
check('core tier now 153 after the v0.4.2 census (124 + 29)', cnt('core') === 153, String(cnt('core')));
check('estimated tier retired in v0.5.3 (0)', cnt('estimated') === 0, String(cnt('estimated')));
check('total entries = 263 + auto-added (v0.5.3 scope cut)', watchlist.entries.length === 263 + autoAddedEntries.length, String(watchlist.entries.length));
const lp = watchlist.entries.find((e) => e.address === '0x71b138382598fbc4b890d2d20a14f9dedb1430e0');
check('shared LP contract is CORE tier since v0.4.2 (bytecode rule, no exceptions)', lp?.tier === 'core');
const xenia = watchlist.entries.find((e) => e.label === 'Xenia');
check('Xenia stays validator tier', xenia?.tier === 'validator');
// v0.3.2 (user correction): Xenia is NOT core/system infrastructure — she is
// an ordinary validator; her 2-[42] seed distribution is her own activity.
check('Xenia is NOT core (v0.3.2 user correction)', xenia?.isCore === false && !('coreNote' in xenia));
check('no validator-tier entry carries a core flag', watchlist.entries.filter((e) => e.tier === 'validator').every((e) => !e.isCore));
check('watchlist summary coreFlaggedTotal is 154 after the v0.4.2 census', watchlist.summary.coreFlaggedTotal === 154, String(watchlist.summary.coreFlaggedTotal));
check('#1 holder 0x7a6f...0a25 keeps its core flag (not part of the correction)', watchlist.entries.find((e) => e.address === '0x7a6f6d4e0ce3abbba5ab6685c37a9599f6250a25')?.isCore === true);
const est = watchlist.entries.filter((e) => e.tier === 'estimated');
check('no estimated entries carry basis fields (tier retired)', est.length === 0);
check('estimated basisTextEn has no Japanese (vacuous, tier retired)', est.every((e) => !JA.test(e.basisTextEn ?? '')));
check('estimated entries are watched and not pairs/core', est.every((e) => e.watch === true && !e.isPair && !e.isCore));
check('no estimated address is a registered pair', est.every((e) => !(e.address in (registries.pairs ?? {}))));
check('basis mix: none (estimated tier retired in v0.5.3)', est.length === 0);
check('watchlist summary counts agree', watchlist.summary.estimated === 0 && watchlist.summary.watchedActors === 73 + autoAddedEntries.length && watchlist.summary.totalEntries === 263 + autoAddedEntries.length && watchlist.summary.related === cnt('related') && watchlist.summary.autoAdded === autoAddedEntries.length);

// ---------- enrichEvent guards ----------
const ctx = makeCtx(watchlist, registries, {});
const storedEst = events.find((e) => e.actorTier === 'estimated');
check('no stored estimated events remain (v0.5.3)', !storedEst && events.every((e) => e.actorTier !== 'estimated'), String(events.filter((e) => e.actorTier === 'estimated').length));
if (storedEst) {
  const ev = JSON.parse(JSON.stringify(storedEst));
  delete ev.estimateBasis; ev.isSnipe = true; ev.isInsider = true; ev.actorShared = true;
  enrichEvent(ev, ctx, {});
  check('enrich re-attaches estimateBasis', !!ev.estimateBasis && ev.estimateBasis.type === storedEst.estimateBasis.type);
  check('enrich strips isSnipe/isInsider/actorShared for estimated', ev.isSnipe === false && ev.isInsider === false && ev.actorShared === false);
}
// v0.3.2 repair: enrichEvent re-derives the core flags from the watchlist,
// so a stored Xenia event that still carries the old core classification is
// repaired in place (actor side AND counterparty side).
const xeniaEv = events.find((e) => e.actor === xenia.address);
check('stored Xenia events exist', !!xeniaEv, String(events.filter((e) => e.actor === xenia.address).length));
if (xeniaEv) {
  const ev = JSON.parse(JSON.stringify(xeniaEv));
  ev.actorIsCore = true; // simulate the pre-v0.3.2 stored state
  enrichEvent(ev, ctx, {});
  check('enrich repairs Xenia actorIsCore -> false', ev.actorIsCore === false);
  check('enrich leaves Xenia actorTier/label untouched', ev.actorTier === 'validator' && ev.actorLabel === 'Xenia');
}
const xeniaCpEv = events.find((e) => e.counterparty === xenia.address);
if (xeniaCpEv) {
  const ev = JSON.parse(JSON.stringify(xeniaCpEv));
  ev.counterpartyIsCore = true; // simulate the pre-v0.3.2 stored state
  enrichEvent(ev, ctx, {});
  check('enrich repairs Xenia counterpartyIsCore -> false', ev.counterpartyIsCore === false);
}
check('no stored event marks Xenia as core (actor or counterparty)', events.every((e) =>
  !(e.actor === xenia.address && e.actorIsCore) && !(e.counterparty === xenia.address && e.counterpartyIsCore)));
const feedXenia = (feed.validators || []).find((v) => v.moniker === 'Xenia');
check('feed validators list: Xenia isCore false', feedXenia?.isCore === false);

// Flip a REAL X-related insider event's actor to estimated tier in a cloned
// watchlist: even with a fresh pair (snipe window) the flags must not stick,
// and a bridge-out by that actor must be demoted.
const wl2 = JSON.parse(JSON.stringify(watchlist));
const insiderEv = events.find((e) => e.isInsider && e.type === 'swap-buy');
const relEntry = wl2.entries.find((e) => e.address === insiderEv.actor);
relEntry.tier = 'estimated'; relEntry.basisType = 'pool'; relEntry.basisText = 'テスト用根拠'; relEntry.basisTextEn = 'test basis';
const ctx2 = makeCtx(wl2, registries, {});
const ev2 = JSON.parse(JSON.stringify(insiderEv));
ev2.isSnipe = false;
enrichEvent(ev2, ctx2, { [String(insiderEv.pair).toLowerCase()]: { createdTs: insiderEv.ts - 60 } });
check('estimated actor never snipes (fresh pair)', ev2.isSnipe === false);
check('estimated actor never insider (X-linked [42] buy)', ev2.isInsider === false);
check('flipped event carries the basis', ev2.estimateBasis?.text === 'テスト用根拠');
const boEv = events.find((e) => e.type === 'bridge-out');
const wl3 = JSON.parse(JSON.stringify(watchlist));
const boEntry = wl3.entries.find((e) => e.address === boEv.actor);
boEntry.tier = 'estimated'; boEntry.basisType = 'shared'; boEntry.basisText = 'テスト用根拠'; boEntry.basisTextEn = 'test basis';
const ctx3 = makeCtx(wl3, registries, {});
const ev3 = JSON.parse(JSON.stringify(boEv));
enrichEvent(ev3, ctx3, {});
check('estimated bridge send demoted to bridge-send-other', ev3.type === 'bridge-send-other');
check('estimated bridge send keeps no bridge-out marker', !(ev3.notableReasons || []).includes('bridge-out'));

// ---------- feed selection: estimated never pinned ----------
{
  const dummies = Array.from({ length: 600 }, (_, i) => ({ id: 'd' + i, block: 5000000 - i, logIndex: 0, type: 'transfer' }));
  const oldEst = { id: 'old-est', block: 100, logIndex: 0, type: 'transfer', actorTier: 'estimated', isSnipe: false, isInsider: false };
  const oldSnipe = { id: 'old-snipe', block: 99, logIndex: 0, type: 'swap-buy', actorTier: 'related', isSnipe: true };
  const sel = selectFeedEvents([...dummies, oldEst, oldSnipe]);
  check('estimated event outside head-500 is NOT pinned into feed', !sel.some((e) => e.id === 'old-est'));
  check('confirmed snipe outside head-500 IS pinned (sanity)', sel.some((e) => e.id === 'old-snipe'));
}

// ---------- refreshValidatorList (fake chain) ----------
{
  const wl = JSON.parse(JSON.stringify(watchlist));
  const selfEntries = wl.entries.filter((e) => e.tier === 'validator');
  const dropped = selfEntries[selfEntries.length - 1];
  const fakeChain = selfEntries.slice(0, -1).map((e) => ({ address: e.address, operator: 'infinitevaloper1fake', moniker: e.label, status: 3, bonded: true }));
  fakeChain.push({ address: '0x' + 'ab'.repeat(20), operator: 'infinitevaloper1newval', moniker: 'TestVal', status: 3, bonded: true });
  fakeChain.push({ address: '0x' + 'cd'.repeat(20), operator: 'infinitevaloper1unbonded', moniker: 'NotBonded', status: 1, bonded: false });
  const r = await refreshValidatorList(wl, { fetchValidators: async () => fakeChain, log: () => {}, persist: false });
  check('refresh adds the new bonded validator', r.added.length === 1 && r.added[0] === 'TestVal', JSON.stringify(r.added));
  check('refresh reports bonded/total', r.bonded === 23 && r.total === 24, `${r.bonded}/${r.total}`);
  const addedEntry = wl.entries.find((e) => e.address === '0x' + 'ab'.repeat(20));
  check('added entry is self-tier with chain moniker + operator', addedEntry?.tier === 'validator' && addedEntry?.label === 'TestVal' && addedEntry?.operator === 'infinitevaloper1newval' && !!addedEntry?.autoAdded);
  check('unbonded chain validator is NOT added', !wl.entries.some((e) => e.address === '0x' + 'cd'.repeat(20)));
  check('departed validator stays watched, marked inactive', wl.entries.find((e) => e.address === dropped.address)?.inactive === true);
  check('nothing removed by refresh', wl.entries.length === 264 + autoAddedEntries.length, String(wl.entries.length));
}

// ---------- stored-data + feed invariants ----------
const storedEstAll = events.filter((e) => e.actorTier === 'estimated');
check('stored estimated events all carry estimateBasis', storedEstAll.every((e) => !!e.estimateBasis?.text && !!e.estimateBasis?.textEn));
check('stored estimated events: no snipe/insider/bridge-out', storedEstAll.every((e) => !e.isSnipe && !e.isInsider && e.type !== 'bridge-out' && !(e.notableReasons || []).includes('bridge-out')));
check('feed.json contains no estimated events (v0.5.3)', feed.events.every((e) => e.actorTier !== 'estimated'), String(feed.events.filter((e) => e.actorTier === 'estimated').length));
check('feed status has estimatedRule + chainValidators', !!feed.status.estimatedRule && !!feed.status.chainValidators);
check('feed validators carry estimatedCount; link total = 0 (v0.5.3)', feed.validators.every((v) => typeof v.estimatedCount === 'number') && feed.validators.reduce((t, v) => t + v.estimatedCount, 0) === 0);
check('feed insiderRule names X (Rioshi)', (feed.status.insiderRule || '').includes('X（Rioshi）'));

// ---------- frontend statics ----------
const jp = read('index.html'), en = read('en.html'), home = read('home.html'), homeEn = read('home-en.html');
for (const [name, html] of [['index.html', jp], ['en.html', en]]) {
  check(`${name}: estimated card style + badge removed (v0.5.3)`, !html.includes('.ev.estimated') && !html.includes('.badge.estimated'));
  check(`${name}: estimated toggle removed (v0.5.3)`, !html.includes('id="fEstimated"'));
  check(`${name}: confirmed-only guards in sections`, (html.match(/actorTier !== 'estimated'/g) || []).length >= 4, String((html.match(/actorTier !== 'estimated'/g) || []).length));
  check(`${name}: language switch top-right`, html.includes('class="langsw"') && html.includes('id="langOther"'));
  check(`${name}: version v0.4.2`, html.includes('v0.4.2'));
}
check('index.html: 推定も表示 toggle label removed (v0.5.3)', !jp.includes('推定も表示'));
check('en.html: Show estimated toggle label removed (v0.5.3)', !en.includes('Show estimated'));
check('index.html: valName alias helper + Rioshi', jp.includes("const valName = (n) => n === 'X'") && jp.includes('(Rioshi)'));
check('en.html: valName alias helper + Rioshi', en.includes("const valName = (n) => n === 'X'") && en.includes('(Rioshi)'));
check('en.html: estimated relation line removed (v0.5.3)', !en.includes('estimateBasis.textEn'));
check('index.html: estimated relation line removed (v0.5.3)', !jp.includes('推定の根拠'));
for (const [name, html] of [['home.html', home], ['home-en.html', homeEn]]) {
  check(`${name}: language switch top-right`, html.includes('class="langsw"') && html.includes('id="langOther"'));
  check(`${name}: insider card names X (Rioshi)`, html.includes('(Rioshi)') && html.includes('X（Rioshi）') || html.includes('X (Rioshi)'));
  check(`${name}: counts exclude estimated from special sections`, html.includes("actorTier !== 'estimated'"));
  check(`${name}: version v0.4.2`, html.includes('v0.4.2'));
}
check('home.html: 全記録 card no longer mentions 推定 (v0.5.3)', !home.includes('推定アドレスの動きも、推定と明記して含みます'));
check('home-en.html: full-record card no longer mentions estimated (v0.5.3)', !homeEn.includes('Moves by estimated addresses are included here'));

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
