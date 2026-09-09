import type { NextConfig } from 'next';

/**
 * What a browser is allowed to keep.
 *
 * The pages are statically rendered, which is what makes the update check
 * work: the build that produced the HTML is baked into it, so a tab always
 * knows which deployment served it. The cost of that is a document a browser
 * is very willing to hold on to — and an in-app wallet browser holds on to it
 * hardest. A player on the OKX wallet's browser reported disconnecting,
 * clearing the cache and coming back to the same old build, over and over: the
 * WebView was serving its own copy of the document and never asking us whether
 * there was a newer one.
 *
 * So the document is marked as something to check before reusing. `max-age=0,
 * must-revalidate` does not mean "do not store" — it means "ask first", which
 * is exactly right here: the answer is usually a 304 and costs nothing, and
 * when it is not, the player gets the new build instead of the old one for
 * ever.
 *
 * `s-maxage` is kept, and it is the reason this is not simply `no-cache`. Next
 * sends `s-maxage=31536000` on a statically rendered page so the CDN in front
 * of the app serves it without touching the origin, and the deployment purges
 * that edge cache — so the CDN is never the thing holding an old build. Take
 * `s-maxage` away and every visit becomes an origin request for no benefit at
 * all. The split is the point: the shared cache may keep the document, the
 * browser must ask before reusing it.
 *
 * Only the documents. Everything under `/_next/static` is content-hashed, so
 * a new build has new filenames and those files are immutable by construction;
 * Next sets that header itself and this must not weaken it.
 */
const documents = [
  { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate, s-maxage=31536000' },
];

const config: NextConfig = {
  async headers() {
    return [
      { source: '/', headers: documents },
      { source: '/wiki', headers: documents },
      { source: '/wiki/:path*', headers: documents },
    ];
  },
};

export default config;
