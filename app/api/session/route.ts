/**
 * Signing in.
 *
 * `GET    /api/session` — which wallet, if any, this browser has proved.
 * `POST   /api/session` — prove one, with a signature.
 * `DELETE /api/session` — forget it.
 *
 * The message is composed here rather than accepted from the caller, so a
 * client cannot ask a wallet to sign something of its own choosing and pass
 * that off as a sign-in.
 */

import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE, openSession, sessionAddress, sessionMessage, sessionsAvailable,
} from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** The host, as the signed message names it. */
const hostOf = (request: Request) =>
  request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'emerge';

export async function GET(request: Request) {
  return NextResponse.json({
    address: sessionAddress(request),
    available: sessionsAvailable(),
  });
}

/** What a wallet is being asked to sign, so the client never composes it. */
export async function PUT(request: Request) {
  let body: { address?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }
  const address = String(body.address ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: 'That is not a wallet address.' }, { status: 400 });
  }
  const issuedAt = Date.now();
  return NextResponse.json({ message: sessionMessage(address, hostOf(request), issuedAt), issuedAt });
}

export async function POST(request: Request) {
  let body: { address?: string; signature?: string; issuedAt?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const result = await openSession(
    String(body.address ?? ''),
    String(body.signature ?? ''),
    Number(body.issuedAt),
    hostOf(request),
  );
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 401 });

  const response = NextResponse.json({ address: String(body.address).toLowerCase() });
  response.cookies.set(SESSION_COOKIE, result.cookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: result.maxAge,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ address: null });
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return response;
}
