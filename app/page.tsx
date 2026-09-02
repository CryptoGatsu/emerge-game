import EmergeClient from '@/components/EmergeClient';

/** The world seed. Same seed, same world, every time. */
const SEED = 481516;

export default function Page() {
  return <EmergeClient seed={SEED} />;
}
