import { useEffect, useRef, useState } from 'react';
import s from './LandingPage.module.css';

interface Props {
  onEnter: (user?: GoogleUser) => void;
  googleUser?: GoogleUser | null;
  onSignOut?: () => void;
}

export interface GoogleUser {
  name: string;
  email: string;
  picture: string;
  sub: string;
}

const mkBars = (seed: number) =>
  Array.from({ length: 20 }, (_, i) => Math.abs(Math.sin(seed + i * 0.7)) * 100);

const OC_ROWS = [
  { strike: 24500, ceOi: '12.4L', ceLtp: 142.5,  ceIv: 11.2, peOi: '8.1L',  peLtp: 98.3,  peIv: 12.1, atm: false },
  { strike: 24550, ceOi: '18.2L', ceLtp: 108.0,  ceIv: 11.8, peOi: '14.3L', peLtp: 124.5, peIv: 12.6, atm: false },
  { strike: 24600, ceOi: '32.1L', ceLtp: 78.25,  ceIv: 12.4, peOi: '28.7L', peLtp: 158.9, peIv: 13.1, atm: true  },
  { strike: 24650, ceOi: '14.8L', ceLtp: 52.10,  ceIv: 12.9, peOi: '19.2L', peLtp: 198.4, peIv: 13.8, atm: false },
  { strike: 24700, ceOi: '9.3L',  ceLtp: 31.75,  ceIv: 13.5, peOi: '11.4L', peLtp: 242.0, peIv: 14.2, atm: false },
];

function Spark({ seed, color }: { seed: number; color: string }) {
  const bars = mkBars(seed);
  const max = Math.max(...bars);
  const pts = bars.map((b, i) => `${(i / (bars.length - 1)) * 60},${20 - (b / max) * 18}`).join(' ');
  return (
    <svg width="60" height="20" viewBox="0 0 60 20">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
    </svg>
  );
}

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { threshold: 0.08 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return { ref, visible };
}

// ── Google icon ───────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

// ── Auth Modal ────────────────────────────────────────────────────────────────
function AuthModal({ onClose, onEnter }: { onClose: () => void; onEnter: (user?: GoogleUser) => void }) {
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 300);
  }

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    onEnter();
  }

  return (
    <div className={`${s.modalOverlay} ${visible ? s.modalOverlayIn : ''}`} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className={`${s.modalCard} ${visible ? s.modalCardIn : ''}`}>

        {/* close */}
        <button className={s.modalClose} onClick={handleClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>

        {/* logo */}
        <div className={s.modalLogo}>
          <img src="/alpha-logo-blue.jpg" height={48} style={{ borderRadius: 10, display: 'block' }} alt="AlphaHedge" />
          <div className={s.modalTagline}>Professional Options Terminal</div>
        </div>

        {/* tabs */}
        <div className={s.modalTabs}>
          <button className={`${s.modalTab} ${tab === 'login' ? s.modalTabActive : ''}`} onClick={() => setTab('login')}>Sign In</button>
          <button className={`${s.modalTab} ${tab === 'signup' ? s.modalTabActive : ''}`} onClick={() => setTab('signup')}>Sign Up</button>
        </div>

        {/* Google */}
        <button className={s.googleBtn} onClick={() => { window.location.href = '/auth/google'; }}>
          <GoogleIcon />
          Continue with Google
        </button>

        <div className={s.divider}><span>or</span></div>

        {/* Form */}
        <form className={s.authForm} onSubmit={handleSubmit}>
          {tab === 'signup' && (
            <div className={s.inputGroup}>
              <label className={s.inputLabel}>Full Name</label>
              <input
                className={s.authInput}
                type="text"
                placeholder="Arnab Kumar"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className={s.inputGroup}>
            <label className={s.inputLabel}>Email</label>
            <input
              className={s.authInput}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoFocus={tab === 'login'}
            />
          </div>
          <div className={s.inputGroup}>
            <label className={s.inputLabel}>Password</label>
            <input
              className={s.authInput}
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          {tab === 'login' && (
            <div style={{ textAlign: 'right', marginTop: -8 }}>
              <button type="button" className={s.forgotBtn}>Forgot password?</button>
            </div>
          )}
          <button type="submit" className={s.authSubmit}>
            {tab === 'login' ? 'Sign In' : 'Create Account'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </button>
        </form>

        <p className={s.modalFooterNote}>
          By continuing you agree to our <button className={s.inlineLink}>Terms</button> and <button className={s.inlineLink}>Privacy Policy</button>.
        </p>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>, title: 'Real-Time Option Chain', desc: 'Live Greeks, IV & OI across all strikes via WebSocket from NSE, BSE & MCX — sub-2ms latency.', color: '#818cf8' },
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>, title: 'Advanced Backtesting', desc: 'Simulate multi-leg strategies on historical data with P&L curves, max drawdown & win rate.', color: '#f472b6' },
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>, title: 'Greeks Engine', desc: 'Delta, Gamma, Theta, Vega & IV computed live using Black-Scholes calibrated to Nubra data.', color: '#34d399' },
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>, title: 'Multi-Pane Workspace', desc: 'Drag, resize and dock charts, option chains and strategy panels in a fully custom layout.', color: '#fb923c' },
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>, title: 'Basket Orders', desc: 'Build multi-leg strategies, calculate net premium and execute via Dhan or paper trade mode.', color: '#38bdf8' },
  { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>, title: 'MTM Analyser', desc: 'Mark-to-market P&L tracker with live position monitoring, exposure breakdown and IV overlay.', color: '#a78bfa' },
];

