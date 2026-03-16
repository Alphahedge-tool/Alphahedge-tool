'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LAYOUT_TEMPLATES } from './layoutTemplates';
import type { LayoutId, LayoutTemplate } from './workspaceTypes';
import s from './LayoutPicker.module.css';

function LayoutThumbnailSVG({ template, active }: { template: LayoutTemplate; active: boolean }) {
  const W = 52, H = 34, GAP = 2;
  const fillActive   = 'rgba(255,152,0,0.28)';
  const fillInactive = 'rgba(255,255,255,0.09)';
  const strokeActive   = 'rgba(255,152,0,0.80)';
  const strokeInactive = 'rgba(255,255,255,0.20)';

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={s.svgBlock}>
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
      className={s.menu}
      style={{ top: pos.top, left: pos.left }}
    >
      {/* Header */}
      <div className={s.header}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="0" y="0" width="5" height="5" rx="1" fill="rgba(255,152,0,0.7)" />
          <rect x="7" y="0" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
          <rect x="0" y="7" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
          <rect x="7" y="7" width="5" height="5" rx="1" fill="rgba(255,152,0,0.4)" />
        </svg>
        <span className={s.headerLabel}>Layout</span>
      </div>

      {/* Grid */}
      <div className={s.grid}>
        {LAYOUT_TEMPLATES.map(tpl => {
          const isActive = tpl.id === activeLayout;
          return (
            <button
              key={tpl.id}
              onClick={() => { onSelect(tpl.id); onClose(); }}
              title={tpl.label}
              className={isActive ? `${s.tplBtn} ${s.tplBtnActive}` : s.tplBtn}
            >
              <LayoutThumbnailSVG template={tpl} active={isActive} />
              <span className={isActive ? `${s.tplLabel} ${s.tplLabelActive}` : s.tplLabel}>
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
