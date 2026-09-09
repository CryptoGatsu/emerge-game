/**
 * Whether a request comes from the deployment itself — the cron, or the
 * team putting something right by hand — rather than from a player.
 *
 * The secret is the deployment's own and is never a session: a player's
 * cookie proves a wallet, this proves the operator, and the two are never
 * interchangeable.
 */
export function operator(request: Request): boolean {
  const secret = process.env.EMERGE_CRON_SECRET ?? process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return auth === `Bearer ${secret}` || request.headers.get('x-cron-secret') === secret;
}
