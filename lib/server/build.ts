import 'server-only';

/**
 * Which deployment is answering.
 *
 * Deliberately not a `NEXT_PUBLIC_` variable, and deliberately not the version
 * number. Two deployments of v1.1 are different code, so a player sitting on
 * the first should still be offered the second; and a version a human types is
 * a version somebody will forget to bump on the day it matters.
 *
 * The page is statically rendered, so the commit read here is baked into the
 * HTML by the build that produced it, and the API route reads it fresh on every
 * request. A client comparing the two is therefore comparing *the build that
 * served me* against *the build serving now* — which is exactly the question,
 * and it needs no bookkeeping on either side.
 *
 * Where no such stamp exists — a local `next start`, a plain container — every
 * answer is the same string, the comparison never differs, and nobody is ever
 * nagged. That is the right behaviour for a build that is not being
 * redeployed under anybody.
 */
export function buildId(): string {
  const stamp = process.env.EMERGE_BUILD_ID
    || process.env.VERCEL_DEPLOYMENT_ID
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.RENDER_GIT_COMMIT
    || process.env.SOURCE_VERSION;
  return stamp ? stamp.slice(0, 16) : 'local';
}
