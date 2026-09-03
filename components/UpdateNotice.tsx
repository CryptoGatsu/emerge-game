'use client';

/**
 * "There is a newer version of Emerge."
 *
 * A running client has no way to know the site under it has been redeployed —
 * it keeps executing the JavaScript it downloaded, indefinitely, and a player
 * with a tab open for two days is playing two-day-old code. This is the one
 * thing that tells them.
 *
 * **It never reloads by itself.** A settlement is live state in a tab, and a
 * page that refreshes itself out from under somebody mid-build is worse than
 * one that is out of date. So it offers, and the player decides. It can also
 * be dismissed, and stays dismissed for that build.
 *
 * The comparison is between *the build that served this page* — baked into the
 * HTML that produced this tab — and *the build serving requests now*. Where
 * neither exists (a local server, a plain container) both are the same string
 * forever and this renders nothing, which is right: nothing is being deployed
 * under anybody.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How often a running client asks whether it is still current.
 *
 * Slow. The answer changes a few times a week at most, the request is one
 * environment variable read, and there is no hurry: somebody mid-session is
 * not harmed by learning ninety seconds later. The check also runs when a tab
 * is brought back to the front, which is when most people find out anyway.
 */
const CHECK_INTERVAL = 5 * 60_000;

export function UpdateNotice({ build }: { build: string }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Held in a ref as well as state so the poll can read it without being torn
  // down and rebuilt every time it changes.
  const seen = useRef(build);

  const check = useCallback(async () => {
    try {
      const response = await fetch('/api/version', { cache: 'no-store' });
      if (!response.ok) return;
      const json = (await response.json()) as { build?: string };
      const now = typeof json.build === 'string' ? json.build : null;
      // 'local' is the answer from a deployment with no stamp at all. Comparing
      // it would mean nagging every developer forever.
      if (!now || now === 'local' || now === seen.current) return;
      setWaiting(now);
    } catch {
      // Offline, or the relay is down. Neither is news about the build.
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => { void check(); }, CHECK_INTERVAL);
    // Coming back to a tab is the moment a person is most willing to be told,
    // and the moment they are most likely to have missed a deployment.
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  if (!waiting || dismissed === waiting) return null;

  return (
    <div className="update-notice" role="status">
      <div>
        <b>A new version of Emerge is out.</b>
        <span>Reload when you are ready — your world and your land are safe.</span>
      </div>
      <div className="update-actions">
        <button className="update-reload" onClick={() => window.location.reload()}>Reload</button>
        {/* No aria-label: the word on the button is already the label, and an
            override that says something else is a button that reads one way to
            a sighted player and another to a screen reader. */}
        <button className="update-later" onClick={() => setDismissed(waiting)}>Later</button>
      </div>
    </div>
  );
}
