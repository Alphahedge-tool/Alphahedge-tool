import { NextRequest, NextResponse } from 'next/server';

const APP_ID     = process.env.DHAN_APP_ID!;
const APP_SECRET = process.env.DHAN_APP_SECRET!;

export async function POST(req: NextRequest) {
  try {
    const { tokenId } = await req.json();
    if (!tokenId) return NextResponse.json({ error: 'tokenId required' }, { status: 400 });

    const res = await fetch(
      `https://auth.dhan.co/app/consumeApp-consent?tokenId=${tokenId}`,
      { method: 'GET', headers: { app_id: APP_ID, app_secret: APP_SECRET } }
    );
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });

    // Returns: dhanClientId, dhanClientName, accessToken, expiryTime
    return NextResponse.json(data);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
