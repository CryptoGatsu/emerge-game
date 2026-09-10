'use client';

/**
 * The site's one header.
 *
 * Every page outside the world — the front door, the world map, the land
 * board, the markets, the guide — used to carry its own copy of the mark and
 * the language switch, each laid out a little differently, and none of them
 * said where the other pages were. This is the same bar on all of them: the
 * mark, the four places to go with the current one lit, and whatever the page
 * needs beside the language switch. Glass, like the panels over the world,
 * so a player moving between the game and its pages stays in one place.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLine } from './Brand';
import { LanguageSwitch } from './LanguageSwitch';
import { t } from '@/lib/i18n';

const PAGES: [string, string][] = [
  ['/', 'World'],
  ['/land', 'Land'],
  ['/markets', 'Markets'],
  ['/wiki', 'Guide'],
];

export function SiteNav({ current, extra }: { current: string; extra?: ReactNode }) {
  return (
    <header className="site-nav">
      <Link href="/" className="site-brand" aria-label="Emerge"><BrandLine size={34} /></Link>
      <nav className="site-links" aria-label={t('Site')}>
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href} className={current === href ? 'on' : ''} aria-current={current === href ? 'page' : undefined}>
            {t(label)}
          </Link>
        ))}
      </nav>
      <div className="site-side">
        {extra}
        <LanguageSwitch />
      </div>
    </header>
  );
}
