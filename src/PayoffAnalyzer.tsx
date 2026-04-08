'use client';

interface Props {
  legs: any[];
  spot: number;
}

export default function PayoffAnalyzer(_props: Props) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 13, fontFamily: 'var(--font-family-sans)' }}>
      Payoff Analyzer — coming soon
    </div>
  );
}
