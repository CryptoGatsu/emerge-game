import type { Metadata } from 'next';
import LandBoard from '@/components/LandBoard';

export const metadata: Metadata = {
  title: 'Land',
  description:
    'Every plot in Emerge and who holds it: the settlements, what they are asking, what land has '
    + 'sold for, and the token behind each one. Look without a wallet; connect one to buy.',
};

export default function LandPage() {
  return <LandBoard />;
}
