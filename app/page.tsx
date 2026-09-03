import EmergeClient from '@/components/EmergeClient';
import { UpdateNotice } from '@/components/UpdateNotice';
import { buildId } from '@/lib/server/build';

/**
 * This page is statically rendered, which is what makes the update check work:
 * the build stamp read here is baked into the HTML by the build that produced
 * it, so a tab always knows which deployment served it, however long it has
 * been open.
 */
export default function Page() {
  return (
    <>
      <EmergeClient />
      <UpdateNotice build={buildId()} />
    </>
  );
}
