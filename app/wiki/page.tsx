import type { Metadata } from 'next';
import Wiki from '@/components/Wiki';

export const metadata: Metadata = {
  title: 'Guide',
  description:
    'How Emerge works: claiming land, what everything costs, how stewardship pays, and what is '
    + 'settled on chain versus what is not.',
};

export default function WikiPage() {
  return <Wiki />;
}
