#!/usr/bin/env node
// v0.5.0 multi-language regression test: for each added language
// (zh/es/hi/ar/pt/fr), the tracker page must render every stored event
// type with that language's type label and a summary composed from the
// structured fields — stored Japanese text must never leak. Mirrors
// test-en.mjs per language; also checks lang attributes, the 8-language
// switcher, the v0.5.0 version badge, localized chrome, and (for Arabic)
// dir="rtl". Home pages are checked for switcher/badge/cards/chrome.
// Run: node test-i18n.mjs (exit 1 on failure)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const events = readFileSync(join(__dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const jpHtml = readFileSync(join(__dir, 'index.html'), 'utf8');
const jpTypes = [...jpHtml.match(/const TYPE_JA = \{([^}]*)\}/)[1].matchAll(/'([^']+)':/g)].map((m) => m[1]);
const KANA = /[぀-ヿ]/;            // hiragana + katakana block
const JA_FULL = /[぀-ヿ一-鿿]/;     // kana + CJK ideographs

const LANGS = [
  { code: 'zh', file: 'zh.html', home: 'home-zh.html', lang: 'zh-CN', leak: KANA, native: '简体中文',
    feedH2: '<h2>最新动态</h2>', snipeH2: '🎯 抢购警报', homeTitle: '42 链验证者追踪 — 首页' },
  { code: 'es', file: 'es.html', home: 'home-es.html', lang: 'es', leak: JA_FULL, native: 'Español',
    feedH2: '<h2>Actividad reciente</h2>', snipeH2: '🎯 Alertas de snipe', homeTitle: 'Rastreador de validadores de 42 Chain — Página principal' },
  { code: 'hi', file: 'hi.html', home: 'home-hi.html', lang: 'hi', leak: JA_FULL, native: 'हिन्दी',
    feedH2: '<h2>नवीनतम गतिविधि</h2>', snipeH2: '🎯 स्नाइप अलर्ट', homeTitle: '42 Chain वैलिडेटर ट्रैकर — शीर्ष पेज' },
  { code: 'ar', file: 'ar.html', home: 'home-ar.html', lang: 'ar', leak: JA_FULL, rtl: true, native: 'العربية',
    feedH2: '<h2>أحدث نشاط</h2>', snipeH2: '🎯 تنبيهات القنص', homeTitle: 'متتبع مدققي 42 Chain — الصفحة الرئيسية' },
  { code: 'pt', file: 'pt.html', home: 'home-pt.html', lang: 'pt', leak: JA_FULL, native: 'Português',
    feedH2: '<h2>Atividade recente</h2>', snipeH2: '🎯 Alertas de snipe', homeTitle: 'Rastreador de validadores da 42 Chain — Página inicial' },
  { code: 'fr', file: 'fr.html', home: 'home-fr.html', lang: 'fr', leak: JA_FULL, native: 'Français',
    feedH2: '<h2>Activité récente</h2>', snipeH2: '🎯 Alertes de snipe', homeTitle: 'Traqueur des validateurs 42 Chain — Accueil' },
];
const TRACKER_FILES = ['index.html', 'en.html', 'zh.html', 'es.html', 'hi.html', 'ar.html', 'pt.html', 'fr.html'];
const HOME_FILES = ['home.html', 'home-en.html', 'home-zh.html', 'home-es.html', 'home-hi.html', 'home-ar.html', 'home-pt.html', 'home-fr.html'];
const NATIVE = ['日本語', 'English', '简体中文', 'Español', 'हिन्दी', 'العربية', 'Português', 'Français'];

let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };

const byType = {};
for (const e of events) (byType[e.type] ??= []).push(e);