const STEPS = [
  { num: '01', title: 'Connect your broker', desc: 'Link Dhan or Nubra in under 60 seconds. No API keys to manage — just login once.' },
  { num: '02', title: 'Load the terminal', desc: 'Your option chains, positions and charts load instantly with live WebSocket data.' },
  { num: '03', title: 'Trade with precision', desc: 'Analyse Greeks, run backtests, build baskets and execute — all in one workspace.' },
];

export default function LandingPage({ onEnter, googleUser, onSignOut }: Props) {
  const feat  = useReveal();
  const steps = useReveal();
  const cta   = useReveal();
  const [showAuth, setShowAuth] = useState(false);

  function openAuth() { setShowAuth(true); }

  return (
    <div className={s.page}>
      <div className={s.glowOrange} />
      <div className={s.glowPurple} />
      <div className={s.glowBlue} />
      <div className={s.noise} />

      {/* ── Nav ── */}
      <nav className={s.nav}>
        <a className={s.navLogo} href="#">
          <img src="/alpha-logo-blue.jpg" style={{ height: 44, width: 'auto', maxWidth: 180, objectFit: 'contain' }} alt="AlphaHedge" />
        </a>
        <div className={s.navLinks}>
          <button className={s.navLink}>Features</button>
          <button className={s.navLink}>How it works</button>
          <button className={s.navLink}>Docs</button>
          {googleUser ? (
            <div className={s.navProfile}>
              {googleUser.picture
                ? <img src={googleUser.picture} className={s.navAvatar} alt={googleUser.name} referrerPolicy="no-referrer" />
                : <div className={s.navAvatarFallback}>{googleUser.name?.[0]?.toUpperCase()}</div>
              }
              <div className={s.navProfileDrop}>
                <div className={s.navProfileName}>{googleUser.name}</div>
                <div className={s.navProfileEmail}>{googleUser.email}</div>
                <div className={s.navProfileDivider} />
                <button className={s.navProfileBtn} onClick={() => onEnter()}>Open Terminal</button>
                <button className={s.navProfileBtn} style={{ color: '#f87171' }} onClick={onSignOut}>Sign Out</button>
              </div>
            </div>
          ) : (
            <button className={s.navCta} onClick={openAuth}>Log In →</button>
          )}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className={s.hero}>
        <div className={s.heroGrid} />

        <div className={s.heroBadge}>
          <span className={s.heroBadgeDot} />
          Now live — NSE · BSE · MCX
        </div>

        <h1 className={s.heroH1}>
          Your Options,<br />
          <span className={s.grad}>Amplified.</span>
        </h1>

        <p className={s.heroSub}>
          Professional-grade option chain analytics, live Greeks, multi-leg backtesting and smart order execution — built for serious derivatives traders.
        </p>

        <button className={s.btnPrimary} onClick={openAuth}>
          Get Started
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>

        {/* ── Floating UI cards ── */}
        <div className={s.cardsWrap}>
          <div className={`${s.card} ${s.cardChain}`}>
            <div className={s.cardHeader}>
              <span className={s.cardTitle}>NIFTY 24 Apr</span>
              <span className={s.cardLive}><span className={s.liveDot}/>LIVE</span>
            </div>
            <table className={s.ocTable}>
              <thead>
                <tr><th>OI</th><th>LTP</th><th>IV</th><th className={s.strikeCol}>STRIKE</th><th>IV</th><th>LTP</th><th>OI</th></tr>
              </thead>
              <tbody>
                {OC_ROWS.map((r) => (
                  <tr key={r.strike} className={r.atm ? s.atmRow : ''}>
                    <td className={s.ceCell}>{r.ceOi}</td>
                    <td className={s.ceCell} style={{ color: '#34d399', fontWeight: 700 }}>{r.ceLtp.toFixed(2)}</td>
                    <td className={s.ceCell} style={{ color: 'rgba(255,255,255,0.4)' }}>{r.ceIv}</td>
                    <td className={s.strikeCell}>{r.strike}</td>
                    <td className={s.peCell} style={{ color: 'rgba(255,255,255,0.4)' }}>{r.peIv}</td>
                    <td className={s.peCell} style={{ color: '#f87171', fontWeight: 700 }}>{r.peLtp.toFixed(2)}</td>
                    <td className={s.peCell}>{r.peOi}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${s.card} ${s.cardMtm}`}>
            <div className={s.cardHeader}><span className={s.cardTitle}>MTM Today</span></div>
            <div className={s.mtmBig} style={{ color: '#34d399' }}>+₹18,420</div>
            <div className={s.mtmSub}>+2.34% from entry</div>
            <div className={s.mtmRows}>
              {[{ sym: 'NIFTY CE', val: '+₹9,100', up: true, seed: 2 }, { sym: 'NIFTY PE', val: '-₹1,240', up: false, seed: 5 }, { sym: 'BNF CE', val: '+₹10,560', up: true, seed: 8 }].map((r, i) => (
                <div key={i} className={s.mtmRow}>
                  <span className={s.mtmSym}>{r.sym}</span>
                  <Spark seed={r.seed} color={r.up ? '#34d399' : '#f87171'} />
                  <span style={{ color: r.up ? '#34d399' : '#f87171', fontWeight: 700, fontSize: 12 }}>{r.val}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={`${s.card} ${s.cardGreeks}`}>
            <div className={s.cardHeader}><span className={s.cardTitle}>Greeks · 24600 CE</span></div>
            <div className={s.greeksGrid}>
              {[{ label: 'Delta', val: '0.482', color: '#818cf8' }, { label: 'Gamma', val: '0.0021', color: '#f472b6' }, { label: 'Theta', val: '-18.4', color: '#fb923c' }, { label: 'Vega', val: '24.7', color: '#34d399' }, { label: 'IV', val: '12.4%', color: '#38bdf8' }, { label: 'OI Chg', val: '+3.2L', color: '#a78bfa' }].map((g, i) => (
                <div key={i} className={s.greekItem}>
                  <span className={s.greekLabel}>{g.label}</span>
                  <span className={s.greekVal} style={{ color: g.color }}>{g.val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <div className={s.statsStrip}>
        {[{ num: '50K+', label: 'Instruments tracked' }, { num: '<2ms', label: 'WebSocket latency' }, { num: '6', label: 'Strategy modules' }, { num: '100%', label: 'Client-side privacy' }].map((st, i) => (
          <div key={i} className={s.statItem}>
            <div className={s.statNum}>{st.num}</div>
            <div className={s.statLabel}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* ── Features ── */}
      <div ref={feat.ref}>
        <section className={s.section} style={{ opacity: feat.visible ? 1 : 0, transform: feat.visible ? 'none' : 'translateY(32px)', transition: 'opacity 0.7s ease, transform 0.7s ease' }}>
          <div className={s.sectionBadge}>Capabilities</div>
          <h2 className={s.sectionH2}><span className={s.grad}>Everything you need</span><br />to trade options precisely</h2>
          <p className={s.sectionSub}>From raw market data to structured strategy analytics — all in one terminal.</p>
          <div className={s.featGrid}>
            {FEATURES.map((f, i) => (
              <div key={i} className={s.featCard} style={{ opacity: feat.visible ? 1 : 0, transform: feat.visible ? 'none' : 'translateY(20px)', transition: `opacity 0.5s ease ${i * 0.08}s, transform 0.5s ease ${i * 0.08}s` }}>
                <div className={s.featIcon} style={{ color: f.color, background: `${f.color}15`, borderColor: `${f.color}30` }}>{f.icon}</div>
                <div className={s.featTitle}>{f.title}</div>
                <div className={s.featDesc}>{f.desc}</div>
                <div className={s.featAccent} style={{ background: `linear-gradient(90deg, ${f.color}40, transparent)` }} />
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── How it works ── */}
      <div ref={steps.ref}>
        <section className={s.stepsSection} style={{ opacity: steps.visible ? 1 : 0, transform: steps.visible ? 'none' : 'translateY(32px)', transition: 'opacity 0.7s ease, transform 0.7s ease' }}>
          <div className={s.sectionBadge}>How it works</div>
          <h2 className={s.sectionH2}><span className={s.grad}>Up and running</span><br />in under 60 seconds</h2>
          <div className={s.stepsGrid}>
            {STEPS.map((st, i) => (
              <div key={i} className={s.stepCard} style={{ opacity: steps.visible ? 1 : 0, transform: steps.visible ? 'none' : 'translateY(20px)', transition: `opacity 0.5s ease ${i * 0.12}s, transform 0.5s ease ${i * 0.12}s` }}>
                <div className={s.stepNum}>{st.num}</div>
                <div className={s.stepTitle}>{st.title}</div>
                <div className={s.stepDesc}>{st.desc}</div>
                {i < STEPS.length - 1 && <div className={s.stepArrow}>→</div>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── CTA ── */}
      <div ref={cta.ref}>
        <section className={s.ctaSection} style={{ opacity: cta.visible ? 1 : 0, transform: cta.visible ? 'none' : 'translateY(32px)', transition: 'opacity 0.7s ease, transform 0.7s ease' }}>
          <div className={s.ctaGlowOrange} />
          <div className={s.ctaGlowPurple} />
          <div className={s.ctaCard}>
            <div className={s.ctaInner}>
              <h2 className={s.ctaH2}>Start trading smarter today</h2>
              <p className={s.ctaSub}>No signup required. Connect your broker, load the terminal and start analysing in under 60 seconds.</p>
              <button className={s.btnPrimary} onClick={openAuth}>
                Open Terminal
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* ── Footer ── */}
      <footer className={s.footer}>
        <div className={s.footerLeft}>
          <img src="/alpha-logo-blue.jpg" height={20} style={{ borderRadius: 4, display: 'block' }} alt="AlphaHedge" />
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)' }}>© 2026 AlphaHedge. All rights reserved.</span>
        </div>
        <div className={s.footerRight}>
          <button className={s.footerLink}>Privacy</button>
          <button className={s.footerLink}>Terms</button>
          <button className={s.footerLink}>GitHub</button>
        </div>
      </footer>

      {/* ── Auth Modal ── */}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onEnter={onEnter} />}
    </div>
  );
}
