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
 * So the document is marked as something to check before reusing. `no-cache`
 * does not mean "do not store" — it means "ask first", which is exactly right
 * here: the answer is usually 304 and costs nothing, and when it is not, the
 * player gets the new build instead of the old one for ever.
 *
 * Only the documents. Everything under `/_next/static` is content-hashed, so
 * a new build has new filenames and those files are immutable by construction;
 * Next sets that header itself and this must not weaken it.
 */
const documents = [
  { key: 'Cache-Control', value: 'public, no-cache, must-revalidate' },
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