for (const L of LANGS) {
  const tag = `[${L.code}]`;
  check(`${tag} tracker file exists`, existsSync(join(__dir, L.file)));
  check(`${tag} home file exists`, existsSync(join(__dir, L.home)));
  if (!existsSync(join(__dir, L.file))) continue;
  const html = readFileSync(join(__dir, L.file), 'utf8');
  const home = readFileSync(join(__dir, L.home), 'utf8');

  check(`${tag} <html lang="${L.lang}">`, html.includes(`<html lang="${L.lang}"`));
  check(`${tag} home <html lang="${L.lang}">`, home.includes(`<html lang="${L.lang}"`));
  if (L.rtl) {
    check(`${tag} dir="rtl" on tracker + home`, html.includes('dir="rtl"') && home.includes('dir="rtl"'));
    check(`${tag} RTL overrides present`, html.includes('Arabic RTL overrides') && html.includes("[dir='rtl'] .ev.lpadd")
      && home.includes('Arabic RTL overrides'));
  }
  check(`${tag} version badge v0.5.3 (tracker)`, html.includes('<span class="verbadge">v0.5.3</span>'));
  check(`${tag} version badge v0.5.3 (home)`, home.includes('<span class="verbadge">v0.5.3</span>'));
  for (const n of NATIVE) check(`${tag} switcher lists ${n}`, html.includes(`>${n}</a>`) || html.includes(`<b>${n}</b>`));
  // the page's own language is shown as <b>current</b>, not a self-link
  for (const f of TRACKER_FILES) check(`${tag} switcher links ${f}`, f === L.file ? html.includes(`<b>${L.native}</b>`) : html.includes(`href="${f}"`));
  for (const f of HOME_FILES) check(`${tag} home switcher links ${f}`, f === L.home ? home.includes(`<b>${L.native}</b>`) : home.includes(`href="${f}"`));
  check(`${tag} localized feed heading`, html.includes(L.feedH2));
  check(`${tag} localized snipe heading`, html.includes(L.snipeH2));
  check(`${tag} no EN/JP feed heading left`, !html.includes('<h2>Latest activity</h2>') && !html.includes('<h2>最新の動き</h2>'));
  check(`${tag} home title localized`, home.includes(`<title>${L.homeTitle}</title>`));
  check(`${tag} home cards point to ${L.file}`, (home.match(new RegExp(`href="${L.file}#`, 'g')) || []).length === 12, // v0.5.3: the estimated-definition link was removed with the tier
    String((home.match(new RegExp(`href="${L.file}#`, 'g')) || []).length));

  // renderer harness (mirrors test-en.mjs)
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const els = {};
  const mkEl = () => ({ innerHTML: '', textContent: '', options: [], value: '', addEventListener() {}, appendChild(c) { this.options.push(c); } });
  const sandbox = { document: { getElementById: (id) => els[id] ?? (els[id] = mkEl()), createElement: () => mkEl(), querySelector: () => mkEl(), querySelectorAll: () => [] }, fetch: async () => ({ json: async () => ({ status: {}, validators: [], events: [] }) }), setInterval() {}, console };
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;globalThis.__api={renderEvent, summaryEn, TYPE_EN};', sandbox);
  const { renderEvent, summaryEn, TYPE_EN } = sandbox.__api;

  for (const t of jpTypes) check(`${tag} TYPE covers '${t}'`, !!TYPE_EN[t]);
  for (const [t, evs] of Object.entries(byType)) {
    const out = evs.slice(0, 25).map((e) => renderEvent(e)).join('\n');
    check(`${tag} render '${t}' x${Math.min(25, evs.length)} no Japanese leak`, !L.leak.test(out),
      L.leak.test(out) ? (out.match(/.{0,30}[぀-ヿ一-鿿]+.{0,30}/)?.[0] ?? '') : '');
    check(`${tag} summary '${t}' no Japanese leak`, !L.leak.test(summaryEn(evs[0])), summaryEn(evs[0]));
  }
  const all = events.map((e) => renderEvent(e)).join('\n');
  check(`${tag} full sweep (${events.length} events) no Japanese leak`, !L.leak.test(all),
    (all.match(/.{0,40}[぀-ヿ一-鿿]+.{0,40}/)?.[0] ?? ''));
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails ? 1 : 0);
