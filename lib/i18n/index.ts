/**
 * Which language the game speaks.
 *
 * Two, for now: English, which every string in the code is written in, and
 * Simplified Chinese. The English text is the key — `t('Open the world map')`
 * — so a string with no translation is still a string, and the interface never
 * shows a bare identifier. The choice is remembered in this browser and
 * defaults to the browser's own language the first time.
 *
 * Text the world makes up as it goes — the feed, what people say, the plot
 * helper's advice — is written in English by the simulation and turned into
 * Chinese as it is shown, by `tx()`, which matches it against a table of
 * patterns. Anything the table does not know stays English rather than
 * disappearing.
 */

import { useSyncExternalStore } from 'react';
import { JOBS_ZH, NAMES, PATTERNS, UI } from './zh';

export type Locale = 'en' | 'zh';

const KEY = 'emerge.locale.v1';

let current: Locale = 'en';
let loaded = false;
const listeners = new Set<() => void>();

function load(): Locale {
  if (loaded) return current;
  loaded = true;
  if (typeof window === 'undefined') return current;
  try {
    const held = window.localStorage.getItem(KEY);
    if (held === 'zh' || held === 'en') current = held;
    else {
      const wanted = (navigator.language || '').toLowerCase();
      current = wanted.startsWith('zh') ? 'zh' : 'en';
    }
  } catch { /* private browsing; English it is */ }
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  return current;
}

export function getLocale(): Locale {
  return load();
}

export function setLocale(next: Locale) {
  loaded = true;
  current = next;
  try { window.localStorage.setItem(KEY, next); } catch { /* fine */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The locale, as React state: a component using it re-renders when it changes. */
export function useLocale(): Locale {
  // The server render and the first client render both say English, so the
  // markup agrees with itself; the stored choice is applied straight after.
  return useSyncExternalStore(subscribe, getLocale, () => 'en');
}

/** Fill `{name}` slots in a translated string. */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

/**
 * A piece of interface text in the current language.
 *
 * `t('Claim {region}', { region })`: the English is the key, the slots are
 * filled after the lookup so the translation can put them in its own order.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  if (getLocale() !== 'zh') return fill(text, vars);
  return fill(UI[text] ?? text, vars);
}

/** The name of a thing the simulation names in English — a trade, a building, a resource. */
export function tn(name: string): string {
  if (getLocale() !== 'zh') return name;
  return NAMES[name] ?? NAMES[name.toLowerCase()] ?? UI[name] ?? name;
}

/** A trade, by its label or its key. The building of the same name is a different word. */
export function tj(job: string): string {
  if (getLocale() !== 'zh') return job;
  return JOBS_ZH[job] ?? JOBS_ZH[job.toLowerCase()] ?? job;
}

/**
 * A line the world wrote — a feed entry, a speech bubble, a piece of advice —
 * in the current language.
 *
 * Exact matches first, then the pattern table. A pattern's replacement may
 * carry `$1`-style groups, and each group is itself run back through here, so
 * "The bakery was pulled down." becomes a Chinese sentence with a Chinese
 * word for the bakery in it. Unknown lines come back as they were.
 */
export function tx(line: string): string {
  if (getLocale() !== 'zh' || !line) return line;
  const exact = UI[line] ?? NAMES[line];
  if (exact) return exact;
  for (const [pattern, replacement] of PATTERNS) {
    const m = pattern.exec(line);
    if (!m) continue;
    if (typeof replacement === 'function') return replacement(m);
    return replacement.replace(/\$(\d)/g, (_: string, i: string) => {
      const group = m[Number(i)] ?? '';
      return group === line ? group : tx(group);
    });
  }
  return line;
}

/** The two languages, for a switch. */
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
];
