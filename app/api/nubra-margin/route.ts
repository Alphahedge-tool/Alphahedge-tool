import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const sessionToken = req.headers.get('x-session-token');
  const deviceId = req.headers.get('x-device-id') ?? 'web';

  if (!sessionToken) {
    return NextResponse.json({ error: 'Missing session token' }, { status: 401 });
  }

  const res = await fetch('https://api.nubra.io/orders/v2/margin_required', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
