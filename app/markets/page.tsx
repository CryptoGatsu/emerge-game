import type { Metadata } from 'next';
import Markets from '@/components/Markets';

export const metadata: Metadata = {
  title: 'Markets',
  description:
    'Every price in Emerge: the world market\'s goods, the player exchange\'s standing orders and '
    + 'fills, what a Gold is worth in $EMERGE, and the land for sale and sold.',
};

export default function MarketsPage() {
  return <Markets />;
}
