import { useState, useEffect, useCallback } from 'react';
import { useInstruments } from './useInstruments';
import { loadUserCreds, saveUserCreds, saveAuthToken, loadAuthToken, type UserCreds } from './db';
import type { GoogleUser } from './LandingPage';

interface Props {
  googleUser: GoogleUser | null;
  onReady: () => void;
}

type Phase =
  | 'checking'       // reading IDB
  | 'needs-setup'    // first time — ask credentials
  | 'otp-sent'       // Nubra OTP sent
  | 'logging-in'     // auto-login running
  | 'loading-instr'  // instruments loading
  | 'error';

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export default function SetupScreen({ googleUser, onReady }: Props) {
  const { status: instrStatus } = useInstruments();
  const sub = googleUser?.sub ?? 'default';

  const [phase,     setPhase]     = useState<Phase>('checking');
  const [msg,       setMsg]       = useState('');
  const [err,       setErr]       = useState('');
  const [loading,   setLoading]   = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [otp,       setOtp]       = useState('');
  const [regenMode, setRegenMode] = useState(false); // true = re-generate flow (OTP + fresh Upstox)

  // Upstox fields — initialize directly from localStorage so form is pre-filled immediately
  const [upPhone,  setUpPhone]  = useState(() => localStorage.getItem('upstox_phone')      ?? '');
  const [upPin,    setUpPin]    = useState(() => localStorage.getItem('upstox_pin')        ?? '');
  const [upTotp,   setUpTotp]   = useState(() => localStorage.getItem('upstox_totp')       ?? '');
  const [upKey,    setUpKey]    = useState(() => localStorage.getItem('upstox_api_key')    ?? '');
  const [upSecret, setUpSecret] = useState(() => localStorage.getItem('upstox_api_secret') ?? '');

  // Nubra fields
  const [nuPhone,   setNuPhone]   = useState(() => localStorage.getItem('nubra_phone') ?? '');
  const [nuMpin,    setNuMpin]    = useState(() => localStorage.getItem('nubra_mpin')  ?? '');
  const [nuTotpKey, setNuTotpKey] = useState(() => localStorage.getItem('nubra_totp_secret') ?? '');

  const [hasValidCache, setHasValidCache] = useState(false); // today's tokens cached

  // ── Run auto-login with saved credentials ─────────────────────────────────
  const runAutoLogin = useCallback(async (creds: UserCreds, force = false) => {
    setPhase('logging-in');
    setErr('');

    // Skip if already logged in today (unless forced re-generate)
    const alreadyToday = !force
      && localStorage.getItem('nubra_login_date') === todayIST()
      && !!localStorage.getItem('nubra_session_token');

    try {
      // ── Upstox ──
      setMsg('Connecting Upstox…');
      const upRes  = await fetch('/api/upstox-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(creds.upstox ?? {}), force }),
      });
      const upData = await upRes.json();
      if (upData.access_token) {
        localStorage.setItem('upstox_token', upData.access_token);
        saveAuthToken('upstox', upData.access_token).catch(() => {});
      } else if (!upData.cached) {
        setErr(`Upstox: ${upData.error ?? 'Login failed'}`);
        setPhase('error'); return;
      }

      // ── Nubra ──
      if (!alreadyToday && creds.nubra?.totp_secret) {
        setMsg('Connecting Nubra…');
        const nuRes  = await fetch('/api/nubra-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone:       creds.nubra.phone,
            mpin:        creds.nubra.mpin,
            totp_secret: creds.nubra.totp_secret,
          }),
        });
        const nuData = await nuRes.json();
        if (!nuRes.ok || !nuData.session_token) {
          setErr(`Nubra: ${nuData.error ?? nuData.detail?.message ?? 'Login failed'}`);
          setPhase('error'); return;
        }
        const rawCookie = `authToken=${nuData.auth_token}; sessionToken=${nuData.session_token}`;
        localStorage.setItem('nubra_session_token', nuData.session_token);
        localStorage.setItem('nubra_auth_token',    nuData.auth_token);
        localStorage.setItem('nubra_raw_cookie',    rawCookie);
        if (nuData.device_id) localStorage.setItem('nubra_device_id', nuData.device_id);
        localStorage.setItem('nubra_login_date', todayIST());
        saveAuthToken('nubra', nuData.session_token, {
          auth_token: nuData.auth_token,
          raw_cookie: rawCookie,
          device_id:  nuData.device_id,
        }).catch(() => {});
      }

      setMsg('Loading instruments…');
      setPhase('loading-instr');
    } catch (e: any) {
      setErr(e.message); setPhase('error');
    }
  }, []);

  // ── On mount: load saved creds + auth tokens, pre-fill form, show setup page ─
  useEffect(() => {
    const today = todayIST();
    Promise.all([
      loadUserCreds(sub),
      sub !== 'default' ? loadUserCreds('default') : Promise.resolve(null),
      loadAuthToken('nubra'),
      loadAuthToken('upstox'),
    ]).then(([creds, fallback, nubraAuth, upstoxAuth]) => {
      // Pick best creds
      const c = (creds?.nubra?.totp_secret || !fallback) ? creds : fallback;
      if (!creds?.nubra?.totp_secret && fallback?.nubra?.totp_secret && sub !== 'default') {
        saveUserCreds(sub, fallback).catch(() => {});
      }

      // Pre-fill form fields — IDB first, then fallback to localStorage
      const lsPhone    = localStorage.getItem('nubra_phone')       ?? '';
      const lsMpin     = localStorage.getItem('nubra_mpin')        ?? '';
      const lsTotpSec  = localStorage.getItem('nubra_totp_secret') ?? '';
      const lsUpPhone  = localStorage.getItem('upstox_phone')      ?? '';
      const lsUpPin    = localStorage.getItem('upstox_pin')        ?? '';
      const lsUpTotp   = localStorage.getItem('upstox_totp')       ?? '';
      const lsUpKey    = localStorage.getItem('upstox_api_key')    ?? '';
      const lsUpSecret = localStorage.getItem('upstox_api_secret') ?? '';

      setUpPhone(c?.upstox?.phone       || lsUpPhone);
      setUpPin(c?.upstox?.pin           || lsUpPin);
      setUpTotp(c?.upstox?.totp_secret  || lsUpTotp);
      setUpKey(c?.upstox?.api_key       || lsUpKey);
      setUpSecret(c?.upstox?.api_secret || lsUpSecret);
      setNuPhone(c?.nubra?.phone        || lsPhone);
      setNuMpin(c?.nubra?.mpin          || lsMpin);
      setNuTotpKey(c?.nubra?.totp_secret || lsTotpSec);

      // Check if valid cached tokens exist (IDB or localStorage) — store in state for button to use
      const hasValidNubraIDB  = nubraAuth?.date === today && !!nubraAuth?.token;
      const hasValidUpstoxIDB = !!upstoxAuth?.token;
      const lsNubraSession    = localStorage.getItem('nubra_session_token');
      const lsNubraDate       = localStorage.getItem('nubra_login_date');
      const lsUpstox          = localStorage.getItem('upstox_token');
      const hasValidLS        = !!(lsNubraSession && lsNubraDate === today && lsUpstox);

      if (hasValidNubraIDB && hasValidUpstoxIDB) {
        // Backfill localStorage from IDB
        localStorage.setItem('nubra_session_token', nubraAuth!.token);
        if (nubraAuth!.auth_token) localStorage.setItem('nubra_auth_token', nubraAuth!.auth_token);
        if (nubraAuth!.raw_cookie) localStorage.setItem('nubra_raw_cookie', nubraAuth!.raw_cookie);
        if (nubraAuth!.device_id)  localStorage.setItem('nubra_device_id',  nubraAuth!.device_id);
        localStorage.setItem('nubra_login_date', today);
        localStorage.setItem('upstox_token', upstoxAuth!.token);
        setHasValidCache(true);
      } else if (hasValidLS) {
        // Backfill IDB from localStorage
        const lsAuthToken = localStorage.getItem('nubra_auth_token') ?? undefined;
        const lsRawCookie = localStorage.getItem('nubra_raw_cookie') ?? undefined;
        const lsDeviceId  = localStorage.getItem('nubra_device_id')  ?? undefined;
        saveAuthToken('nubra', lsNubraSession!, { auth_token: lsAuthToken, raw_cookie: lsRawCookie, device_id: lsDeviceId }).catch(() => {});
        saveAuthToken('upstox', lsUpstox!).catch(() => {});
        setHasValidCache(true);
      }

      // Always show setup page — user clicks button to enter app
      setPhase('needs-setup');
    }).catch(() => setPhase('needs-setup'));
  }, [sub, runAutoLogin]);

  // ── Instruments ready → enter app ─────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'loading-instr') return;
    if (instrStatus.phase === 'ready' || instrStatus.phase === 'cache-hit') onReady();
  }, [phase, instrStatus.phase, onReady]);

  // ── Step 1: Send Nubra OTP ────────────────────────────────────────────────
  const handleSendOtp = useCallback(async () => {
    if (!upPhone || !upPin || !upTotp || !upKey || !upSecret) { setErr('Fill in all Upstox fields'); return; }
    if (!nuPhone || !nuMpin) { setErr('Fill in all Nubra fields'); return; }
    setLoading(true); setErr('');
    // Save partial creds to IDB + localStorage so form is pre-filled on next visit
    await saveUserCreds(sub, {
      upstox: { phone: upPhone, pin: upPin, totp_secret: upTotp, api_key: upKey, api_secret: upSecret },
      nubra:  { phone: nuPhone, mpin: nuMpin, totp_secret: '' },
    }).catch(() => {});
    localStorage.setItem('upstox_phone',      upPhone);
    localStorage.setItem('upstox_pin',        upPin);
    localStorage.setItem('upstox_totp',       upTotp);
    localStorage.setItem('upstox_api_key',    upKey);
    localStorage.setItem('upstox_api_secret', upSecret);
    localStorage.setItem('nubra_phone',       nuPhone);
    localStorage.setItem('nubra_mpin',        nuMpin);
    try {
      const res  = await fetch('/api/nubra-send-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: nuPhone }),
      });
      const data = await res.json();
      if (!res.ok || !data.temp_token) { setErr(data.error ?? data.message ?? 'Failed to send OTP'); setLoading(false); return; }
      setTempToken(data.temp_token);
      setPhase('otp-sent');
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  }, [upPhone, upPin, upTotp, upKey, upSecret, nuPhone, nuMpin, sub]);

  // ── Step 2: Verify OTP → setup TOTP → save all creds → auto-login ─────────
  const handleVerifyOtp = useCallback(async () => {
    if (!otp) { setErr('Enter OTP'); return; }
    setLoading(true); setErr('');
    try {
      const res  = await fetch('/api/nubra-setup-totp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: nuPhone, otp, mpin: nuMpin, temp_token: tempToken }),
      });
      const data = await res.json();
      if (!res.ok || !data.secret_key) {
        setErr(`${data.error ?? 'Setup failed'}${data.detail?.message ? ': ' + data.detail.message : ''}`);
        setLoading(false); return;
      }
      // Save all creds to IDB
      const creds: UserCreds = {
        upstox: { phone: upPhone, pin: upPin, totp_secret: upTotp, api_key: upKey, api_secret: upSecret },
        nubra:  { phone: nuPhone, mpin: nuMpin, totp_secret: data.secret_key },
      };
      await saveUserCreds(sub, creds).catch(() => {});
      // Save all creds to localStorage for form pre-fill
      localStorage.setItem('upstox_phone',      upPhone);
      localStorage.setItem('upstox_pin',        upPin);
      localStorage.setItem('upstox_totp',       upTotp);
      localStorage.setItem('upstox_api_key',    upKey);
      localStorage.setItem('upstox_api_secret', upSecret);
      // Restore to localStorage
      const rawCookie = `authToken=${data.auth_token}; sessionToken=${data.session_token}`;
      localStorage.setItem('nubra_phone',         nuPhone);
      localStorage.setItem('nubra_mpin',          nuMpin);
      localStorage.setItem('nubra_totp_secret',   data.secret_key);
      localStorage.setItem('nubra_session_token', data.session_token);
      localStorage.setItem('nubra_auth_token',    data.auth_token);
      localStorage.setItem('nubra_raw_cookie',    rawCookie);
      if (data.device_id) localStorage.setItem('nubra_device_id', data.device_id);
      localStorage.setItem('nubra_login_date', todayIST());
      // Cache auth tokens in IDB so next visit skips API calls
      saveAuthToken('nubra', data.session_token, {
        auth_token: data.auth_token,
        raw_cookie: rawCookie,
        device_id:  data.device_id,
      }).catch(() => {});
      if (regenMode) {
        // Nubra done via OTP — now do fresh Upstox login, then enter app
        setMsg('Connecting Upstox…');
        setPhase('logging-in');
        const upRes = await fetch('/api/upstox-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...creds.upstox, force: true }),
        });
        const upData = await upRes.json();
        if (upData.access_token) {
          localStorage.setItem('upstox_token', upData.access_token);
          saveAuthToken('upstox', upData.access_token).catch(() => {});
        } else {
          setErr(`Upstox: ${upData.error ?? 'Login failed'}`);
          setPhase('error'); setLoading(false); return;
        }
        setRegenMode(false);
        setMsg('Loading instruments…');
        setPhase('loading-instr');
      } else {
        runAutoLogin(creds);
      }
      setLoading(false);
    } catch (e: any) { setErr(e.message); setLoading(false); }
  }, [otp, nuPhone, nuMpin, tempToken, upPhone, upPin, upTotp, upKey, upSecret, sub, runAutoLogin, regenMode]);

  const progressPct = () => {
    switch (instrStatus.phase) {
      case 'checking':      return 5;
      case 'cache-hit':     return 40;
      case 'downloading':   return 10 + ((instrStatus as any).progress ?? 0) * 0.5;
      case 'decompressing': return 65;
      case 'parsing':       return 82;
      case 'storing':       return 94;
      case 'ready':         return 100;
      default:              return 0;
    }
  };

  const progressLabel = () => {
    if (phase === 'logging-in') return msg;
    switch (instrStatus.phase) {
      case 'checking':      return 'Checking cache…';
      case 'cache-hit':     return 'Loading from cache…';
      case 'downloading':   return `Downloading… ${Math.round((instrStatus as any).progress ?? 0)}%`;
      case 'decompressing': return 'Decompressing…';
      case 'parsing':       return 'Parsing instruments…';
      case 'storing':       return 'Saving to cache…';
      case 'ready':         return 'Ready!';
      default:              return '';
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#07080f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Work Sans', system-ui, sans-serif", overflowY: 'auto' }}>
      <div style={{ position: 'fixed', top: -100, left: -100, width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle,rgba(43,46,141,0.3) 0%,transparent 65%)', filter: 'blur(60px)', pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', bottom: 0, right: '10%', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle,rgba(79,84,200,0.15) 0%,transparent 65%)', filter: 'blur(60px)', pointerEvents: 'none' }} />

      <div style={{ width: '100%', maxWidth: 460, padding: '40px 24px', position: 'relative', zIndex: 1 }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, justifyContent: 'center' }}>
          <img src="/alphahede.ico" width={34} height={34} style={{ borderRadius: 8 }} alt="AlphaHedge" />
          <span style={{ fontSize: 20, fontWeight: 700, color: '#D1D4DC' }}>Alpha<span style={{ color: '#4f54c8' }}>Hedge</span></span>
        </div>

        {googleUser && (
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginBottom: 24 }}>
            Welcome, <span style={{ color: '#D1D4DC', fontWeight: 600 }}>{googleUser.name}</span>
          </p>
        )}

        {/* Checking */}
        {phase === 'checking' && <p style={{ textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>Checking saved session…</p>}

        {/* Auto-login / loading */}
        {(phase === 'logging-in' || phase === 'loading-instr') && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', marginBottom: 20 }}>{progressLabel()}</p>
            <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 8, height: 6, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ height: '100%', borderRadius: 8, background: 'linear-gradient(90deg,#4f54c8,#7b7fe8)', width: `${phase === 'logging-in' ? 30 : progressPct()}%`, transition: 'width 0.4s ease' }} />
            </div>
            {phase === 'loading-instr' && <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', margin: 0 }}>{progressLabel()}</p>}
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: '#f87171', fontSize: 13, marginBottom: 16 }}>{err}</p>
            <button onClick={() => { setErr(''); setPhase('needs-setup'); }} style={{ fontSize: 13, color: '#4f54c8', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Update credentials</button>
          </div>
        )}

        {/* Credentials form */}
        {phase === 'needs-setup' && (
          <>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center', marginBottom: 20, lineHeight: 1.6 }}>
              Enter your broker credentials — saved only in your browser
            </p>

            {/* Upstox */}
            <div style={{ background: '#0f1020', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', marginBottom: 10 }}>UPSTOX</div>
              <Field label="Phone"       value={upPhone}  onChange={setUpPhone}  placeholder="9XXXXXXXXX" />
              <Field label="PIN"         value={upPin}    onChange={setUpPin}    placeholder="6-digit PIN" type="password" />
              <Field label="TOTP Secret" value={upTotp}   onChange={setUpTotp}   placeholder="Base32 TOTP secret" />
              <Field label="API Key"     value={upKey}    onChange={setUpKey}    placeholder="Upstox API key" />
              <Field label="API Secret"  value={upSecret} onChange={setUpSecret} placeholder="Upstox API secret" type="password" />
            </div>

            {/* Nubra */}
            <div style={{ background: '#0f1020', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', marginBottom: 10 }}>NUBRA</div>
              <Field label="Phone" value={nuPhone} onChange={setNuPhone} placeholder="9XXXXXXXXX" />
              <Field label="MPIN"  value={nuMpin}  onChange={setNuMpin}  placeholder="6-digit MPIN" type="password" />
            </div>

            {err && <p style={{ fontSize: 12, color: '#f87171', marginBottom: 10 }}>{err}</p>}
            {nuTotpKey && upKey && upPhone ? (
              <>
                <Btn loading={loading} onClick={() => {
                  if (hasValidCache) {
                    // Tokens already cached today — go straight to app
                    setMsg('Loading instruments…');
                    setPhase('loading-instr');
                  } else {
                    // No valid tokens — login via API
                    const creds: UserCreds = {
                      upstox: { phone: upPhone, pin: upPin, totp_secret: upTotp, api_key: upKey, api_secret: upSecret },
                      nubra:  { phone: nuPhone, mpin: nuMpin, totp_secret: nuTotpKey },
                    };
                    runAutoLogin(creds);
                  }
                }}>
                  {hasValidCache ? 'Enter App →' : 'Generate Auth Token →'}
                </Btn>
                {hasValidCache && (
                  <button onClick={() => {
                    localStorage.removeItem('nubra_login_date');
                    localStorage.removeItem('nubra_session_token');
                    localStorage.removeItem('nubra_auth_token');
                    localStorage.removeItem('nubra_raw_cookie');
                    localStorage.removeItem('upstox_token');
                    setHasValidCache(false);
                    setRegenMode(true);
                    handleSendOtp();
                  }} style={{ display: 'block', width: '100%', marginTop: 6, padding: 8, background: 'none', border: 'none', fontSize: 12, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}>
                    Re-generate token
                  </button>
                )}
              </>
            ) : (
              <Btn loading={loading} onClick={handleSendOtp}>Send Nubra OTP →</Btn>
            )}
            <button onClick={onReady} style={{ display: 'block', width: '100%', marginTop: 8, padding: 8, background: 'none', border: 'none', fontSize: 12, color: 'rgba(255,255,255,0.2)', cursor: 'pointer' }}>Skip for now</button>
          </>
        )}

        {/* OTP entry */}
        {phase === 'otp-sent' && (
          <div style={{ background: '#0f1020', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '20px 16px' }}>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 16, textAlign: 'center' }}>
              OTP sent to <strong style={{ color: '#D1D4DC' }}>{nuPhone}</strong>
            </p>
            <Field label="OTP" value={otp} onChange={setOtp} placeholder="6-digit OTP" autoFocus />
            {err && <p style={{ fontSize: 12, color: '#f87171', margin: '6px 0 10px' }}>{err}</p>}
            <Btn loading={loading} onClick={handleVerifyOtp}>Verify &amp; Connect →</Btn>
            <button onClick={() => { setPhase('needs-setup'); setErr(''); }} style={{ display: 'block', width: '100%', marginTop: 8, padding: 8, background: 'none', border: 'none', fontSize: 12, color: 'rgba(255,255,255,0.25)', cursor: 'pointer' }}>← Back</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', autoFocus }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder: string; type?: string; autoFocus?: boolean;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} autoFocus={autoFocus}
        style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 7, padding: '8px 11px', fontSize: 13, color: '#D1D4DC', outline: 'none', fontFamily: 'inherit' }}
      />
    </div>
  );
}

function Btn({ loading, onClick, children }: { loading: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{ width: '100%', padding: '11px', background: loading ? 'rgba(79,84,200,0.4)' : 'rgba(79,84,200,0.85)', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 600, color: '#fff', cursor: loading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
    >
      {loading && <span style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />}
      {children}
    </button>
  );
}
