import { NextResponse } from 'next/server';

const APP_ID     = process.env.DHAN_APP_ID!;
const APP_SECRET = process.env.DHAN_APP_SECRET!;
const CLIENT_ID  = process.env.DHAN_CLIENT_ID!;

export async function POST() {
  try {
    const res = await fetch(
      `https://auth.dhan.co/app/generate-consent?client_id=${CLIENT_ID}`,
      {
        method: 'POST',
        headers: { app_id: APP_ID, app_secret: APP_SECRET },
      }
    );
    const data = await res.json();
    if (!res.ok) return NextResponse.json(data, { status: res.status });

    const loginUrl = `https://auth.dhan.co/login/consentApp-login?consentAppId=${data.consentAppId}`;
    return NextResponse.json({ consentAppId: data.consentAppId, loginUrl });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
