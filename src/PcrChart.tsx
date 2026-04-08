'use client';

interface Props {
  nubraInstruments: any[];
}

export default function PcrChart({ nubraInstruments: _ }: Props) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 13, fontFamily: 'var(--font-family-sans)' }}>
      PCR Chart — coming soon
    </div>
  );
}
