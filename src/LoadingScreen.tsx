'use client';

import type { LoadStatus } from './useInstruments';
import s from './LoadingScreen.module.css';

interface Props { status: LoadStatus; }

const STEPS = [
  { key: 'checking',      label: 'Checking cache',        pct: 10 },
  { key: 'cache-hit',     label: 'Loading from cache',    pct: 40 },
  { key: 'downloading',   label: 'Downloading instruments', pct: null },
  { key: 'decompressing', label: 'Decompressing data',    pct: 70 },
  { key: 'parsing',       label: 'Parsing instruments',   pct: 84 },
  { key: 'storing',       label: 'Saving to cache',       pct: 94 },
  { key: 'ready',         label: 'Ready',                 pct: 100 },
];

export default function LoadingScreen({ status }: Props) {
  const isDownloading = status.phase === 'downloading';
  const dlPct = isDownloading ? (status as any).progress ?? 0 : 0;

  const step = STEPS.find(s => s.key === status.phase);
  const pct  = isDownloading
    ? 10 + dlPct * 0.55          // 10–65% during download
    : step?.pct ?? 0;

  const label = isDownloading
    ? `Downloading instruments… ${Math.round(dlPct)}%`
    : step?.label ?? '';

  return (
    <div className={s.root}>
      {/* Background layers */}
      <div className={s.noise} />
      <div className={s.grid} />
      <div className={s.glowBlue} />
      <div className={s.glowIndigo} />

      {/* Center content */}
      <div className={s.center}>

        {/* Logo ring */}
        <div className={s.logoWrap}>
          <div className={s.ringOuter} />
          <div className={s.ringInner} />
          <div className={s.logoCore}>
            <img src="/alphahede.ico" width={26} height={26} style={{ borderRadius: 6, opacity: 0.92 }} alt="" />
          </div>
        </div>

        {/* Wordmark */}
        <div className={s.brand}>Alpha<em>Hedge</em></div>
        <div className={s.tagline}>Loading workspace…</div>

        {/* Progress bar */}
        <div className={s.progressWrap}>
          <div className={s.progressTrack}>
            <div className={s.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <div className={s.progressRow}>
            <span className={s.progressLabel}>{label}</span>
            <span className={s.progressPct}>{Math.round(pct)}%</span>
          </div>
        </div>

        {/* Step dots */}
        <div className={s.dots}>
          {STEPS.filter(st => st.key !== 'ready').map((st, i) => {
            const idx   = STEPS.findIndex(x => x.key === status.phase);
            const myIdx = STEPS.findIndex(x => x.key === st.key);
            const done  = myIdx < idx || status.phase === 'ready';
            const active = st.key === status.phase;
            return (
              <div key={i} className={`${s.dot} ${done ? s.dotDone : active ? s.dotActive : ''}`} />
            );
          })}
        </div>

      </div>
    </div>
  );
}
