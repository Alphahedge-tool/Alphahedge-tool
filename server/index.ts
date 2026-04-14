import Fastify from 'fastify';
import { fetch, Agent } from 'undici';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── RFC 6238 TOTP — no external deps ─────────────────────────────────────────
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

// ── Load .env / .env.local manually (no dotenv dep needed) ───────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const name of ['.env', '.env.local']) {
  const envPath = join(__dirname, '..', name);
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const app = Fastify({ logger: false });

// Allow cross-origin requests from Vite dev server (localhost:5173)
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers['origin'] ?? '';
  if (origin === 'http://localhost:5173' || origin === 'http://localhost:8888') {
    reply.header('Access-Control-Allow-Origin', origin);
  }
  reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type,x-session-token,x-device-id,x-raw-cookie');
  if (req.method === 'OPTIONS') { reply.status(204).send(); }
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI  ?? 'http://localhost:8888/auth/google/callback';

// Step 1 — redirect to Google consent screen
app.get('/auth/google', async (_req, reply) => {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2 — handle callback, exchange code for tokens, redirect to app
app.get('/auth/google/callback', async (req, reply) => {
  const { code, error } = req.query as Record<string, string>;
  if (error || !code) {
    return reply.redirect('/?auth_error=access_denied');
  }
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json() as any;
    if (!tokens.access_token) {
      return reply.redirect('/?auth_error=token_failed');
    }
    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json() as any;
    // Encode user info and redirect to app with it in query params
    const userData = encodeURIComponent(JSON.stringify({
      name:    user.name,
      email:   user.email,
      picture: user.picture,
      sub:     user.sub,
    }));
    return reply.redirect(`http://localhost:8888/?google_user=${userData}`);
  } catch (e: any) {
    return reply.redirect(`http://localhost:8888/?auth_error=${encodeURIComponent(e.message)}`);
  }
});

// Keep-alive connection pool to service.upstox.com
const upstoxAgent = new Agent({
  connect: { keepAlive: true },
  connections: 10,
  pipelining: 1,
});

const RETRYABLE_UPSTOX_STATUS = new Set([429, 464, 500, 502, 503, 504]);

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchUpstox(instrumentKey: string, interval: string, from: string, limit: string): Promise<{ candles: number[][]; prevTimestamp: number | null }> {
  const params = new URLSearchParams({ instrumentKey, interval, from, limit });
  const url = `https://service.upstox.com/chart/open/v3/candles?${params}`;
  const res = await fetch(url, { dispatcher: upstoxAgent } as any);
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const json = await res.json() as any;
  return {
    candles: json?.data?.candles ?? [],
    prevTimestamp: json?.data?.meta?.prevTimestamp ?? null,
  };
}

async function fetchUpstoxWithRetry(
  instrumentKey: string,
  interval: string,
  from: string,
  limit: string,
  maxAttempts = 4,
): Promise<{ candles: number[][]; prevTimestamp: number | null }> {
  let lastErr: unknown = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fetchUpstox(instrumentKey, interval, from, limit);
    } catch (e) {
      lastErr = e;
      const status = (e as any)?.status;
      const retryable = status != null ? RETRYABLE_UPSTOX_STATUS.has(status) : true;
      if (!retryable || i === maxAttempts - 1) throw e;
      await delay(120 * (2 ** i) + Math.floor(Math.random() * 80));
    }
  }
  throw lastErr ?? new Error('upstream failed');
}

