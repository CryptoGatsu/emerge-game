'use client';

/**
 * The language switch.
 *
 * Two words, the one not in use lit as a button. Small enough to sit in a
 * header or a footer, and the same control everywhere so a player who found
 * it on the front page finds it in the game.
 */

import { LOCALES, setLocale, useLocale } from '@/lib/i18n';

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const locale = useLocale();
  return (
    <div className={`lang-switch ${className}`} role="group" aria-label="Language">
      {LOCALES.map((option) => (
        <button
          key={option.code}
          className={option.code === locale ? 'on' : ''}
          onClick={() => setLocale(option.code)}
          aria-pressed={option.code === locale}
          lang={option.code === 'zh' ? 'zh-CN' : 'en'}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
