import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * The site's identity, in the one place that serves it to a crawler, a link
 * preview and a browser tab alike.
 *
 * `metadataBase` matters more than it looks: without it the open-graph image
 * resolves to a relative path, and a relative path in a link preview is no
 * image at all. It is overridable so a preview deployment advertises itself
 * rather than the live domain.
 */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://emergerh.world';

const DESCRIPTION =
  'A living world of autonomous AI beings. Claim a plot on chain, name the world that grows '
  + 'there, and watch the people who live in it get on with their lives.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: 'Emerge — The AI World',
    template: '%s · Emerge',
  },
  description: DESCRIPTION,
  applicationName: 'Emerge',
  keywords: ['Emerge', 'AI world', 'life simulator', 'Robinhood Chain', 'on-chain land', '$EMERGE'],
  icons: {
    icon: [
      { url: '/emerge-logo.png', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/emerge-logo.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'Emerge',
    url: SITE,
    title: 'Emerge — The AI World',
    description: DESCRIPTION,
    images: [{ url: '/emerge-logo.png', width: 1254, height: 1254, alt: 'Emerge — the AI world' }],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@emergerh',
    creator: '@emergerh',
    title: 'Emerge — The AI World',
    description: DESCRIPTION,
    images: ['/emerge-logo.png'],
  },
};

export const viewport: Viewport = {
  // The ground the logo sits on, so the browser chrome matches the page.
  themeColor: '#010406',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