app.get('/api/public-candles', async (req, reply) => {
  const { instrumentKey, interval, from, limit } = req.query as Record<string, string>;
  if (!instrumentKey || !from) return reply.status(400).send({ error: 'missing params' });

  const ivRaw = interval ?? 'I1';
  // Map UI interval codes → Upstox API interval strings
  const IV_MAP: Record<string, string> = { I1: 'I1', I5: 'I5', I15: 'I15', I30: 'I30', I60: 'I60', I1D: '1D' };
  const iv = IV_MAP[ivRaw] ?? ivRaw;
  const lim = limit ?? '375';

  try {
    const fresh = await fetchUpstoxWithRetry(instrumentKey, iv, from, lim);
    return { data: { candles: fresh.candles, meta: { prevTimestamp: fresh.prevTimestamp } } };
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// Batch candles endpoint to reduce frontend request pressure:
// POST /api/public-candles-batch
// Body: { instrumentKeys: string[], interval?: string, from: string, limit?: string }
app.post('/api/public-candles-batch', async (req, reply) => {
  const body = (req.body ?? {}) as {
    instrumentKeys?: string[];
    interval?: string;
    from?: string;
    limit?: string;
  };

  const keys = Array.from(new Set(body.instrumentKeys ?? [])).filter(Boolean).slice(0, 60);
  if (!keys.length || !body.from) {
    return reply.status(400).send({ error: 'instrumentKeys[] and from are required' });
  }

  const ivRaw = body.interval ?? 'I1';
  const IV_MAP: Record<string, string> = { I1: 'I1', I5: 'I5', I15: 'I15', I30: 'I30', I60: 'I60', I1D: '1D' };
  const iv = IV_MAP[ivRaw] ?? ivRaw;
  const lim = body.limit ?? '375';

  const data: Record<string, { candles: number[][]; meta: { prevTimestamp: number | null } }> = {};
  const errors: Record<string, string> = {};

  const CONCURRENCY = 3;
  let cursor = 0;

  const worker = async () => {
    while (cursor < keys.length) {
      const idx = cursor++;
      const key = keys[idx];
      try {
        let res = await fetchUpstoxWithRetry(key, iv, body.from!, lim);
        // If current page empty, auto-fallback one page back within same batch call
        if (res.candles.length === 0 && res.prevTimestamp != null) {
          res = await fetchUpstoxWithRetry(key, iv, String(res.prevTimestamp), lim);
        }
        data[key] = { candles: res.candles, meta: { prevTimestamp: res.prevTimestamp } };
      } catch (e: any) {
        errors[key] = String(e?.message ?? e);
      }
      // Short pacing to avoid burst pressure on upstream
      await delay(20);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()));
    return reply.send({
      data,
      errors,
      meta: {
        requested: keys.length,
        success: Object.keys(data).length,
        failed: Object.keys(errors).length,
      },
    });
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// Proxy instruments gz — cache forever (file doesn't change often)
let instrumentsCache: Buffer | null = null;
app.get('/instruments-gz', async (_req, reply) => {
  if (instrumentsCache) {
    reply.header('Content-Type', 'application/gzip');
    reply.header('X-Cache', 'HIT');
    return reply.send(instrumentsCache);
  }
  const res = await fetch(
    'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz',
    { dispatcher: upstoxAgent } as any,
  );
  instrumentsCache = Buffer.from(await res.arrayBuffer());
  reply.header('Content-Type', 'application/gzip');
  return reply.send(instrumentsCache);
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra.io TOTP Auto-Login
// 2-step: totp/login (phone + auto-TOTP) → verifypin (MPIN) → session_token
// The TOTP code is generated server-side from the user's secret — fully automated.
// ─────────────────────────────────────────────────────────────────────────────

const NUBRA_API = 'https://api.nubra.io';
const SDK_VERSION = '0-3-8';

// Stable device ID — generated once and persisted to disk.
// Nubra ties sessions to device IDs, so this must never change.
const DEVICE_ID_FILE = join(__dirname, 'nubra_device.json');
function getDeviceId(): string {
  try {
    if (existsSync(DEVICE_ID_FILE)) {
      const saved = JSON.parse(readFileSync(DEVICE_ID_FILE, 'utf8'));
      if (saved.device_id) return saved.device_id;
    }
  } catch {}
  const id = `${randomUUID()}-sdk-${SDK_VERSION}`;
  try { writeFileSync(DEVICE_ID_FILE, JSON.stringify({ device_id: id }), 'utf8'); } catch {}
  return id;
}

const nubraAuthAgent = new Agent({
  connect: { keepAlive: true },
  connections: 5,
  pipelining: 1,
});

// Generate a TOTP code for Nubra (RFC 6238, 6-digit, 30s step)
function generateTOTP(secret: string, windowOffset = 0): string {
  const key     = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + windowOffset;
  const buf     = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac   = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}

// Safe JSON parse helper — handles empty or non-JSON responses from Nubra
async function safeJson(res: any, label: string): Promise<any> {
  const text = await res.text();
  const ct = res.headers.get?.('content-type') ?? '';
  const cl = res.headers.get?.('content-length') ?? '';
  console.log(`[nubra ${label}] ${res.status} ct=${ct} cl=${cl} body(${text.length})=${text.slice(0, 500)}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

// ── TOTP One-Time Setup ──────────────────────────────────────────────────────
// Step A: Send SMS OTP to phone
// Handles the 'next' field — if VERIFY_TOTP, re-sends with skip_totp=true
app.post('/api/nubra-send-otp', async (req, reply) => {
  const { phone } = req.body as { phone: string };
  if (!phone) return reply.status(400).send({ error: 'phone is required' });

  try {
    const res = await fetch(`${NUBRA_API}/sendphoneotp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, skip_totp: false }),
      dispatcher: nubraAuthAgent,
    } as any);
    const data = await safeJson(res, 'sendphoneotp');

    if (!res.ok || !data.temp_token) {
      return reply.status(res.status || 502).send(data);
    }

    const nextStep = data.next;

    // If TOTP is already enabled, Nubra returns next=VERIFY_TOTP.
    // We need to re-call with skip_totp=true + x-temp-token to force SMS OTP.
    if (nextStep === 'VERIFY_TOTP') {
      const res2 = await fetch(`${NUBRA_API}/sendphoneotp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-temp-token': data.temp_token,
        },
        body: JSON.stringify({ phone, skip_totp: true }),
        dispatcher: nubraAuthAgent,
      } as any);
      const data2 = await safeJson(res2, 'sendphoneotp-skip');
      if (!res2.ok || !data2.temp_token) {
        return reply.status(res2.status || 502).send(data2);
      }
      return reply.send(data2);
    }

    // next=VERIFY_MOBILE — OTP was sent, return temp_token
    return reply.send(data);
  } catch (e: any) {
    console.error('[nubra send-otp error]', e);
    return reply.status(502).send({ error: e.message });
  }
});

// Step B: Full TOTP setup — verify OTP → verify MPIN → generate secret → enable TOTP
// Returns the secret_key that the user saves for automated daily login
app.post('/api/nubra-setup-totp', async (req, reply) => {
  const { phone, otp, mpin, temp_token } = req.body as {
    phone: string; otp: string; mpin: string; temp_token: string;
  };
  if (!phone || !otp || !mpin || !temp_token) {
    return reply.status(400).send({ error: 'phone, otp, mpin, and temp_token are required' });
  }

  const deviceId = getDeviceId();

  try {
    // 1. Verify OTP → auth_token (SDK expects 201)
    const r1 = await fetch(`${NUBRA_API}/verifyphoneotp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-temp-token': temp_token,
        'x-device-id': deviceId,
      },
      body: JSON.stringify({ phone, otp }),
      dispatcher: nubraAuthAgent,
    } as any);
    const d1 = await safeJson(r1, 'verifyphoneotp');
    const authToken = d1.data?.auth_token ?? d1.auth_token;
    if ((r1.status !== 200 && r1.status !== 201) || !authToken) {
      return reply.status(r1.status || 502).send({ error: 'OTP verification failed', step: 1, detail: d1 });
    }

    // 2. Verify MPIN → session_token
    const r2 = await fetch(`${NUBRA_API}/verifypin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId,
      },
      body: JSON.stringify({ pin: mpin }),
      dispatcher: nubraAuthAgent,
    } as any);
    const d2 = await safeJson(r2, 'verifypin');
    const sessionToken = d2.data?.session_token ?? d2.session_token ?? d2.data?.token;
    if (!r2.ok || !sessionToken) {
      return reply.status(r2.status || 502).send({ error: 'MPIN verification failed', step: 2, detail: d2 });
    }

    // 3. Disable existing TOTP first (in case it was already enabled)
    await fetch(`${NUBRA_API}/totp/disable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'x-device-id': deviceId,
      },
      body: JSON.stringify({ mpin }),
      dispatcher: nubraAuthAgent,
    } as any).then(r => safeJson(r, 'totp/disable')).catch(() => {});
    // OK if this fails (TOTP might not be enabled yet), just continue

    // 4. Generate fresh TOTP secret
    const r3 = await fetch(`${NUBRA_API}/totp/generate-secret`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'x-device-id': deviceId,
      },
      dispatcher: nubraAuthAgent,
    } as any);
    const d3 = await safeJson(r3, 'totp/generate-secret');
    // Response is { data: { secret_key, qr_image }, message }
    const secretKey = d3.data?.secret_key ?? d3.secret_key;
    if (!r3.ok || !secretKey) {
      return reply.status(r3.status || 502).send({ error: 'Failed to generate TOTP secret', step: 3, detail: d3 });
    }

    // 5. Enable TOTP using the freshly generated secret
    // Try current window then ±1 to handle clock skew; send as integer (Nubra requires uint32)
    let r4: any = null;
    let d4: any = null;
    for (const wo of [0, -1, 1]) {
      const totpStr = generateTOTP(secretKey, wo);
      console.log(`[nubra setup-totp] totp/enable offset=${wo} totp=${totpStr}`);
      r4 = await fetch(`${NUBRA_API}/totp/enable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
          'x-device-id': deviceId,
        },
        body: JSON.stringify({ mpin, totp: totpStr }),
        dispatcher: nubraAuthAgent,
      } as any);
      d4 = await safeJson(r4, 'totp/enable');
      if (r4.ok) break;
    }
    if (!r4.ok) {
      return reply.status(r4.status || 502).send({ error: 'Failed to enable TOTP', step: 4, detail: d4 });
    }

    return reply.send({
      secret_key: secretKey,
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
    });
  } catch (e: any) {
    console.error('[nubra setup-totp error]', e);
    return reply.status(502).send({ error: e.message });
  }
});

// ── Daily automated login (phone + mpin + totp_secret → session_token) ───────
app.post('/api/nubra-login', async (req, reply) => {
  const { phone, mpin, totp_secret } = req.body as {
    phone: string;
    mpin: string;
    totp_secret: string;
  };

  if (!phone || !mpin || !totp_secret) {
    return reply.status(400).send({ error: 'phone, mpin, and totp_secret are required' });
  }

  const deviceId = getDeviceId();

  try {
    // Step 1: TOTP login → auth_token
    // Try current window then ±1 to handle clock skew; send as integer (Nubra requires uint32)
    let step1: any = null;
    let step1Data: any = null;
    let authToken: string | undefined;

    for (const windowOffset of [0, -1, 1]) {
      const totpInt = parseInt(generateTOTP(totp_secret, windowOffset), 10);
      const res = await fetch(`${NUBRA_API}/totp/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-device-origin': 'DESKTOP',
        },
        body: JSON.stringify({ phone, totp: totpInt }),
        dispatcher: nubraAuthAgent,
      } as any);
      const data = await res.json() as any;
      console.log(`[nubra-login] totp/login offset=${windowOffset} totp=${totpInt} status=${res.status}`, JSON.stringify(data).slice(0, 200));
      authToken = data.auth_token ?? data.data?.auth_token;
      step1 = res;
      step1Data = data;
      if ((res.status === 200 || res.status === 201) && authToken) break;
    }

    const totpNotEnabled =
      step1Data?.detail?.error?.includes('not enabled') ||
      step1Data?.error?.includes('not enabled') ||
      JSON.stringify(step1Data ?? '').toLowerCase().includes('not enabled');

    if (!step1 || (step1.status !== 200 && step1.status !== 201) || !authToken) {
      // ── TOTP not enabled: fall back to OTP login → MPIN → re-enable TOTP ──
      if (totpNotEnabled) {
        console.log('[nubra-login] TOTP not enabled — falling back to OTP + MPIN login, then re-enabling TOTP');
        try {
          // 1. sendphoneotp (skip_totp:false) → temp_token
          const otp1Res = await fetch(`${NUBRA_API}/sendphoneotp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, skip_totp: false }),
            dispatcher: nubraAuthAgent,
          } as any);
          const otp1Data = await otp1Res.json() as any;
          console.log('[nubra-login fallback] sendphoneotp step1', otp1Res.status, JSON.stringify(otp1Data).slice(0, 200));
          if (!otp1Data.temp_token) throw new Error('sendphoneotp step1 failed: ' + JSON.stringify(otp1Data));

          // 2. sendphoneotp (skip_totp:true, x-temp-token) → new temp_token (forces SMS OTP)
          const otp2Res = await fetch(`${NUBRA_API}/sendphoneotp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-temp-token': otp1Data.temp_token },
            body: JSON.stringify({ phone, skip_totp: true }),
            dispatcher: nubraAuthAgent,
          } as any);
          const otp2Data = await otp2Res.json() as any;
          console.log('[nubra-login fallback] sendphoneotp step2', otp2Res.status, JSON.stringify(otp2Data).slice(0, 200));
          const tempToken = otp2Data.temp_token ?? otp1Data.temp_token;

          // Return 202 so frontend knows to ask user for OTP
          return reply.status(202).send({
            error: 'totp_not_enabled',
            temp_token: tempToken,
            message: 'TOTP not enabled. OTP sent to phone — enter OTP to re-enable TOTP automatically.',
          });
        } catch (fallbackErr: any) {
          console.error('[nubra-login] OTP fallback failed', fallbackErr.message);
          return reply.status(502).send({ error: 'TOTP not enabled and OTP fallback failed: ' + fallbackErr.message });
        }
      }

      return reply.status(step1?.status ?? 502).send({
        error: 'TOTP login failed',
        detail: step1Data,
      });
    }

    // Step 2: Verify MPIN → session_token
    const step2 = await fetch(`${NUBRA_API}/verifypin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'x-device-id': deviceId,
        'x-device-origin': 'DESKTOP',
      },
      body: JSON.stringify({ pin: mpin }),
      dispatcher: nubraAuthAgent,
    } as any);

    const step2Data = await step2.json() as any;
    console.log(`[nubra-login] verifypin ${step2.status}`, JSON.stringify(step2Data).slice(0, 300));
    // PROD may nest under data: { session_token } or top-level
    const sessionToken = step2Data.session_token ?? step2Data.data?.session_token ?? step2Data.data?.token;
    if (!step2.ok || !sessionToken) {
      return reply.status(step2.status).send({
        error: 'MPIN verification failed',
        detail: step2Data,
      });
    }

    return reply.send({
      session_token: sessionToken,
      auth_token: authToken,
      device_id: deviceId,
      userId: step2Data.userId ?? step2Data.data?.userId,
      email: step2Data.email ?? step2Data.data?.email,
      phone: step2Data.phone ?? step2Data.data?.phone,
    });
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ── OTP verify + re-enable TOTP (called when totp_not_enabled fallback triggered) ──
// Flow: verifyphoneotp → verifypin → disable old TOTP → generate-secret → enable TOTP
app.post('/api/nubra-otp-reenable-totp', async (req, reply) => {
  const { phone, otp, mpin, temp_token, totp_secret } = req.body as {
    phone: string; otp: string; mpin: string; temp_token: string; totp_secret: string;
  };
  if (!phone || !otp || !mpin || !temp_token || !totp_secret) {
    return reply.status(400).send({ error: 'phone, otp, mpin, temp_token, and totp_secret are required' });
  }
  const deviceId = getDeviceId();
  try {
    // 1. Verify OTP → auth_token
    const r1 = await fetch(`${NUBRA_API}/verifyphoneotp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-temp-token': temp_token, 'x-device-id': deviceId },
      body: JSON.stringify({ phone, otp }),
      dispatcher: nubraAuthAgent,
    } as any);
    const d1 = await r1.json() as any;
    console.log('[nubra-otp-reenable] verifyphoneotp', r1.status, JSON.stringify(d1).slice(0, 200));
    const authToken = d1.auth_token ?? d1.data?.auth_token;
    if ((r1.status !== 200 && r1.status !== 201) || !authToken) {
      return reply.status(r1.status || 502).send({ error: 'OTP verification failed', detail: d1 });
    }

    // 2. Verify MPIN → session_token
    const r2 = await fetch(`${NUBRA_API}/verifypin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, 'x-device-id': deviceId },
      body: JSON.stringify({ pin: mpin }),
      dispatcher: nubraAuthAgent,
    } as any);
    const d2 = await r2.json() as any;
    console.log('[nubra-otp-reenable] verifypin', r2.status, JSON.stringify(d2).slice(0, 200));
    const sessionToken = d2.session_token ?? d2.data?.session_token ?? d2.data?.token;
    if (!r2.ok || !sessionToken) {
      return reply.status(r2.status || 502).send({ error: 'MPIN verification failed', detail: d2 });
    }

    // 3. Disable existing TOTP (ignore failure — may not be enabled)
    await fetch(`${NUBRA_API}/totp/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}`, 'x-device-id': deviceId },
      body: JSON.stringify({ mpin }),
      dispatcher: nubraAuthAgent,
    } as any).catch(() => {});

    // 4. Generate fresh TOTP secret
    const r3 = await fetch(`${NUBRA_API}/totp/generate-secret`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'x-device-id': deviceId },
      dispatcher: nubraAuthAgent,
    } as any);
    const d3 = await r3.json() as any;
    console.log('[nubra-otp-reenable] generate-secret', r3.status, JSON.stringify(d3).slice(0, 200));
    const secretKey = d3.data?.secret_key ?? d3.secret_key;
    if (!r3.ok || !secretKey) {
      return reply.status(r3.status || 502).send({ error: 'Failed to generate TOTP secret', detail: d3 });
    }

    // 5. Enable TOTP with ±1 window for clock skew
    let r4: any = null; let d4: any = null;
    for (const wo of [0, -1, 1]) {
      const totpStr = generateTOTP(secretKey, wo);
      console.log(`[nubra-otp-reenable] totp/enable offset=${wo} totp=${totpStr}`);
      r4 = await fetch(`${NUBRA_API}/totp/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}`, 'x-device-id': deviceId },
        body: JSON.stringify({ mpin, totp: totpStr }),
        dispatcher: nubraAuthAgent,
      } as any);
      d4 = await r4.json() as any;
      if (r4.ok) break;
    }
    if (!r4.ok) {
      return reply.status(r4.status || 502).send({ error: 'Failed to enable TOTP', detail: d4 });
    }

    console.log('[nubra-otp-reenable] TOTP re-enabled successfully, secret_key updated');
    return reply.send({
      session_token: sessionToken,
      auth_token: authToken,
      secret_key: secretKey,
      device_id: deviceId,
    });
  } catch (e: any) {
    console.error('[nubra-otp-reenable error]', e.message);
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra.io Multi-Strike IV proxy
// Forwards POST to https://api.nubra.io/charts/timeseries with the caller's
// authToken + sessionToken cookies injected, bypassing browser CORS.
// ─────────────────────────────────────────────────────────────────────────────

const nubraAgent = new Agent({
  connect: { keepAlive: true },
  connections: 5,
  pipelining: 1,
});

function buildNubraCookie(rawCookie: string, sessionToken: string, authToken: string, deviceId: string): string {
  const map = new Map<string, string>();
  for (const part of String(rawCookie || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }

  if (authToken) map.set('authToken', authToken);
  if (sessionToken) map.set('sessionToken', sessionToken);
  if (deviceId) map.set('deviceId', deviceId);

  if (!map.get('authToken') && sessionToken) map.set('authToken', sessionToken);
  if (!map.get('sessionToken') && sessionToken) map.set('sessionToken', sessionToken);
  if (!map.get('deviceId') && deviceId) map.set('deviceId', deviceId);

  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

app.post('/api/nubra-timeseries', async (req, reply) => {
  const body = req.body as {
    rawCookie?: string;
    query: unknown[];
    chart?: string;
  };

  const headers = req.headers;
  const sessionToken = (headers['x-session-token'] as string) ?? '';
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (headers['x-raw-cookie'] as string) ?? '';

  const { rawCookie: rawCookieBody, query, chart = 'Multi-Strike_IV' } = body ?? {};
  const rawCookie = rawCookieHdr || rawCookieBody || '';

  if (!Array.isArray(query)) {
    return reply.status(400).send({ error: 'query[] is required' });
  }

  const targetUrl = `https://api.nubra.io/charts/timeseries?chart=${encodeURIComponent(chart)}`;
  const cookieStr = buildNubraCookie(rawCookie, sessionToken, '', deviceId);

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': cookieStr,
        'x-device-id': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ query }),
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra PCR (Put_Call_Ratio) proxy
// POST /api/nubra-pcr → https://api.nubra.io/charts/timeseries?chart=Put_Call_Ratio
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nubra-pcr', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = (headers['x-session-token'] as string) ?? '';
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (headers['x-raw-cookie'] as string) ?? '';

  const body = req.body as { query: unknown[] };
  if (!Array.isArray(body?.query)) {
    return reply.status(400).send({ error: 'query[] is required' });
  }

  const rawCookie = rawCookieHdr || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;
  const targetUrl = `https://api.nubra.io/charts/timeseries?chart=Put_Call_Ratio`;

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': rawCookie,
        'x-device-id': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ query: body.query }),
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra Multistrike OI proxy
// POST /api/nubra-multistrike → https://api.nubra.io/charts/multistrike?chart=...
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nubra-multistrike', async (req, reply) => {
  const body = req.body as {
    rawCookie?: string;
    query: unknown[];
    chart?: string;
  };

  const hdrs = req.headers;
  const sessionToken2 = (hdrs['x-session-token'] as string) ?? '';
  const deviceId2     = (hdrs['x-device-id'] as string) ?? 'web';
  const rawCookieHdr2 = (hdrs['x-raw-cookie'] as string) ?? '';

  const { rawCookie: rawCookieBody2, query, chart = 'Open_Interest_Change' } = body ?? {};
  const rawCookie = rawCookieHdr2 || rawCookieBody2 || `authToken=${sessionToken2}; sessionToken=${sessionToken2}; deviceId=${deviceId2}`;

  if (!Array.isArray(query)) {
    return reply.status(400).send({ error: 'query[] is required' });
  }

  const targetUrl = `https://api.nubra.io/charts/multistrike?chart=${encodeURIComponent(chart)}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken2}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': rawCookie,
        'x-device-id': deviceId2,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ query }),
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();

    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra Open Interest proxy
// POST /api/nubra-open-interest → https://api.nubra.io/charts/multistrike?chart=Open_Interest
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nubra-open-interest', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = (headers['x-session-token'] as string) ?? '';
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (headers['x-raw-cookie'] as string) ?? '';

  const body = req.body as { query: unknown[] };
  if (!Array.isArray(body?.query)) {
    return reply.status(400).send({ error: 'query[] is required' });
  }

  const rawCookie = rawCookieHdr || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  try {
    const upstream = await fetch('https://api.nubra.io/charts/multistrike?chart=Open_Interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': rawCookie,
        'x-device-id': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ query: body.query }),
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// OI Change endpoint
// POST /api/nubra-oi-change
// Body: { queryTemplate: <base query item without time>, fromTime: ISO, toTime: ISO }
// Returns: same shape as nubra-open-interest but values are (toTime − fromTime) per strike
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nubra-oi-change', async (req, reply) => {
  const hdrs = req.headers;
  const sessionToken = (hdrs['x-session-token'] as string) ?? '';
  const deviceId     = (hdrs['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (hdrs['x-raw-cookie'] as string) ?? '';
  const rawCookie = rawCookieHdr || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  const body = req.body as { queryTemplate: Record<string, unknown>; fromTime: string; toTime: string };
  const { queryTemplate, fromTime, toTime } = body ?? {};

  if (!queryTemplate || !fromTime || !toTime) {
    return reply.status(400).send({ error: 'queryTemplate, fromTime, toTime are required' });
  }

  const nubraHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Authorization': `Bearer ${sessionToken}`,
    'Origin': 'https://nubra.io',
    'Referer': 'https://nubra.io/',
    'Cookie': rawCookie,
    'x-device-id': deviceId,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };

  const fetchOiAt = async (time: string) => {
    const res = await fetch('https://api.nubra.io/charts/multistrike?chart=Open_Interest_Change', {
      method: 'POST',
      headers: nubraHeaders,
      body: JSON.stringify({ query: [{ ...queryTemplate, time }] }),
      dispatcher: nubraAgent,
    } as any);
    if (!res.ok) throw new Error(`upstream ${res.status} for time=${time}`);
    return res.json() as Promise<any>;
  };

  try {
    // Fetch both timestamps in parallel
    const [fromJson, toJson] = await Promise.all([fetchOiAt(fromTime), fetchOiAt(toTime)]);

    // Both responses have shape: result[exchange][asset][time][expiry][strikeInPaise].cumulative_oi.{CE,PE}
    const exchange = (queryTemplate.exchange as string) ?? '';
    const asset    = (queryTemplate.asset as string) ?? '';

    const fromAsset = fromJson?.result?.[exchange]?.[asset] ?? {};
    const toAsset   = toJson?.result?.[exchange]?.[asset] ?? {};

    // Extract expiry→strike maps from each snapshot
    const getExpiryMap = (assetData: Record<string, any>): Record<string, Record<string, any>> => {
      // There's one time key, get the inner expiry→strike map
      const timeKey = Object.keys(assetData)[0];
      return timeKey ? (assetData[timeKey] as Record<string, any>) : {};
    };

    const fromExpiries = getExpiryMap(fromAsset);
    const toExpiries   = getExpiryMap(toAsset);

    // Merge all expiry keys
    const allExpiries = new Set([...Object.keys(fromExpiries), ...Object.keys(toExpiries)]);

    const resultExpiries: Record<string, Record<string, any>> = {};

    for (const expiry of allExpiries) {
      const fromStrikes = fromExpiries[expiry] ?? {};
      const toStrikes   = toExpiries[expiry] ?? {};
      const allStrikes  = new Set([...Object.keys(fromStrikes), ...Object.keys(toStrikes)]);

      const strikeResult: Record<string, any> = {};
      for (const sp of allStrikes) {
        const fromCe = fromStrikes[sp]?.cumulative_oi?.CE ?? 0;
        const fromPe = fromStrikes[sp]?.cumulative_oi?.PE ?? 0;
        const toCe   = toStrikes[sp]?.cumulative_oi?.CE ?? 0;
        const toPe   = toStrikes[sp]?.cumulative_oi?.PE ?? 0;
        strikeResult[sp] = {
          cumulative_oi: {
            CE: toCe - fromCe,
            PE: toPe - fromPe,
          },
        };
      }
      resultExpiries[expiry] = strikeResult;
    }

    return reply.send({
      result: {
        [exchange]: {
          [asset]: {
            [toTime]: resultExpiries,
          },
        },
      },
    });
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nubra-iv → https://api.nubra.io/charts/multistrike?chart=Implied_Volatility
// Body: { query: [{ exchange, asset, expiries, strikes, minStrike, maxStrike, fields, time }] }
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nubra-iv', async (req, reply) => {
  const hdrs         = req.headers;
  const sessionToken = (hdrs['x-session-token'] as string) ?? '';
  const deviceId     = (hdrs['x-device-id']     as string) ?? 'web';
  const rawCookieHdr = (hdrs['x-raw-cookie']    as string) ?? '';

  const body = req.body as { query: unknown[] };
  if (!Array.isArray(body?.query)) {
    return reply.status(400).send({ error: 'query[] is required' });
  }

  const rawCookie = rawCookieHdr || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  try {
    const upstream = await fetch('https://api.nubra.io/charts/multistrike?chart=Implied_Volatility', {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json, text/plain, */*',
        'Authorization':  `Bearer ${sessionToken}`,
        'Origin':         'https://nubra.io',
        'Referer':        'https://nubra.io/',
        'Cookie':         rawCookie,
        'x-device-id':   deviceId,
        'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify({ query: body.query }),
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nubra-refdata → https://api.nubra.io/refdata/:asset?derivativeType=OPT&exchange=NSE|BSE[&expiry=YYYYMMDD]
// Without expiry: returns { exchange, expiries: [...], message: "expiries" }
// With expiry:    returns { exchange, refdata: [...], message: "refdata" }
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/nubra-refdata', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = (headers['x-session-token'] as string) ?? '';
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (headers['x-raw-cookie'] as string) ?? '';

  const { asset, exchange, expiry } = req.query as Record<string, string>;
  if (!asset) {
    return reply.status(400).send({ error: 'asset is required' });
  }

  const exch = (exchange ?? 'NSE').toUpperCase();
  const rawCookie = rawCookieHdr || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;

  let url = `https://api.nubra.io/refdata/${encodeURIComponent(asset)}?derivativeType=OPT&exchange=${exch}`;
  if (expiry) url += `&expiry=${encodeURIComponent(expiry)}`;

  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': rawCookie,
        'x-device-id': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      dispatcher: nubraAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Upstox Full Market Quote proxy
