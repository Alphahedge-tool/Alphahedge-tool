import { useState, useEffect, useCallback } from 'react';
import { useInstruments } from './useInstruments';
import { loadUserCreds, saveUserCreds, type UserCreds } from './db';
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

  // Upstox fields
  const [upPhone,  setUpPhone]  = useState('');
  const [upPin,    setUpPin]    = useState('');
  const [upTotp,   setUpTotp]   = useState('');
  const [upKey,    setUpKey]    = useState('');
  const [upSecret, setUpSecret] = useState('');

  // Nubra fields
  const [nuPhone, setNuPhone] = useState('');
  const [nuMpin,  setNuMpin]  = useState('');

  // ── Run auto-login with saved credentials ─────────────────────────────────
  const runAutoLogin = useCallback(async (creds: UserCreds) => {
    setPhase('logging-in');
    setErr('');

    // Skip if already logged in today
    const alreadyToday = localStorage.getItem('nubra_login_date') === todayIST()
      && !!localStorage.getItem('nubra_session_token');

    try {
      // ── Upstox ──
      setMsg('Connecting Upstox…');
      const upRes  = await fetch('/api/upstox-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds.upstox ?? {}),
      });
      const upData = await upRes.json();
      if (upData.access_token) {
        localStorage.setItem('upstox_token', upData.access_token);
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
        localStorage.setItem('nubra_session_token', nuData.session_token);
        localStorage.setItem('nubra_auth_token',    nuData.auth_token);
        localStorage.setItem('nubra_raw_cookie',    `authToken=${nuData.auth_token}; sessionToken=${nuData.session_token}`);
        if (nuData.device_id) localStorage.setItem('nubra_device_id', nuData.device_id);
        localStorage.setItem('nubra_login_date', todayIST());
      }

      setMsg('Loading instruments…');
      setPhase('loading-instr');
    } catch (e: any) {
      setErr(e.message); setPhase('error');
    }
  }, []);

  // ── On mount: load creds from IDB ─────────────────────────────────────────
  useEffect(() => {
    loadUserCreds(sub)
      .then(creds => {
        if (creds?.upstox?.api_key && creds?.nubra?.totp_secret) {
          // Restore to localStorage for rest of app
          localStorage.setItem('nubra_phone',       creds.nubra.phone);
          localStorage.setItem('nubra_mpin',        creds.nubra.mpin);
          localStorage.setItem('nubra_totp_secret', creds.nubra.totp_secret);
          runAutoLogin(creds);
        } else {
          // Pre-fill whatever we have
          if (creds?.upstox) { setUpPhone(creds.upstox.phone); setUpPin(creds.upstox.pin); setUpTotp(creds.upstox.totp_secret); setUpKey(creds.upstox.api_key); setUpSecret(creds.upstox.api_secret); }
          if (creds?.nubra)  { setNuPhone(creds.nubra.phone); setNuMpin(creds.nubra.mpin); }
          setPhase('needs-setup');
        }
      })
      .catch(() => setPhase('needs-setup'));
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
  }, [upPhone, upPin, upTotp, upKey, upSecret, nuPhone, nuMpin]);

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
      // Restore to localStorage
      localStorage.setItem('nubra_phone',       nuPhone);
      localStorage.setItem('nubra_mpin',        nuMpin);
      localStorage.setItem('nubra_totp_secret', data.secret_key);
      localStorage.setItem('nubra_session_token', data.session_token);
      localStorage.setItem('nubra_auth_token',    data.auth_token);
      localStorage.setItem('nubra_raw_cookie',    `authToken=${data.auth_token}; sessionToken=${data.session_token}`);
      if (data.device_id) localStorage.setItem('nubra_device_id', data.device_id);
      localStorage.setItem('nubra_login_date', todayIST());
      setLoading(false);
      runAutoLogin(creds);
    } catch (e: any) { setErr(e.message); setLoading(false); }
  }, [otp, nuPhone, nuMpin, tempToken, upPhone, upPin, upTotp, upKey, upSecret, sub, runAutoLogin]);

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
            <Btn loading={loading} onClick={handleSendOtp}>Send Nubra OTP →</Btn>
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
