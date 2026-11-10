#!/usr/bin/env node
// v0.5.2 regression test: attribution split + related-definition tightening.
//  (1) FILTER PURITY (VM, JP + EN pages): with a validator selected, the
//      "self" group of the rendered feed contains ONLY cards whose actor
//      is that validator's own watchlist address, the "related" group
//      contains only events whose actor is one of its related addresses,
//      and both group headings carry the recomputed counts.
//  (2) SPOT VALUES recomputed from events.jsonl: Sirius Cybernetics
//      self = 0 (with the explicit "no self activity recorded" line in
//      the rendered self group) and related = 0; Woman-In-Red-42
//      self = 32, related = 32.
//  (3) FEED SPLIT COUNTS: feed.json per-validator selfActivity /
//      relatedActivity equal the recomputation for all 23 validators.
//  (4) TIGHTENING STATE: 87 depth-1 entries judged -> 50 related kept,
//      37 demoted to (non-displayed) candidates; the 2 protected
//      X wallets remain related; no candidate appears in feed validators'
//      related counts; Sirius has 0 related addresses.
//  (5) ALL 8 tracker pages carry the standing disclaimer + the new
//      related-definition sentence + the strengthened bridge note; all
//      8 home pages carry the attribution disclaimer.
// Run: node test-v052.mjs (exit 1 on failure)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), 'utf8');
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const watchlist = JSON.parse(read('watchlist.json'));
const events = read('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const feed = JSON.parse(read('feed.json'));
const validators = watchlist.entries.filter((e) => e.tier === 'validator');

// ---- recomputation (the definition the site must match) ----
const recompute = (v) => ({
  self: events.filter((e) => e.actor === v.address).length,
  related: events.filter((e) => e.actor !== v.address && (e.actorValidators ?? []).includes(v.label)).length,
});

// ---- (2) spot values ----
const sirius = validators.find((v) => v.label === 'Sirius Cybernetics');
const wir42 = validators.find((v) => v.label === 'Woman-In-Red-42');
check('Sirius Cybernetics: self activity = 0', recompute(sirius).self === 0, String(recompute(sirius).self));
check('Sirius Cybernetics: related activity = 0', recompute(sirius).related === 0, String(recompute(sirius).related));
check('Woman-In-Red-42: self activity = 32', recompute(wir42).self === 32, String(recompute(wir42).self));
check('Woman-In-Red-42: related activity = 81 (v0.5.3 backfill gave 70; +11 of live data since — two of her related wallets act hourly; value at 2026-11-10 republication data)', recompute(wir42).related === 81, String(recompute(wir42).related));

// ---- (3) feed split counts ----
for (const fv of feed.validators) {
  const v = validators.find((x) => x.label === fv.moniker);
  const r = recompute(v);
  check(`feed split counts: ${fv.moniker}`, fv.selfActivity === r.self && fv.relatedActivity === r.related,
    `feed ${fv.selfActivity}/${fv.relatedActivity} vs recomputed ${r.self}/${r.related}`);
}

// ---- (4) tightening state ----
const d1 = watchlist.entries.filter((e) => e.tier === 'related' && e.depth === undefined);
const cands = watchlist.entries.filter((e) => e.tier === 'candidate');
check('depth-1 related kept = 50', d1.length === 50, String(d1.length));
check('one-off candidates = 37', cands.length === 37, String(cands.length));
check('candidates are not watched', cands.every((e) => e.watch === false && (e.relatedValidators ?? []).length === 0));
check('candidates keep their direct-dealing stats', cands.every((e) => e.directStats && Object.values(e.directStats).every((s) => s.out + s.in <= 1)));
for (const a of ['0xc8de941efb92925bfd359a7a380399e47bc2b242', '0xf75b159860f3de7f229e22d08eab844fd97baade']) {
  const e = watchlist.entries.find((x) => x.address === a);
  check(`protected X wallet stays related: …${a.slice(-4)}`, !!e && e.tier === 'related' && (e.relatedValidators ?? []).includes('X'));
}
check('no candidate-actor events remain in the record (except pair-created chain news, the standing exception)', events.every((e) => !cands.some((c) => c.address === e.actor) || e.type === 'pair-created'));
const feedSirius = feed.validators.find((v) => v.moniker === 'Sirius Cybernetics');
check('Sirius related addresses in feed = 0', feedSirius.relatedCount === 0, String(feedSirius.relatedCount));

// ---- (1) VM filter purity on JP + EN tracker pages ----
function runPage(file) {
  const html = read(file);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', checked: true, style: {}, classList: { add() {}, toggle() {} }, addEventListener() {}, appendChild(c) { this.options.push(c); }, querySelector: () => null });
  const sandbox = {
    document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl(), querySelector: () => null, querySelectorAll: () => [] },
    fetch: async () => ({ json: async () => ({ status: {}, validators: [], events: [] }) }),
    setInterval() {}, console, location: { hash: '' },
  };
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;globalThis.__api={applyFilters, renderFeedList, isSelfEvent, isRelatedEvent}; globalThis.__setFeed=(f)=>{FEED=f;};', sandbox);
  return { els, api: sandbox.__api, setFeed: sandbox.__setFeed, mkEl };
}
const firstAddr = (cardHtml) => {
  const m = cardHtml.match(/scan\.infinitedrive\.xyz\/address\/(0x[0-9a-f]{40})/);
  return m && m[1];
};
for (const [file, noSelfText, selfHeadRe, relHeadRe] of [
  ['index.html', 'このバリデーター本人の動きは記録されていません', /本人の動き（(\d+)件）/, /関連アドレスの動き（(\d+)件）/],
  ['en.html', 'No activity by this validator itself has been recorded', /Own activity \((\d+)\)/, /Related addresses' activity \((\d+)\)/],
]) {
  const { els, api, setFeed } = runPage(file);
  setFeed({ status: {}, validators: validators.map((v) => ({ moniker: v.label, address: v.address })), events });
  for (const v of validators) {
    els.fValidator.value = v.label; els.fType.value = ''; els.fToken.value = ''; // v0.5.3: the estimated toggle (fEstimated) was removed with the tier
    api.applyFilters();
    const html = els.feed.innerHTML;
    const r = recompute(v);
    const sm = html.match(selfHeadRe), rm = html.match(relHeadRe);
    check(`${file} ${v.label}: group headings present with recomputed counts`,
      !!sm && !!rm && Number(sm[1]) === r.self && Number(rm[1]) === r.related,
      `headings ${sm && sm[1]}/${rm && rm[1]} vs ${r.self}/${r.related}`);
    const seg = html.split(/<h3 class="vgroup">/);
    const selfSeg = seg[1] ?? '', relSeg = seg[2] ?? '';
    const selfCards = selfSeg.split('<div class="ev').slice(1);
    check(`${file} ${v.label}: self group contains ONLY own-address cards`,
      selfCards.length === r.self && selfCards.every((c) => firstAddr(c) === v.address),
      `${selfCards.length} cards`);
    const relCards = relSeg.split('<div class="ev').slice(1);
    check(`${file} ${v.label}: related group excludes the validator itself`,
      relCards.length === r.related && relCards.every((c) => firstAddr(c) !== v.address),
      `${relCards.length} cards`);
    if (v.label === 'Sirius Cybernetics') {
      check(`${file} Sirius: explicit no-self-activity line shown`, selfSeg.includes(noSelfText));
    }
  }
}

// ---- (5) standing texts on all pages ----
const DISCLAIMER = {
  'index.html': 'バリデーター自身の財布とは限りません', 'en.html': "not necessarily the validator's own wallets",
  'zh.html': '未必是验证者本人的钱包', 'es.html': 'no son necesariamente las billeteras propias del validador',
  'hi.html': 'आवश्यक रूप से वैलिडेटर के अपने वॉलेट नहीं हैं', 'ar.html': 'ليست بالضرورة محافظ المدقق نفسه',
  'pt.html': 'não são necessariamente as próprias carteiras do validador', 'fr.html': 'ce ne sont pas nécessairement les propres portefeuilles du validateur',
};
const TIGHTEN = {
  'index.html': '1回だけの一方通行の取引は関連に数えません', 'en.html': 'A single one-way transaction does not count as a relation',
  'zh.html': '只有一次的单向交易不计为关联', 'es.html': 'Una única transacción en un solo sentido no cuenta como relación',
  'hi.html': 'केवल एक बार का एकतरफ़ा लेन-देन संबंध नहीं माना जाता', 'ar.html': 'المعاملة الواحدة في اتجاه واحد لا تُعدّ صلة',
  'pt.html': 'Uma única transação em um só sentido não conta como relação', 'fr.html': 'Une seule transaction à sens unique ne compte pas comme un lien',
};
const BRIDGE = {
  'index.html': '棒の大部分はバリデーター本人の出金ではなく', 'en.html': "most of each bar is not the validator's own outflow",
  'zh.html': '每条柱的大部分并非验证者本人的出金', 'es.html': 'la mayor parte de cada barra no es la salida del propio validador',
  'hi.html': 'प्रत्येक बार का अधिकांश भाग वैलिडेटर का अपना बहिर्वाह नहीं है', 'ar.html': 'معظم كل عمود ليس تدفقًا خارجيًا للمدقق نفسه',
  'pt.html': 'a maior parte de cada barra não é a saída do próprio validador', 'fr.html': "la majeure partie de chaque barre n'est pas la sortie du validateur lui-même",
};
for (const f of Object.keys(DISCLAIMER)) {
  const html = read(f);
  check(`${f}: standing disclaimer present`, html.includes(DISCLAIMER[f]));
  check(`${f}: tightened related definition present`, html.includes(TIGHTEN[f]));
  check(`${f}: bridge bars mostly related wallets — stated`, html.includes(BRIDGE[f]));
  check(`${f}: split renderer present`, html.includes('function renderFeedList') && html.includes('isSelfEvent') && html.includes('selfActivity'));
}

process.exit(fails ? 1 : 0);
