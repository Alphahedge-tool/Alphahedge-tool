import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const refId  = searchParams.get('ref_id');
  const levels = searchParams.get('levels') ?? '1';
  const sessionToken = req.headers.get('x-session-token');
  const deviceId     = req.headers.get('x-device-id') ?? 'web';

  if (!sessionToken) return NextResponse.json({ error: 'Missing session token' }, { status: 401 });
  if (!refId)        return NextResponse.json({ error: 'Missing ref_id' },        { status: 400 });

  const res = await fetch(`https://api.nubra.io/orderbooks/${refId}?levels=${levels}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'x-device-id':   deviceId,
    },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
