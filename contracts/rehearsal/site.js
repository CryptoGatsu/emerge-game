/* Talking to the app under test: a signed session cookie for a wallet, and the JSON routes. */
const { createHmac } = require('crypto');
const SECRET = Buffer.from(process.env.SESSION_SECRET ?? 'this-is-a-test-secret-for-the-market-route', 'utf8');
const BASE = (process.env.SITE ?? 'http://localhost:3471').replace(/\/$/, '');
const CRON = process.env.CRON_SECRET_UNDER_TEST ?? 'test-cron';
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
const cookieFor = (a) => {
  const expires = Date.now() + 3600_000;
  const body = `${a.toLowerCase()}.${expires}`;
  return { name: 'emerge_session', value: `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`, domain: new URL(BASE).hostname, path: '/' };
};
const api = async (path, body, who, extraHeaders = {}) => {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (who) headers.cookie = `emerge_session=${cookieFor(who).value}`;
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
};
const OP = { authorization: `Bearer ${CRON}` };
module.exports = { ok, cookieFor, api, BASE, OP };
