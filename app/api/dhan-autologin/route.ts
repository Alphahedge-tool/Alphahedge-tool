import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';

const CLIENT_ID  = process.env.DHAN_CLIENT_ID!;
const PIN        = process.env.DHAN_PIN!;
const TOTP_SECRET = process.env.DHAN_TOTP_SECRET!;

function base32Decode(str: string): Buffer {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = str.toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s) {
    value = (value << 5) | alpha.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTotp(secret: string): string {
  const key     = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf     = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac   = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

export async function POST() {
  try {
    const totp = generateTotp(TOTP_SECRET);

    console.log('[dhan-autologin] totp:', totp, 'pin:', PIN, 'clientId:', CLIENT_ID);
    const res = await fetch(
      `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${CLIENT_ID}&pin=${PIN}&totp=${totp}`,
      { method: 'POST' }
    );
    const data = await res.json();
    console.log('[dhan-autologin] response:', JSON.stringify(data));
    if (data.status === 'error') return NextResponse.json({ error: data.message ?? JSON.stringify(data), debug_totp: totp, debug_pin: PIN, debug_clientId: CLIENT_ID }, { status: 400 });

    // Returns: accessToken, dhanClientId, dhanClientName, expiryTime
    return NextResponse.json(data);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
