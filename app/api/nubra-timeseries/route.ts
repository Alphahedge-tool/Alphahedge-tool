import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const { chart, query, rawCookie: bodyCookie } = await req.json();
  const sessionToken = req.headers.get('x-session-token');
  const deviceId = req.headers.get('x-device-id') ?? 'web';
  const rawCookie = req.headers.get('x-raw-cookie') || bodyCookie || '';

  if (!sessionToken) {
    return NextResponse.json({ error: 'Missing session token' }, { status: 401 });
  }

  const cookieHeader = rawCookie || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  const res = await fetch(`https://api.nubra.io/charts/timeseries?chart=${encodeURIComponent(chart)}`, {
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
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