// Forwards GET to https://api.upstox.com/v2/market-quote/quotes with the
// caller's Bearer token, bypassing browser CORS.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/market-quote', async (req, reply) => {
  const { instrument_key, token } = req.query as Record<string, string>;
  if (!instrument_key || !token) {
    return reply.status(400).send({ error: 'instrument_key and token are required' });
  }

  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument_key)}`;
  try {
    const upstream = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      dispatcher: upstoxAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Nubra Instruments proxy
// GET /api/nubra-instruments?exchange=NSE
// Fetches instrument refdata from Nubra API using the caller's session token.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/nubra-instruments', async (req, reply) => {
  const { session_token, auth_token, device_id } = req.query as Record<string, string>;
  if (!session_token) {
    return reply.status(400).send({ error: 'session_token is required' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const deviceId = device_id || getDeviceId();
  const cookieStr = auth_token
    ? `authToken=${auth_token}; sessionToken=${session_token}`
    : `sessionToken=${session_token}`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${session_token}`,
    'x-device-id': deviceId,
  };

  // Fetch NSE, BSE, and public Index Master all in parallel
  try {
    const [nseRes, bseRes, idxRes] = await Promise.all([
      fetch(`${NUBRA_API}/refdata/refdata/${today}?exchange=NSE`, { headers, dispatcher: nubraAuthAgent } as any),
      fetch(`${NUBRA_API}/refdata/refdata/${today}?exchange=BSE`, { headers, dispatcher: nubraAuthAgent } as any),
      fetch('https://api.nubra.io/public/indexes?format=csv'),
    ]);

    const nseData = await nseRes.text();
    const bseData = await bseRes.text();
    const idxCsv = await idxRes.text();
    console.log(`[nubra instruments] NSE=${nseRes.status} body(${nseData.length}) BSE=${bseRes.status} body(${bseData.length}) IDX=${idxRes.status} body(${idxCsv.length})`);

    // Parse refdata
    let nseRefdata: any[] = [];
    let bseRefdata: any[] = [];
    try { const j = JSON.parse(nseData); nseRefdata = j.refdata ?? j.data?.refdata ?? []; } catch {}
    try { const j = JSON.parse(bseData); bseRefdata = j.refdata ?? j.data?.refdata ?? []; } catch {}

    // Parse index CSV → JSON array
    let indexes: any[] = [];
    if (idxRes.ok && idxCsv.trim()) {
      const lines = idxCsv.trim().split('\n');
      if (lines.length >= 2) {
        const csvHeaders = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        indexes = lines.slice(1).map(line => {
          const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
          const obj: Record<string, string> = {};
          csvHeaders.forEach((h, i) => { obj[h] = values[i] ?? ''; });
          return obj;
        });
        console.log(`[nubra indexes] parsed: ${indexes.length} indexes, headers: ${csvHeaders.join(', ')}`);
      }
    }

    const merged = [...nseRefdata, ...bseRefdata];
    console.log(`[nubra instruments] merged: NSE=${nseRefdata.length} + BSE=${bseRefdata.length} = ${merged.length}`);
    if (merged.length > 0) console.log(`[nubra instruments] sample keys:`, Object.keys(merged[0]).join(', '));

    if (merged.length === 0) {
      const status = nseRes.ok ? 502 : nseRes.status;
      let errPayload: any;
      try { errPayload = JSON.parse(nseData); } catch { errPayload = { error: nseData || `Nubra API error ${nseRes.status}` }; }
      return reply.status(status).send(errPayload);
    }

    return reply.send({ refdata: merged, indexes });
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nubra-expiries?session_token=&symbol=NIFTY&exchange=NSE
// Fetches today's refdata and returns unique expiries for the given symbol
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/nubra-expiries', async (req, reply) => {
  const { session_token, symbol, exchange = 'NSE' } = req.query as Record<string, string>;
  if (!session_token || !symbol) return reply.status(400).send({ error: 'session_token and symbol required' });
  const deviceId = getDeviceId();
  const today = new Date().toISOString().slice(0, 10);
  const url = `${NUBRA_API}/refdata/refdata/${today}?exchange=${exchange}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${session_token}`, 'x-device-id': deviceId, 'Accept': 'application/json' },
      dispatcher: nubraAuthAgent,
    } as any);
    if (!res.ok) return reply.status(res.status).send({ error: await res.text() });
    const json = await res.json() as any;
    const sym = symbol.toUpperCase();
    const expSet = new Set<number>();
    for (const item of (json.refdata ?? [])) {
      if ((item.asset ?? '').toUpperCase() === sym && (item.option_type === 'CE' || item.option_type === 'PE')) {
        expSet.add(item.expiry);
      }
    }
    reply.send({ expiries: [...expSet].sort() });
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nubra-search?session_token=&query=NIF&assetTypes=&exactMatch=false
// Proxies Nubra advancedsearch for instrument search
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/nubra-search', async (req, reply) => {
  const { session_token, query, assetTypes = '', exactMatch = 'false' } = req.query as Record<string, string>;
  if (!session_token || !query) {
    return reply.status(400).send({ error: 'session_token and query are required' });
  }
  const deviceId = getDeviceId();
  const url = `${NUBRA_API}/refdata/advancedsearch?query=${encodeURIComponent(query)}&assetTypes=${assetTypes}&exactMatch=${exactMatch}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${session_token}`,
        'x-device-id': deviceId,
        'Accept': 'application/json',
      },
      dispatcher: nubraAuthAgent,
    } as any);
    const body = await res.text();
    if (!res.ok) return reply.status(res.status).send({ error: body });
    reply.header('Content-Type', 'application/json').send(body);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nubra-optionchain?session_token=&instrument=NIFTY&exchange=NSE&expiry=20260327
