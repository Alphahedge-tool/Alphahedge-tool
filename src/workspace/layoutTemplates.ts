import type { LayoutTemplate } from './workspaceTypes';

// Gap-aware grid positions:
// - Pane columns: 1, 3, 5  (divider cols: 2, 4)
// - Pane rows:    1, 3, 5  (divider rows: 2, 4)
// gridArea format: "rowStart / colStart / rowEnd / colEnd"

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: '1x1',
    label: 'Single',
    cols: 1, rows: 1, paneCount: 1,
    areas: ['1 / 1 / 2 / 2'],
    thumbnail: [{ x: 0, y: 0, w: 1, h: 1 }],
  },
  {
    id: '1x2',
    label: 'Side by Side',
    cols: 2, rows: 1, paneCount: 2,
    // gridTemplateColumns = "Xfr 4px Yfr" → pane 1 at col 1, pane 2 at col 3
    areas: ['1 / 1 / 2 / 2', '1 / 3 / 2 / 4'],
    thumbnail: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    id: '2x1',
    label: 'Stacked',
    cols: 1, rows: 2, paneCount: 2,
    areas: ['1 / 1 / 2 / 2', '3 / 1 / 4 / 2'],
    thumbnail: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
  },
  {
    id: '2x2',
    label: '2×2 Grid',
    cols: 2, rows: 2, paneCount: 4,
    areas: [
      '1 / 1 / 2 / 2',
      '1 / 3 / 2 / 4',
      '3 / 1 / 4 / 2',
      '3 / 3 / 4 / 4',
    ],
    thumbnail: [
      { x: 0,   y: 0,   w: 0.5, h: 0.5 },
      { x: 0.5, y: 0,   w: 0.5, h: 0.5 },
      { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: '1L2R',
    label: 'Large Left',
    cols: 2, rows: 2, paneCount: 3,
    // Left pane spans both rows (rows 1-4), right top row 1, right bottom row 3
    areas: [
      '1 / 1 / 4 / 2',
      '1 / 3 / 2 / 4',
      '3 / 3 / 4 / 4',
    ],
    thumbnail: [
      { x: 0,   y: 0,   w: 0.5, h: 1   },
      { x: 0.5, y: 0,   w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: '2L1R',
    label: 'Large Right',
    cols: 2, rows: 2, paneCount: 3,
    areas: [
      '1 / 1 / 2 / 2',
      '3 / 1 / 4 / 2',
      '1 / 3 / 4 / 4',
    ],
    thumbnail: [
      { x: 0,   y: 0,   w: 0.5, h: 0.5 },
      { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0,   w: 0.5, h: 1   },
    ],
  },
  {
    id: '1T2B',
    label: 'Top + Two',
    cols: 2, rows: 2, paneCount: 3,
    // Top pane spans both columns
    areas: [
      '1 / 1 / 2 / 4',
      '3 / 1 / 4 / 2',
      '3 / 3 / 4 / 4',
    ],
    thumbnail: [
      { x: 0,   y: 0,   w: 1,   h: 0.5 },
      { x: 0,   y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: '3col',
    label: 'Three Columns',
    cols: 3, rows: 1, paneCount: 3,
    areas: ['1 / 1 / 2 / 2', '1 / 3 / 2 / 4', '1 / 5 / 2 / 6'],
    thumbnail: [
      { x: 0,     y: 0, w: 0.333, h: 1 },
      { x: 0.333, y: 0, w: 0.334, h: 1 },
      { x: 0.667, y: 0, w: 0.333, h: 1 },
    ],
  },
];

export function buildGridTemplate(ratios: number[]): string {
  return ratios.map(r => `${(r * 1000).toFixed(0)}fr`).join(' 4px ');
}
