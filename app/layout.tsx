import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Emerge',
  description: 'A new world. A life of its own.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}