// Proxies Nubra REST option chain for after-hours use
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/nubra-optionchain', async (req, reply) => {
  const { session_token, instrument, exchange, expiry } = req.query as Record<string, string>;
  if (!session_token || !instrument || !expiry) {
    return reply.status(400).send({ error: 'session_token, instrument and expiry are required' });
  }
  const exch = exchange || 'NSE';
  const deviceId = getDeviceId();
  const url = `${NUBRA_API}/optionchains/${encodeURIComponent(instrument)}?exchange=${exch}&expiry=${expiry}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${session_token}`,
        'x-device-id': deviceId,
        'Accept': 'application/json',
      },
      dispatcher: nubraAuthAgent,
    } as any);
    const body = await res.text();
    if (!res.ok) {
      return reply.status(res.status).send({ error: body });
    }
    reply.header('Content-Type', 'application/json').send(body);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nubra-price?session_token=&symbol=NIFTY&exchange=NSE
// Returns { price, prev_close, change, exchange } for index spot %Chg
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/nubra-price', async (req, reply) => {
  const { session_token, symbol, exchange } = req.query as Record<string, string>;
  if (!session_token || !symbol) {
    return reply.status(400).send({ error: 'session_token and symbol are required' });
  }
  const exch = exchange || 'NSE';
  const deviceId = getDeviceId();
  const url = `${NUBRA_API}/optionchains/${encodeURIComponent(symbol)}/price?exchange=${exch}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${session_token}`,
        'x-device-id': deviceId,
        'Accept': 'application/json',
      },
      dispatcher: nubraAuthAgent,
    } as any);
    const body = await res.text();
    if (!res.ok) return reply.status(res.status).send({ error: body });
    reply.header('Content-Type', 'application/json').send(body);
  } catch (err) {
    reply.status(500).send({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nubra-historical
// Proxies historical OHLCV + Greeks data from Nubra charts/timeseries API
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/nubra-historical', async (req, reply) => {
  const body = req.body as any;

  // Accept session token from body OR x-session-token header (same as nubra-timeseries)
  const reqHeaders = req.headers;
  const sessionToken = body.session_token || (reqHeaders['x-session-token'] as string) || '';
  const deviceId     = body.device_id     || (reqHeaders['x-device-id']     as string) || getDeviceId();
  const rawCookieHdr = (reqHeaders['x-raw-cookie'] as string) || '';
  const rawCookieBody = body.raw_cookie || '';

  if (!sessionToken) {
    return reply.status(400).send({ error: 'session_token is required' });
  }

  const { exchange, type, values, fields, startDate, endDate, interval, intraDay, realTime } = body;

  if (!exchange || !type || !values?.length || !fields?.length) {
    return reply.status(400).send({ error: 'exchange, type, values, fields are required' });
  }

  // Build cookie — prefer raw cookie with deviceId baked in
  const rawCookie = rawCookieHdr || rawCookieBody || '';
  const cookiePrimary = buildNubraCookie(rawCookie, sessionToken, body.auth_token || '', deviceId);

  // Nubra expects RFC3339 — pass dates as-is (already ISO from client)
  const queryItem = {
    exchange,
    type,
    values,
    fields,
    startDate,
    endDate,
    interval: interval ?? '1m',
    intraDay: intraDay ?? false,
    realTime: realTime ?? false,
  };

  const reqBody = JSON.stringify({ query: [queryItem] });
  console.log(`[nubra-historical] →`, reqBody.slice(0, 300));

  try {
    const callUpstream = async (url: string, cookie: string) => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Cookie': cookie,
        'x-device-id': deviceId,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: reqBody,
      dispatcher: nubraAgent,
    } as any);

    const upstream = await callUpstream(`${NUBRA_API}/charts/timeseries?chart=charts`, cookiePrimary);
    const data = await upstream.text();
    console.log(`[nubra-historical] ← ${upstream.status} (${data.length}b) ${data.slice(0, 200)}`);
    reply.status(upstream.status);
    reply.header('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    return reply.send(data);
  } catch (e: any) {
    console.error('[nubra-historical] error', e);
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── MTM Strategies (Supabase) ────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const supabaseEnabled = () => SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;
const supabaseHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
});

// POST /api/mtm-strategy/save
app.post('/api/mtm-strategy/save', async (req, reply) => {
  if (!supabaseEnabled()) return reply.status(500).send({ error: 'Supabase not configured' });
  const { name, oc_symbol, oc_exchange, oc_asset_type, legs } = req.body as any;
  if (!name || !Array.isArray(legs)) {
    return reply.status(400).send({ error: 'name, legs are required' });
  }
  const payload = [{ name, oc_symbol, oc_exchange, oc_asset_type, legs }];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mtm_strategies`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    } as any);
    const text = await res.text();
    reply.status(res.status);
    reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
    return reply.send(text);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// GET /api/mtm-strategy/list?client_id=
app.get('/api/mtm-strategy/list', async (_req, reply) => {
  if (!supabaseEnabled()) return reply.status(500).send({ error: 'Supabase not configured' });
  const url = `${SUPABASE_URL}/rest/v1/mtm_strategies?order=created_at.desc`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() } as any);
    const text = await res.text();
    reply.status(res.status);
    reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
    return reply.send(text);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// DELETE /api/mtm-strategy/delete?id=
app.delete('/api/mtm-strategy/delete', async (req, reply) => {
  if (!supabaseEnabled()) return reply.status(500).send({ error: 'Supabase not configured' });
  const { id } = req.query as Record<string, string>;
  if (!id) return reply.status(400).send({ error: 'id required' });
  const url = `${SUPABASE_URL}/rest/v1/mtm_strategies?id=eq.${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers: supabaseHeaders() } as any);
    const text = await res.text();
    reply.status(res.status);
    reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
    return reply.send(text);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// Dhan Scrip Master proxy
// GET /api/dhan-instruments
// Streams api-scrip-master-detailed.csv from Dhan CDN, bypassing CORS.
// Cached in memory for the day (date-stamped).
// ─────────────────────────────────────────────────────────────────────────────

let dhanCsvCache: { data: Buffer; date: string } | null = null;

app.get('/api/dhan-instruments', async (_req, reply) => {
  const today = new Date().toISOString().slice(0, 10);
  if (dhanCsvCache && dhanCsvCache.date === today) {
    reply.header('Content-Type', 'text/csv');
    reply.header('X-Cache', 'HIT');
    return reply.send(dhanCsvCache.data);
  }
  try {
    const res = await fetch(
      'https://images.dhan.co/api-data/api-scrip-master-detailed.csv',
      { dispatcher: dhanAgent } as any,
    );
    if (!res.ok) return reply.status(res.status).send({ error: `upstream ${res.status}` });
    const buf = Buffer.from(await res.arrayBuffer());
    dhanCsvCache = { data: buf, date: today };
    reply.header('Content-Type', 'text/csv');
    return reply.send(buf);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dhan Options Chart proxy
// POST /api/dhan-opt-chart
// Forwards to https://op-charts.dhan.co/api/opt_chart with the caller's JWT.
// ─────────────────────────────────────────────────────────────────────────────

const dhanAgent = new Agent({
  connect: { keepAlive: true },
  connections: 5,
  pipelining: 1,
});

app.post('/api/dhan-opt-chart', async (req, reply) => {
  const body = req.body as {
    auth: string;
    payload: Record<string, unknown>;
  };

  const { auth, payload } = body ?? {};

  if (!auth || !payload) {
    return reply.status(400).send({ error: 'auth (JWT) and payload are required' });
  }

  try {
    const upstream = await fetch('https://op-charts.dhan.co/api/opt_chart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'auth': auth,
        'authorisation': 'Token',
        'Origin': 'https://options-trader.dhan.co',
        'Referer': 'https://options-trader.dhan.co/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
      body: JSON.stringify(payload),
      dispatcher: dhanAgent,
    } as any);

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const data = await upstream.text();
    console.log(`[dhan opt-chart] ${upstream.status} body(${data.length})`);
    reply.status(upstream.status);
    reply.header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    console.error('[dhan opt-chart error]', e);
    return reply.status(502).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Upstox headless auto-login
// POST /api/upstox-login  → runs Playwright, returns { access_token }
// GET  /upstox/callback   → catches the OAuth redirect code (used internally)
// ─────────────────────────────────────────────────────────────────────────────


// Token cache path  (server/upstox_token.json)
const TOKEN_CACHE = join(__dirname, 'upstox_token.json');

function loadCachedToken(): { access_token: string; expires_at: number } | null {
  try {
    if (!existsSync(TOKEN_CACHE)) return null;
    const data = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8'));
    if (data.expires_at > Date.now()) return data;
  } catch { /* ignore */ }
  return null;
}

function saveToken(access_token: string) {
  // Upstox tokens expire at end of trading day (~23:59 IST). Cache for 23 h.
  const expires_at = Date.now() + 23 * 60 * 60 * 1000;
  writeFileSync(TOKEN_CACHE, JSON.stringify({ access_token, expires_at }));
}

app.post('/api/upstox-login', async (req, reply) => {
  // Prefer credentials from request body (sent from browser IDB), fall back to env
  const body = (req.body ?? {}) as Record<string, string>;
  const force = body.force === 'true' || body.force === true as any;

  // Return cached token if still valid and not forced
  if (!force) {
    const cached = loadCachedToken();
    if (cached) {
      console.log('[upstox-login] returning cached token');
      return reply.send({ access_token: cached.access_token, cached: true });
    }
  } else {
    console.log('[upstox-login] force=true — skipping cache, re-logging in');
  }
  const API_KEY      = body.api_key      || process.env.UPSTOX_API_KEY      || '';
  const API_SECRET   = body.api_secret   || process.env.UPSTOX_API_SECRET   || '';
  const REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI ?? 'http://127.0.0.1:3001/upstox/callback';
  const PHONE        = body.phone        || process.env.UPSTOX_PHONE        || '';
  const PIN          = body.pin          || process.env.UPSTOX_PIN          || '';
  const TOTP_SECRET  = body.totp_secret  || process.env.UPSTOX_TOTP_SECRET  || '';

  if (!API_KEY || !API_SECRET || !PHONE || !PIN || !TOTP_SECRET) {
    return reply.status(400).send({ error: 'Upstox credentials required: api_key, api_secret, phone, pin, totp_secret' });
  }

  // Lazy-load Playwright (ESM dynamic import)
  let chromium: any;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return reply.status(500).send({ error: 'playwright not installed. Run: npm install playwright' });
  }

  const authUrl =
    `https://api.upstox.com/v2/login/authorization/dialog` +
    `?response_type=code&client_id=${encodeURIComponent(API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  let browser: any;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    console.log('[upstox-login] opening auth URL');
    await page.goto(authUrl, { waitUntil: 'load' });

    // ── Step 1: Mobile number → Get OTP ──────────────────────────────────────
    await page.waitForSelector('#mobileNum', { timeout: 20000 });
    await page.fill('#mobileNum', PHONE);
    await page.click('#getOtp');
    console.log('[upstox-login] submitted mobile, waiting for OTP screen…');

    // ── Step 2: TOTP ──────────────────────────────────────────────────────────
    await page.waitForSelector('#otpNum', { timeout: 20000 });
    const otp = generateTotp(TOTP_SECRET);
    console.log('[upstox-login] generated TOTP:', otp);
    await page.fill('#otpNum', otp);
    await page.click('#continueBtn');
    console.log('[upstox-login] submitted TOTP, waiting for PIN screen…');

    // ── Step 3: PIN ───────────────────────────────────────────────────────────
    await page.waitForSelector('#pinCode', { timeout: 20000 });
    await page.fill('#pinCode', PIN);
    await page.click('#pinContinueBtn');
    console.log('[upstox-login] submitted PIN, waiting for redirect…');

    // ── Step 4: Intercept the OAuth redirect before it tries to load
    // Use route() to abort the request immediately after capturing the code URL
    const authCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redirect timeout (30s)')), 30000);
      page.route('**', (route: any) => {
        const url = route.request().url();
        const parsed = new URL(url);
        if (parsed.searchParams.has('code')) {
          clearTimeout(timer);
          route.abort().catch(() => {});
          resolve(parsed.searchParams.get('code')!);
        } else {
          route.continue().catch(() => {});
        }
      });
    });
    console.log('[upstox-login] got auth code:', authCode.slice(0, 8) + '…');
    await browser.close();

    // ── Step 5: Exchange code for access_token ──
    const tokenRes = await fetch('https://api.upstox.com/v2/login/authorization/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        code:          authCode,
        client_id:     API_KEY,
        client_secret: API_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }).toString(),
    });

    const tokenData = await tokenRes.json() as any;
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[upstox-login] token exchange failed', tokenData);
      return reply.status(502).send({ error: tokenData?.message ?? 'Token exchange failed', detail: tokenData });
    }

    saveToken(tokenData.access_token);
    console.log('[upstox-login] SUCCESS — token saved');
    return reply.send({ access_token: tokenData.access_token, cached: false });

  } catch (e: any) {
    browser?.close?.();
    console.error('[upstox-login error]', e);
    return reply.status(500).send({ error: e.message });
  }
});

// GET /api/upstox-login-debug — runs Playwright in VISIBLE mode so you can watch the login flow
app.get('/api/upstox-login-debug', async (_req, reply) => {
  const API_KEY      = process.env.UPSTOX_API_KEY      ?? '';
  const API_SECRET   = process.env.UPSTOX_API_SECRET    ?? '';
  const REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI  ?? 'http://127.0.0.1:3001/upstox/callback';
  const PHONE        = process.env.UPSTOX_PHONE         ?? '';
  const PIN          = process.env.UPSTOX_PIN           ?? '';
  const TOTP_SECRET  = process.env.UPSTOX_TOTP_SECRET   ?? '';

  if (!API_KEY || !PHONE || !PIN || !TOTP_SECRET) {
    return reply.status(400).send({ error: 'Missing UPSTOX_* env vars' });
  }

  let chromium: any;
  try { ({ chromium } = await import('playwright')); }
  catch { return reply.status(500).send({ error: 'playwright not installed' }); }

  const authUrl =
    `https://api.upstox.com/v2/login/authorization/dialog` +
    `?response_type=code&client_id=${encodeURIComponent(API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  let browser: any;
  try {
    // headless: false — opens a visible Chrome window so you can watch
    browser = await chromium.launch({ headless: false, slowMo: 500 });
    const page = await browser.newPage();
    await page.goto(authUrl, { waitUntil: 'load' });

    await page.waitForSelector('#mobileNum', { timeout: 20000 });
    await page.fill('#mobileNum', PHONE);
    await page.click('#getOtp');
    console.log('[debug-login] phone submitted');

    await page.waitForSelector('#otpNum', { timeout: 20000 });
    console.log('[debug-login] TOTP screen visible — waiting 15s for phone notification…');
    await new Promise(r => setTimeout(r, 15000));
    const otp = generateTotp(TOTP_SECRET);
    console.log('[debug-login] TOTP:', otp);
    await page.fill('#otpNum', otp);
    await page.click('#continueBtn');

    await page.waitForSelector('#pinCode', { timeout: 20000 });
    await page.fill('#pinCode', PIN);
    await page.click('#pinContinueBtn');

    const authCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redirect timeout (30s)')), 30000);
      page.route('**', (route: any) => {
        const url = route.request().url();
        const parsed = new URL(url);
        if (parsed.searchParams.has('code')) {
          clearTimeout(timer);
          route.abort().catch(() => {});
          resolve(parsed.searchParams.get('code')!);
        } else { route.continue().catch(() => {}); }
      });
    });

    // Keep browser open 3s so you can see the final state
    await new Promise(r => setTimeout(r, 3000));
    await browser.close();

    console.log('[debug-login] auth code captured:', authCode.slice(0, 8) + '…');
    return reply.send({ ok: true, auth_code_prefix: authCode.slice(0, 8) });
  } catch (e: any) {
    browser?.close?.();
    console.error('[debug-login error]', e);
    return reply.status(500).send({ error: e.message });
  }
});

// GET /api/upstox-token — returns cached token or 401
app.get('/api/upstox-token', async (_req, reply) => {
  const cached = loadCachedToken();
  if (cached) return reply.send({ access_token: cached.access_token });
  return reply.status(401).send({ error: 'No valid token. Call POST /api/upstox-login first.' });
});

// DELETE /api/upstox-token — clears cached token (force re-login)
app.delete('/api/upstox-token', async (_req, reply) => {
  try { if (existsSync(TOKEN_CACHE)) writeFileSync(TOKEN_CACHE, '{}'); } catch { /* ignore */ }
  return reply.send({ ok: true });
});

// GET /api/upstox-login-stream — SSE that fires POST login then streams token when ready
// Frontend connects, server runs Playwright, sends token as SSE event — no proxy timeout issues
app.get('/api/upstox-login-stream', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event: string, data: string) => {
    reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const API_KEY     = process.env.UPSTOX_API_KEY     ?? '';
  const API_SECRET  = process.env.UPSTOX_API_SECRET   ?? '';
  const REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI ?? 'http://127.0.0.1:5000/upstox/callback';
  const PHONE       = process.env.UPSTOX_PHONE        ?? '';
  const PIN         = process.env.UPSTOX_PIN          ?? '';
  const TOTP_SECRET = process.env.UPSTOX_TOTP_SECRET  ?? '';

  if (!API_KEY || !API_SECRET || !PHONE || !PIN || !TOTP_SECRET) {
    send('error', JSON.stringify({ error: 'Fill in UPSTOX_* fields in urjaa/.env first.' }));
    reply.raw.end(); return;
  }

  let chromium: any;
  try { ({ chromium } = await import('playwright')); }
  catch { send('error', JSON.stringify({ error: 'playwright not installed' })); reply.raw.end(); return; }

  const authUrl =
    `https://api.upstox.com/v2/login/authorization/dialog` +
    `?response_type=code&client_id=${encodeURIComponent(API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  let browser: any;
  try {
    send('status', JSON.stringify({ msg: 'Launching browser…' }));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(authUrl, { waitUntil: 'load' });

    await page.waitForSelector('#mobileNum', { timeout: 20000 });
    await page.fill('#mobileNum', PHONE);
    await page.click('#getOtp');
    send('status', JSON.stringify({ msg: 'Submitted phone, waiting for TOTP…' }));

    await page.waitForSelector('#otpNum', { timeout: 20000 });
    const otp = generateTotp(TOTP_SECRET);
    await page.fill('#otpNum', otp);
    await page.click('#continueBtn');
    send('status', JSON.stringify({ msg: 'Submitted TOTP, waiting for PIN…' }));

    await page.waitForSelector('#pinCode', { timeout: 20000 });
    await page.fill('#pinCode', PIN);
    await page.click('#pinContinueBtn');
    send('status', JSON.stringify({ msg: 'Submitted PIN, waiting for redirect…' }));

    const authCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redirect timeout (30s)')), 30000);
      page.route('**', (route: any) => {
        const url = route.request().url();
        const parsed = new URL(url);
        if (parsed.searchParams.has('code')) {
          clearTimeout(timer);
          route.abort().catch(() => {});
          resolve(parsed.searchParams.get('code')!);
        } else { route.continue().catch(() => {}); }
      });
    });
    await browser.close();

    const tokenRes = await fetch('https://api.upstox.com/v2/login/authorization/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        code: authCode, client_id: API_KEY, client_secret: API_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
      }).toString(),
    });
    const tokenData = await tokenRes.json() as any;
    if (!tokenRes.ok || !tokenData.access_token) {
      send('error', JSON.stringify({ error: tokenData?.message ?? 'Token exchange failed' }));
      reply.raw.end(); return;
    }
    saveToken(tokenData.access_token);
    send('token', JSON.stringify({ access_token: tokenData.access_token }));
    reply.raw.end();
  } catch (e: any) {
    browser?.close?.();
    send('error', JSON.stringify({ error: e.message }));
    reply.raw.end();
  }
});

// ── Dhan / Nubra API routes (migrated from Next.js) ──────────────────────────

const DHAN_CLIENT_ID  = process.env.DHAN_CLIENT_ID  ?? '';
const DHAN_PIN        = process.env.DHAN_PIN         ?? '';
const DHAN_TOTP_SECRET = process.env.DHAN_TOTP_SECRET ?? '';
const DHAN_APP_ID     = process.env.DHAN_APP_ID      ?? '';
const DHAN_APP_SECRET = process.env.DHAN_APP_SECRET  ?? '';

// POST /api/dhan-autologin
app.post('/api/dhan-autologin', async (_req, reply) => {
  try {
    const totp = generateTotp(DHAN_TOTP_SECRET);
    const res = await fetch(
      `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${DHAN_CLIENT_ID}&pin=${DHAN_PIN}&totp=${totp}`,
      { method: 'POST' }
    );
    const data = await res.json() as any;
    if (data.status === 'error')
      return reply.status(400).send({ error: data.message ?? JSON.stringify(data) });
    return reply.send(data);
  } catch (e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// POST /api/dhan-consent
app.post('/api/dhan-consent', async (_req, reply) => {
  try {
    const res = await fetch(
      `https://auth.dhan.co/app/generate-consent?client_id=${DHAN_CLIENT_ID}`,
      { method: 'POST', headers: { app_id: DHAN_APP_ID, app_secret: DHAN_APP_SECRET } }
    );
    const data = await res.json() as any;
    if (!res.ok) return reply.status(res.status).send(data);
    const loginUrl = `https://auth.dhan.co/login/consentApp-login?consentAppId=${data.consentAppId}`;
    return reply.send({ consentAppId: data.consentAppId, loginUrl });
  } catch (e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// POST /api/dhan-token
app.post('/api/dhan-token', async (req, reply) => {
  try {
    const { tokenId } = req.body as any;
    if (!tokenId) return reply.status(400).send({ error: 'tokenId required' });
    const res = await fetch(
      `https://auth.dhan.co/app/consumeApp-consent?tokenId=${tokenId}`,
      { method: 'GET', headers: { app_id: DHAN_APP_ID, app_secret: DHAN_APP_SECRET } }
    );
    const data = await res.json() as any;
    if (!res.ok) return reply.status(res.status).send(data);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// POST /api/nubra-evaluate
app.post('/api/nubra-evaluate', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = headers['x-session-token'] as string;
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookie    = (headers['x-raw-cookie'] as string) ?? '';
  if (!sessionToken) return reply.status(401).send({ error: 'Missing session token' });
  const cookieHeader = rawCookie || `authToken=${sessionToken}; sessionToken=${sessionToken}; deviceId=${deviceId}`;
  try {
    const res = await fetch('https://api.nubra.io/strategies/strat1/evaluate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Cookie': cookieHeader,
        'x-device-id': deviceId,
        'order-env': '',
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(req.body),
      dispatcher: nubraAgent,
    } as any);
    console.log('[nubra-evaluate] request body:', JSON.stringify(req.body).slice(0, 500));
    const text = await res.text();
    console.log('[nubra-evaluate] status:', res.status, 'body:', text.slice(0, 500));
    try {
      const data = JSON.parse(text);
      return reply.status(res.status).send(data);
    } catch {
      return reply.status(res.status).header('Content-Type', 'text/plain').send(text);
    }
  } catch (e: any) {
    console.error('[nubra-evaluate] fetch error:', e.message);
    return reply.status(502).send({ error: e.message });
  }
});

// POST /api/nubra-margin
app.post('/api/nubra-margin', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = headers['x-session-token'] as string;
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  if (!sessionToken) return reply.status(401).send({ error: 'Missing session token' });
  try {
    const res = await fetch('https://api.nubra.io/orders/v2/margin_required', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'x-device-id': deviceId,
        'origin': 'https://nubra.io',
        'referer': 'https://nubra.io/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(req.body),
      dispatcher: nubraAgent,
    } as any);
    const contentType = res.headers.get('content-type') ?? 'application/json';
    const data = await res.text();
    reply.status(res.status).header('Content-Type', contentType);
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

// GET /api/nubra-orderbook
app.get('/api/nubra-orderbook', async (req, reply) => {
  const { ref_id, levels = '1' } = req.query as any;
  const headers = req.headers;
  const sessionToken = headers['x-session-token'] as string;
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  if (!sessionToken) return reply.status(401).send({ error: 'Missing session token' });
  if (!ref_id)       return reply.status(400).send({ error: 'Missing ref_id' });
  const res = await fetch(`https://api.nubra.io/orderbooks/${ref_id}?levels=${levels}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'x-device-id': deviceId },
  });
  const data = await res.json() as any;
  return reply.status(res.status).send(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fii-dii — NSE FII/DII cash market activity (last 30 trading days)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/nubra-market-schedule → https://api.nubra.io/calendar/market_schedule
app.get('/api/nubra-market-schedule', async (req, reply) => {
  const headers = req.headers;
  const sessionToken = (headers['x-session-token'] as string) ?? '';
  const deviceId     = (headers['x-device-id'] as string) ?? 'web';
  const rawCookieHdr = (headers['x-raw-cookie'] as string) ?? '';
  const rawCookie = buildNubraCookie(rawCookieHdr, sessionToken, '', deviceId);

  try {
    const upstream = await fetch(`${NUBRA_API}/calendar/market_schedule`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${sessionToken}`,
        'Origin': 'https://nubra.io',
        'Referer': 'https://nubra.io/',
        'Cookie': rawCookie,
        'x-device-id': deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      dispatcher: nubraAgent,
    } as any);
    const data = await upstream.json();
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

app.get('/api/fii-dii', async (_req, reply) => {
  try {
    const res = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Referer': 'https://www.nseindia.com/market-data/fii-dii-trading-activity',
        'Origin': 'https://www.nseindia.com',
      },
    });
    if (!res.ok) return reply.status(res.status).send({ error: `NSE returned ${res.status}` });
    const data = await res.json();
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send(data);
  } catch (e: any) {
    return reply.status(502).send({ error: e.message });
  }
});

app.listen({ port: 3001 }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('Urjaa proxy server running on http://localhost:3001');
});
