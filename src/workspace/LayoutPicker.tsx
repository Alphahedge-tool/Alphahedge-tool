'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LAYOUT_TEMPLATES } from './layoutTemplates';
import type { LayoutId, LayoutTemplate } from './workspaceTypes';

function LayoutThumbnailSVG({ template, active }: { template: LayoutTemplate; active: boolean }) {
  const W = 52, H = 34, GAP = 2;
  const fillActive   = 'rgba(255,152,0,0.28)';
  const fillInactive = 'rgba(255,255,255,0.09)';
  const strokeActive   = 'rgba(255,152,0,0.80)';
  const strokeInactive = 'rgba(255,255,255,0.20)';

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {/* background */}
      <rect x={0} y={0} width={W} height={H} rx={2} fill="rgba(0,0,0,0.18)" />
      {template.thumbnail.map((cell, i) => (
        <rect
          key={i}
          x={cell.x * W + GAP}
          y={cell.y * H + GAP}
          width={cell.w * W - GAP * 2}
          height={cell.h * H - GAP * 2}
          fill={active ? fillActive : fillInactive}
          stroke={active ? strokeActive : strokeInactive}
          strokeWidth={active ? 1 : 0.75}
          rx={2}
        />
      ))}
    </svg>
  );
}

interface LayoutPickerProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  activeLayout: LayoutId;
  onSelect: (id: LayoutId) => void;
  onClose: () => void;
}

export function LayoutPicker({ anchorRef, activeLayout, onSelect, onClose }: LayoutPickerProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const pos = (() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      return { top: r.bottom + 8, left: r.left };
    }
    return { top: 0, left: 0 };
  })();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !anchorRef.current?.contains(t)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);

  // Group into rows of 4
  const rows: LayoutTemplate[][] = [];
  for (let i = 0; i < LAYOUT_TEMPLATES.length; i += 4) {
    rows.push(LAYOUT_TEMPLATES.slice(i, i + 4));
  }

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9500,
        background: 'linear-gradient(160deg, rgba(18,22,33,0.98) 0%, rgba(14,17,26,0.99) 100%)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 12,
        padding: '10px 10px 10px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.04) inset',
        backdropFilter: 'blur(20px)',
        minWidth: 284,
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
        paddingBottom: 8,
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="0" y="0" width="5" height="5" rx="1" fill="rgba(255,152,0,0.7)" />
          <rect x="7" y="0" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
          <rect x="0" y="7" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
          <rect x="7" y="7" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
        </svg>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'rgba(178,181,190,0.7)',
        }}>
          Layout
        </span>
      </div>

      {/* Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 5,
      }}>
        {LAYOUT_TEMPLATES.map(tpl => {
          const isActive = tpl.id === activeLayout;
          return (
            <button
              key={tpl.id}
              onClick={() => { onSelect(tpl.id); onClose(); }}
              title={tpl.label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '7px 4px 6px',
                border: isActive
                  ? '1px solid rgba(255,152,0,0.55)'
                  : '1px solid rgba(255,255,255,0.07)',
                borderRadius: 7,
                background: isActive
                  ? 'rgba(255,152,0,0.10)'
                  : 'rgba(255,255,255,0.025)',
                cursor: 'pointer',
                transition: 'all 0.12s ease',
                boxShadow: isActive
                  ? '0 0 10px rgba(255,152,0,0.15), inset 0 1px 0 rgba(255,152,0,0.12)'
                  : 'none',
                position: 'relative',
                overflow: 'hidden',
              }}
              onMouseEnter={e => {
                if (!isActive) {
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.background = 'rgba(255,255,255,0.06)';
                  el.style.borderColor = 'rgba(255,255,255,0.16)';
                }
              }}
              onMouseLeave={e => {
                if (!isActive) {
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.background = 'rgba(255,255,255,0.025)';
                  el.style.borderColor = 'rgba(255,255,255,0.07)';
                }
              }}
            >
              <LayoutThumbnailSVG template={tpl} active={isActive} />
              <span style={{
                fontSize: 9,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? '#FF9800' : 'rgba(120,123,134,0.9)',
                letterSpacing: '0.03em',
                lineHeight: 1,
                textAlign: 'center',
                whiteSpace: 'nowrap',
                transition: 'color 0.12s',
              }}>
                {tpl.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
