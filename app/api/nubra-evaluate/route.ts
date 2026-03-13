import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const sessionToken = req.headers.get('x-session-token');
  const deviceId = req.headers.get('x-device-id') ?? 'web';
  const rawCookie = req.headers.get('x-raw-cookie') ?? '';

  if (!sessionToken) {
    return NextResponse.json({ error: 'Missing session token' }, { status: 401 });
  }

  // Use the full raw cookie string stored at login (authToken + sessionToken)
  // Fall back to constructing it from sessionToken if not available
  const cookieHeader = rawCookie || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  const res = await fetch('https://api.nubra.io/strategies/strat1/evaluate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Cookie': cookieHeader,
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://nubra.io',
      'Referer': 'https://nubra.io/',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
