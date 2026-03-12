'use client';

import { useRef, useState } from 'react';

interface SplitDividerProps {
  axis: 'col' | 'row';
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratios: number[];
  splitIndex: number;
  onRatioChange: (newRatios: number[]) => void;
  style?: React.CSSProperties;
}

export function SplitDivider({
  axis, containerRef, ratios, splitIndex, onRatioChange, style,
}: SplitDividerProps) {
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const startRef = useRef({ client: 0, ratioA: 0, totalPx: 0, available: 0 });
  // Live ratios mutated during drag — never touch React state until pointerup
  const liveRatiosRef = useRef<number[]>([...ratios]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    const rect = containerRef.current!.getBoundingClientRect();
    const gapCount = ratios.length - 1;
    const totalPx = (axis === 'col' ? rect.width : rect.height) - gapCount * 4;
    const available = ratios[splitIndex] + ratios[splitIndex + 1];

    liveRatiosRef.current = [...ratios];
    startRef.current = {
      client: axis === 'col' ? e.clientX : e.clientY,
      ratioA: ratios[splitIndex],
      totalPx,
      available,
    };
    setActive(true);

    // Disable pointer events on all pane contents so iframes/canvases don't eat events
    containerRef.current!.style.pointerEvents = 'none';

    const onMove = (me: PointerEvent) => {
      const { client, ratioA, totalPx: px, available: avail } = startRef.current;
      const delta = (axis === 'col' ? me.clientX : me.clientY) - client;
      const MIN = 80 / px;
      const newA = Math.min(Math.max(ratioA + delta / px, MIN), avail - MIN);
      const newRatios = [...liveRatiosRef.current];
      newRatios[splitIndex] = newA;
      newRatios[splitIndex + 1] = avail - newA;
      liveRatiosRef.current = newRatios;

      // Directly mutate grid style — zero React overhead, zero flicker
      const grid = containerRef.current;
      if (!grid) return;
      if (axis === 'col') {
        grid.style.gridTemplateColumns = newRatios.map(r => `${r}fr`).join(' 4px ');
      } else {
        grid.style.gridTemplateRows = newRatios.map(r => `${r}fr`).join(' 4px ');
      }
    };

    const onUp = () => {
      setActive(false);
      containerRef.current!.style.pointerEvents = '';
      // Commit final ratios to React state only once on release
      onRatioChange(liveRatiosRef.current);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const onDoubleClick = () => {
    const available = ratios[splitIndex] + ratios[splitIndex + 1];
    const equal = available / 2;
    const newRatios = [...ratios];
    newRatios[splitIndex] = equal;
    newRatios[splitIndex + 1] = equal;
    onRatioChange(newRatios);
  };

  const isCol = axis === 'col';
  const highlight = active || hovered;

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...style,
        cursor: isCol ? 'col-resize' : 'row-resize',
        background: active
          ? 'rgba(255,152,0,0.55)'
          : highlight
            ? 'rgba(255,152,0,0.20)'
            : 'transparent',
        transition: active ? 'none' : 'background 0.15s',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Center line — row-divider only; col-divider uses its own background */}
      {!isCol && (
        <div style={{
          position: 'absolute',
          left: 0, right: 0, top: '50%', height: 1, transform: 'translateY(-50%)',
          background: highlight ? 'rgba(255,152,0,0.6)' : 'transparent',
          transition: active ? 'none' : 'background 0.15s',
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}
