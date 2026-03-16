import React, { useEffect, useState, useRef } from 'react';
import s from './SplashScreen.module.css';

// ── Tickers ───────────────────────────────────────────────────────────────────
const TICKERS = [
  { name: 'NIFTY',     base: 24350 },
  { name: 'BNKN',      base: 52800 },
  { name: 'SENSEX',    base: 80120 },
  { name: 'FINNIFTY',  base: 23640 },
];

// ── Candlestick data (static, decorative) ────────────────────────────────────
const CANDLES = Array.from({ length: 42 }, (_, i) => {
  const body   = 12 + Math.random() * 52;
  const wickT  = body * (0.1 + Math.random() * 0.4);
  const wickB  = body * (0.1 + Math.random() * 0.3);
  const isUp   = Math.random() > 0.44;
  return { body, wickT, wickB, isUp, delay: `${i * 0.025}s` };
});

// ── Steps ─────────────────────────────────────────────────────────────────────
const STEPS = [
  'Connecting to market feed',
  'Loading instruments',
  'Calibrating Greeks engine',
  'Initialising option chain',
  'Ready',
];

interface Props { onDone: () => void; }

export default function SplashScreen({ onDone }: Props) {
  const [progress, setProgress] = useState(0);
  const [stepIdx,  setStepIdx]  = useState(0);
  const [vals,     setVals]     = useState(TICKERS.map(t => t.base));
  const [exiting,  setExiting]  = useState(false);
  const doneRef = useRef(false);

  // progress ramp
  useEffect(() => {
    let p = 0;
    const tick = () => {
      const step = p < 55 ? 2.4 : p < 82 ? 1.1 : p < 96 ? 0.5 : 2.2;
      p = Math.min(100, p + step);
      setProgress(p);
      setStepIdx(Math.min(STEPS.length - 1, Math.floor((p / 100) * STEPS.length)));
      if (p < 100) {
        setTimeout(tick, p < 55 ? 38 : p < 82 ? 58 : 75);
      } else if (!doneRef.current) {
        doneRef.current = true;
        setTimeout(() => { setExiting(true); setTimeout(onDone, 580); }, 380);
      }
    };
    const id = setTimeout(tick, 160);
    return () => clearTimeout(id);
  }, [onDone]);

  // ticker flicker
  useEffect(() => {
    const id = setInterval(() => {
      setVals(prev => prev.map((v, i) =>
        Math.round((v + (Math.random() - 0.48) * TICKERS[i].base * 0.00045) * 100) / 100
      ));
    }, 550);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={`${s.root}${exiting ? ' ' + s.exit : ''}`}>

      {/* ── layers ── */}
      <div className={s.noise} />
      <div className={s.grid} />
      <div className={s.glowOrange} />
      <div className={s.glowBlue} />
      <div className={s.scanLine} />

      {/* ── candlestick silhouette ── */}
      <div className={s.candleWrap}>
        {CANDLES.map((c, i) => (
          <div key={i} className={s.candle} style={{ '--cd': c.delay } as React.CSSProperties}>
            <div className={s.candleWick} style={{ height: c.wickT, color: c.isUp ? '#22c55e' : '#ef4444' }} />
            <div className={s.candleBody} style={{
              height: c.body,
              background: c.isUp
                ? 'linear-gradient(180deg, rgba(34,197,94,0.5) 0%, rgba(34,197,94,0.2) 100%)'
                : 'linear-gradient(180deg, rgba(239,68,68,0.5) 0%, rgba(239,68,68,0.2) 100%)',
              border: `1px solid ${c.isUp ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
            }} />
            <div className={s.candleWick} style={{ height: c.wickB, color: c.isUp ? '#22c55e' : '#ef4444' }} />
          </div>
        ))}
      </div>

      {/* ── corner brackets ── */}
      <div className={`${s.corner} ${s.tl}`} />
      <div className={`${s.corner} ${s.tr}`} />
      <div className={`${s.corner} ${s.bl}`} />
      <div className={`${s.corner} ${s.br}`} />

      {/* ── status bottom-left ── */}
      <div className={s.statusRow}>
        <div className={s.statusDot} />
        <span className={s.statusText}>Live Feed</span>
      </div>

      {/* ── version bottom-right ── */}
      <div className={s.versionBadge}>v2.0.0 · NSE · BSE · MCX</div>

      {/* ── main content ── */}
      <div className={s.center}>

        {/* logo */}
        <div className={s.logoWrap}>
          <div className={s.logoRingOuter} />
          <div className={s.logoRingInner} />
          <div className={s.logoCore}>
            <svg className={s.logoIcon} width="24" height="24" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
        </div>

        {/* wordmark */}
        <div className={s.wordmark}>
          <div className={s.brand}>Alpha<em>Hedge</em></div>
          <div className={s.tagline}>Options Intelligence Platform</div>
        </div>

        {/* ticker strip */}
        <div className={s.tickerStrip}>
          {TICKERS.map((t, i) => {
            const diff = vals[i] - t.base;
            const dir  = diff >= 0 ? 'up' : 'down';
            const sign = diff >= 0 ? '+' : '';
            return (
              <div key={t.name} className={s.tick}>
                <span className={s.tickName}>{t.name}</span>
                <span className={`${s.tickValue} ${s[dir]}`}>
                  {vals[i].toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </span>
                <span className={`${s.tickDelta} ${s[dir]}`}>
                  {sign}{diff.toFixed(0)}
                </span>
              </div>
            );
          })}
        </div>

        {/* progress */}
        <div className={s.progressWrap}>
          <div className={s.progressTrack}>
            <div className={s.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <div className={s.progressRow}>
            <span className={s.progressLabel}>{STEPS[stepIdx]}</span>
            <span className={s.progressPct}>{Math.round(progress)}%</span>
          </div>
        </div>

      </div>
    </div>
  );
}
