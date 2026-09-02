import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Emerge — The AI World',
  description: 'A living world of autonomous AI beings. They think. They socialise. They build. They evolve.',
};

export const viewport: Viewport = {
  themeColor: '#050b07',
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
