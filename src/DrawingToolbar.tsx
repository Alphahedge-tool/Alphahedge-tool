'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DrawToolId =
  | 'cursor' | 'crosshair'
  | 'trendline' | 'ray' | 'extended'
  | 'hline' | 'vline' | 'hband'
  | 'rectangle' | 'ellipse' | 'triangle'
  | 'fib' | 'fibarc' | 'fibfan'
  | 'channel' | 'pitchfork'
  | 'arrow' | 'pricerange' | 'daterange'
  | 'measure' | 'text'
  | 'brush';

interface Point { x: number; y: number; price: number; time: number }

interface BaseDrawing { id: string; tool: DrawToolId; color: string; lineWidth: number }
type TrendDrawing   = BaseDrawing & { tool: 'trendline'|'ray'|'extended'; p1: Point; p2: Point };
type HLineDrawing   = BaseDrawing & { tool: 'hline';    price: number };
type VLineDrawing   = BaseDrawing & { tool: 'vline';    time: number };
type HBandDrawing   = BaseDrawing & { tool: 'hband';    price1: number; price2: number };
type RectDrawing    = BaseDrawing & { tool: 'rectangle'; p1: Point; p2: Point };
type EllipseDrawing = BaseDrawing & { tool: 'ellipse';  p1: Point; p2: Point };
type TriDrawing     = BaseDrawing & { tool: 'triangle'; p1: Point; p2: Point; p3: Point; phase: 0|1|2 };
type FibDrawing     = BaseDrawing & { tool: 'fib';      p1: Point; p2: Point };
type FibArcDrawing  = BaseDrawing & { tool: 'fibarc';   p1: Point; p2: Point };
type FibFanDrawing  = BaseDrawing & { tool: 'fibfan';   p1: Point; p2: Point };
type ChannelDrawing = BaseDrawing & { tool: 'channel';  p1: Point; p2: Point; p3: Point; phase: 0|1|2 };
type PitchforkDrawing=BaseDrawing & { tool: 'pitchfork';p1: Point; p2: Point; p3: Point; phase: 0|1|2 };
type ArrowDrawing   = BaseDrawing & { tool: 'arrow';    p1: Point; p2: Point };
type PriceRangeDrawing=BaseDrawing & { tool:'pricerange';p1:Point;p2:Point };
type DateRangeDrawing =BaseDrawing & { tool:'daterange'; p1:Point;p2:Point };
type MeasureDrawing = BaseDrawing & { tool: 'measure';  p1: Point; p2: Point };
type TextDrawing    = BaseDrawing & { tool: 'text';     p: Point; label: string };
type BrushDrawing   = BaseDrawing & { tool: 'brush';    points: Point[] };

export type Drawing =
  | TrendDrawing | HLineDrawing | VLineDrawing | HBandDrawing
  | RectDrawing | EllipseDrawing | TriDrawing
  | FibDrawing | FibArcDrawing | FibFanDrawing
  | ChannelDrawing | PitchforkDrawing
  | ArrowDrawing | PriceRangeDrawing | DateRangeDrawing
  | MeasureDrawing | TextDrawing | BrushDrawing;

type Draft = { tool: DrawToolId; p1: Point; p2: Point; p3?: Point; phase?: number; brushPoints?: Point[] };

// ── Constants ─────────────────────────────────────────────────────────────────

const FIB_LEVELS  = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS  = ['#787B86','#FF9800','#2ebd85','#f23645','#2196F3','#9C27B0','#787B86'];
const DEFAULT_COLOR = '#FF9800';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toXY(chart: IChartApi, series: ISeriesApi<'Candlestick'>, p: Point): [number,number]|null {
  const x = chart.timeScale().timeToCoordinate(p.time as unknown as import('lightweight-charts').Time);
  const y = series.priceToCoordinate(p.price);
  if (x != null && y != null) return [x, y];
  // Fall back to raw pixel coords stored on the Point (used during draft/preview)
  if (p.x != null && p.y != null && (p.x > 0 || p.y > 0)) return [p.x, p.y];
  return null;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, col: string, r = 4) {
  ctx.save();
  ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function rgba(hex: string, a: number) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, col: string) {
  ctx.save();
  ctx.font = '10px "SF Mono","Fira Code",monospace';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(8,10,18,0.88)';
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect?:(x:number,y:number,w:number,h:number,r:number)=>void }).roundRect?.(x-4, y-11, tw+8, 14, 3) ?? ctx.rect(x-4, y-11, tw+8, 14);
  ctx.fill();
  ctx.fillStyle = col; ctx.fillText(text, x, y);
  ctx.restore();
}

function arrowHead(ctx: CanvasRenderingContext2D, x1:number,y1:number,x2:number,y2:number,col:string,size=9) {
  const angle = Math.atan2(y2-y1, x2-x1);
  ctx.save(); ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size*Math.cos(angle-0.4), y2 - size*Math.sin(angle-0.4));
  ctx.lineTo(x2 - size*Math.cos(angle+0.4), y2 - size*Math.sin(angle+0.4));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Master canvas renderer ─────────────────────────────────────────────────────

function renderAll(
  canvas: HTMLCanvasElement,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  drawings: Drawing[],
  draft: Draft | null,
) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.width  / dpr;
  const cssH = canvas.height / dpr;
  const ctx  = canvas.getContext('2d');
  if (!ctx || cssW === 0 || cssH === 0) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  type Item = { d: Drawing|null; dr: Draft|null; alpha: number };
  const items: Item[] = [
    ...drawings.map(d => ({ d, dr: null, alpha: 1 })),
    ...(draft ? [{ d: null, dr: draft, alpha: 0.72 }] : []),
  ];

  for (const item of items) {
    const tool  = item.d?.tool ?? item.dr!.tool;
    const color = item.d?.color ?? DEFAULT_COLOR;
    const lw    = item.d?.lineWidth ?? 1.5;
    ctx.save();
    ctx.globalAlpha = item.alpha;
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.setLineDash([]); ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // ── Cursor / cross ──────────────────────────────────────────────────────
    if (tool === 'hline') {
      const price = item.d ? (item.d as HLineDrawing).price : item.dr!.p1.price;
      const y = series.priceToCoordinate(price);
      if (y != null) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
        label(ctx, price.toFixed(2), cssW - 62, y - 2, color);
      }

    } else if (tool === 'vline') {
      const time = item.d ? (item.d as VLineDrawing).time : item.dr!.p1.time;
      const x = chart.timeScale().timeToCoordinate(time as unknown as import('lightweight-charts').Time);
      if (x != null) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
      }

    // ── Horizontal Band ────────────────────────────────────────────────────
    } else if (tool === 'hband') {
      const price1 = item.d ? (item.d as HBandDrawing).price1 : item.dr!.p1.price;
      const price2 = item.d ? (item.d as HBandDrawing).price2 : item.dr!.p2.price;
      const y1 = series.priceToCoordinate(price1);
      const y2 = series.priceToCoordinate(price2);
      if (y1 != null && y2 != null) {
        ctx.fillStyle = rgba(color, 0.08);
        ctx.fillRect(0, Math.min(y1,y2), cssW, Math.abs(y2-y1));
        ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(cssW, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, y2); ctx.lineTo(cssW, y2); ctx.stroke();
        label(ctx, price1.toFixed(2), cssW - 62, y1 - 2, color);
        label(ctx, price2.toFixed(2), cssW - 62, y2 - 2, color);
      }

    // ── Trend / Ray / Extended ─────────────────────────────────────────────
    } else if (tool === 'trendline' || tool === 'ray' || tool === 'extended') {
      const p1 = item.d ? (item.d as TrendDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as TrendDrawing).p2 : item.dr!.p2;
      const c1 = toXY(chart, series, p1); const c2 = toXY(chart, series, p2);
      if (!c1 || !c2) { ctx.restore(); continue; }
      const [x1,y1]=c1, [x2,y2]=c2, dx=x2-x1, dy=y2-y1;

      if (tool === 'trendline') {
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
        dot(ctx,x1,y1,color); dot(ctx,x2,y2,color);
        // Price labels at endpoints
        label(ctx, p1.price.toFixed(2), x1+6, y1-4, color);
        label(ctx, p2.price.toFixed(2), x2+6, y2-4, color);
      } else if (tool === 'ray') {
        let ex=x2, ey=y2;
        if (Math.abs(dx)>0.5) { const t=dx>0?(cssW-x1)/dx:(-x1)/dx; ex=x1+t*dx; ey=y1+t*dy; }
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(ex,ey); ctx.stroke();
        dot(ctx,x1,y1,color);
      } else {
        ctx.setLineDash([5,4]);
        if (Math.abs(dx)>0.5) {
          const tL=(-x1)/dx, tR=(cssW-x1)/dx;
          ctx.beginPath(); ctx.moveTo(0, y1+tL*dy); ctx.lineTo(cssW, y1+tR*dy); ctx.stroke();
        } else { ctx.beginPath(); ctx.moveTo(x1,0); ctx.lineTo(x1,cssH); ctx.stroke(); }
        dot(ctx,x1,y1,color,3); dot(ctx,x2,y2,color,3);
      }

    // ── Arrow ──────────────────────────────────────────────────────────────
    } else if (tool === 'arrow') {
      const p1 = item.d ? (item.d as ArrowDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as ArrowDrawing).p2 : item.dr!.p2;
      const c1 = toXY(chart, series, p1); const c2 = toXY(chart, series, p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]); ctx.stroke();
      arrowHead(ctx, c1[0],c1[1], c2[0],c2[1], color);
      dot(ctx,c1[0],c1[1],color,3);

    // ── Rectangle ─────────────────────────────────────────────────────────
    } else if (tool === 'rectangle') {
      const p1 = item.d ? (item.d as RectDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as RectDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const rx=Math.min(c1[0],c2[0]), ry=Math.min(c1[1],c2[1]);
      const rw=Math.abs(c2[0]-c1[0]), rh=Math.abs(c2[1]-c1[1]);
      ctx.fillStyle = rgba(color, 0.07);
      ctx.fillRect(rx,ry,rw,rh); ctx.strokeRect(rx,ry,rw,rh);
      dot(ctx,c1[0],c1[1],color,3); dot(ctx,c2[0],c2[1],color,3);

    // ── Ellipse ───────────────────────────────────────────────────────────
    } else if (tool === 'ellipse') {
      const p1 = item.d ? (item.d as EllipseDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as EllipseDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const cx=(c1[0]+c2[0])/2, cy=(c1[1]+c2[1])/2;
      const rx=Math.abs(c2[0]-c1[0])/2, ry=Math.abs(c2[1]-c1[1])/2;
      ctx.fillStyle = rgba(color, 0.07);
      ctx.beginPath(); ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); ctx.fill(); ctx.stroke();

    // ── Triangle ──────────────────────────────────────────────────────────
    } else if (tool === 'triangle') {
      const d = item.d as TriDrawing|null;
      const dr = item.dr;
      const phase = d?.phase ?? dr?.phase ?? 0;
      const p1 = d ? d.p1 : dr!.p1;
      const p2 = d ? d.p2 : dr!.p2;
      const p3 = d ? d.p3 : (dr!.p3 ?? dr!.p2);
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      const c3=toXY(chart,series,p3);
      if (!c1||!c2) { ctx.restore(); continue; }
      if (phase >= 1) {
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]); ctx.stroke();
        dot(ctx,c1[0],c1[1],color,3); dot(ctx,c2[0],c2[1],color,3);
      }
      if (phase >= 2 && c3) {
        ctx.fillStyle = rgba(color, 0.07);
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]);
        ctx.lineTo(c3[0],c3[1]); ctx.closePath(); ctx.fill(); ctx.stroke();
        dot(ctx,c3[0],c3[1],color,3);
      }

    // ── Fibonacci Retracement ─────────────────────────────────────────────
    } else if (tool === 'fib') {
      const p1 = item.d ? (item.d as FibDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as FibDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const pd=p2.price-p1.price;
      const xL=Math.min(c1[0],c2[0]), xR=Math.max(c1[0],c2[0]);
      FIB_LEVELS.forEach((lvl,i) => {
        const price=p1.price+pd*lvl;
        const y=series.priceToCoordinate(price); if (y==null) return;
        ctx.save(); ctx.globalAlpha=item.alpha;
        ctx.strokeStyle=FIB_COLORS[i]; ctx.lineWidth=lvl===0||lvl===1?1.5:1;
        ctx.setLineDash(lvl===0||lvl===1?[]:[5,3]);
        ctx.beginPath(); ctx.moveTo(xL,y); ctx.lineTo(xR,y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font='10px "SF Mono","Fira Code",monospace';
        ctx.fillStyle=FIB_COLORS[i];
        ctx.fillText(`${(lvl*100).toFixed(1)}%  ${price.toFixed(2)}`, xR+6, y+4);
        ctx.restore();
      });

    // ── Fibonacci Arc ─────────────────────────────────────────────────────
    } else if (tool === 'fibarc') {
      const p1 = item.d ? (item.d as FibArcDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as FibArcDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const baseR = Math.hypot(c2[0]-c1[0], c2[1]-c1[1]);
      [0.382,0.5,0.618,1].forEach((lvl,i) => {
        const r = baseR * lvl;
        ctx.save(); ctx.globalAlpha=item.alpha;
        ctx.strokeStyle=FIB_COLORS[i+1]; ctx.lineWidth=1;
        ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.arc(c1[0],c1[1],r,Math.PI,0); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font='10px "SF Mono","Fira Code",monospace';
        ctx.fillStyle=FIB_COLORS[i+1];
        ctx.fillText(`${(lvl*100).toFixed(1)}%`, c1[0]+r+4, c1[1]+4);
        ctx.restore();
      });
      dot(ctx,c1[0],c1[1],color,3); dot(ctx,c2[0],c2[1],color,3);

    // ── Fibonacci Fan ─────────────────────────────────────────────────────
    } else if (tool === 'fibfan') {
      const p1 = item.d ? (item.d as FibFanDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as FibFanDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const dy=c2[1]-c1[1];
      [0.236,0.382,0.5,0.618,0.786].forEach((lvl,i) => {
        ctx.save(); ctx.globalAlpha=item.alpha;
        ctx.strokeStyle=FIB_COLORS[i+1]; ctx.lineWidth=1; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]);
        // Fan: line from p1 toward (p2.x, p1.y + dy*lvl)
        const fanX = c2[0], fanY = c1[1]+dy*lvl;
        const scale = cssW / (fanX-c1[0]+0.001);
        ctx.lineTo(c1[0]+(fanX-c1[0])*scale, c1[1]+(fanY-c1[1])*scale);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font='10px "SF Mono","Fira Code",monospace';
        ctx.fillStyle=FIB_COLORS[i+1];
        ctx.fillText(`${(lvl*100).toFixed(1)}%`, fanX+4, fanY+4);
        ctx.restore();
      });
      dot(ctx,c1[0],c1[1],color,3); dot(ctx,c2[0],c2[1],color,3);

    // ── Parallel Channel ──────────────────────────────────────────────────
    } else if (tool === 'channel') {
      const d = item.d as ChannelDrawing|null;
      const dr = item.dr;
      const phase = d?.phase ?? dr?.phase ?? 0;
      const p1 = d ? d.p1 : dr!.p1;
      const p2 = d ? d.p2 : dr!.p2;
      const p3 = d ? d.p3 : (dr!.p3 ?? dr!.p2);
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      const c3=toXY(chart,series,p3);
      if (!c1||!c2) { ctx.restore(); continue; }
      ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]); ctx.stroke();
      dot(ctx,c1[0],c1[1],color,3); dot(ctx,c2[0],c2[1],color,3);
      if (phase >= 2 && c3) {
        // Parallel line: offset by (c3 - c1) perpendicular distance
        const offY = c3[1] - c1[1];
        ctx.save(); ctx.setLineDash([5,3]); ctx.globalAlpha=item.alpha*0.8;
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]+offY); ctx.lineTo(c2[0],c2[1]+offY); ctx.stroke();
        // Fill between
        ctx.fillStyle = rgba(color, 0.05);
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]);
        ctx.lineTo(c2[0],c2[1]+offY); ctx.lineTo(c1[0],c1[1]+offY); ctx.closePath(); ctx.fill();
        ctx.restore();
        dot(ctx,c3[0],c3[1],color,3);
      }

    // ── Andrews Pitchfork ─────────────────────────────────────────────────
    } else if (tool === 'pitchfork') {
      const d  = item.d as PitchforkDrawing|null;
      const dr = item.dr;
      const phase = d?.phase ?? dr?.phase ?? 0;
      const p1 = d ? d.p1 : dr!.p1;
      const p2 = d ? d.p2 : dr!.p2;
      const p3 = d ? d.p3 : (dr!.p3 ?? dr!.p2);
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      const c3=toXY(chart,series,p3);
      if (!c1) { ctx.restore(); continue; }
      dot(ctx,c1[0],c1[1],color,3);
      if (phase>=1&&c2) { ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c2[0],c2[1]); ctx.stroke(); dot(ctx,c2[0],c2[1],color,3); }
      if (phase>=2&&c2&&c3) {
        // Median line: from p1 to midpoint of p2-p3
        const mx=(c2[0]+c3[0])/2, my=(c2[1]+c3[1])/2;
        // Extend median to edge
        const ddx=mx-c1[0], ddy=my-c1[1];
        const t=(cssW-c1[0])/(ddx||0.001);
        ctx.beginPath(); ctx.moveTo(c1[0],c1[1]); ctx.lineTo(c1[0]+ddx*t, c1[1]+ddy*t); ctx.stroke();
        // Upper/lower tines
        ctx.save(); ctx.setLineDash([4,3]); ctx.globalAlpha=item.alpha*0.8;
        const offY2=c2[1]-my, offY3=c3[1]-my;
        const t2=(cssW-c1[0])/(ddx||0.001);
        ctx.beginPath(); ctx.moveTo(c2[0],c2[1]); ctx.lineTo(c1[0]+ddx*t2, c1[1]+ddy*t2+offY2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(c3[0],c3[1]); ctx.lineTo(c1[0]+ddx*t2, c1[1]+ddy*t2+offY3); ctx.stroke();
        ctx.restore();
        dot(ctx,c3[0],c3[1],color,3);
      }

    // ── Price Range ───────────────────────────────────────────────────────
    } else if (tool === 'pricerange') {
      const p1 = item.d ? (item.d as PriceRangeDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as PriceRangeDrawing).p2 : item.dr!.p2;
      const y1=series.priceToCoordinate(p1.price);
      const y2=series.priceToCoordinate(p2.price);
      if (y1==null||y2==null) { ctx.restore(); continue; }
      ctx.fillStyle=rgba(color,0.06);
      ctx.fillRect(0,Math.min(y1,y2),cssW,Math.abs(y2-y1));
      ctx.setLineDash([6,3]);
      ctx.beginPath(); ctx.moveTo(0,y1); ctx.lineTo(cssW,y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,y2); ctx.lineTo(cssW,y2); ctx.stroke();
      ctx.setLineDash([]);
      const diff=Math.abs(p2.price-p1.price);
      const pct=p1.price>0?diff/p1.price*100:0;
      const mid=(y1+y2)/2;
      const txt=`Δ ${diff.toFixed(2)}  (${pct.toFixed(2)}%)`;
      ctx.font='bold 11px "SF Mono","Fira Code",monospace';
      const tw=ctx.measureText(txt).width;
      ctx.fillStyle='rgba(8,10,18,0.9)';
      const bx=cssW/2-tw/2-8, by=mid-10;
      (ctx as CanvasRenderingContext2D & {roundRect?:(x:number,y:number,w:number,h:number,r:number)=>void}).roundRect?.(bx,by,tw+16,20,4)??ctx.rect(bx,by,tw+16,20);
      ctx.fill(); ctx.strokeStyle=rgba(color,0.3); ctx.lineWidth=1; ctx.stroke();
      ctx.fillStyle=color; ctx.fillText(txt, bx+8, by+14);
      label(ctx, p1.price.toFixed(2), cssW-62, y1-2, color);
      label(ctx, p2.price.toFixed(2), cssW-62, y2-2, color);

    // ── Date Range ────────────────────────────────────────────────────────
    } else if (tool === 'daterange') {
      const p1 = item.d ? (item.d as DateRangeDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as DateRangeDrawing).p2 : item.dr!.p2;
      const x1=chart.timeScale().timeToCoordinate(p1.time as unknown as import('lightweight-charts').Time);
      const x2=chart.timeScale().timeToCoordinate(p2.time as unknown as import('lightweight-charts').Time);
      if (x1==null||x2==null) { ctx.restore(); continue; }
      ctx.fillStyle=rgba(color,0.06);
      ctx.fillRect(Math.min(x1,x2),0,Math.abs(x2-x1),cssH);
      ctx.setLineDash([6,3]);
      ctx.beginPath(); ctx.moveTo(x1,0); ctx.lineTo(x1,cssH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2,0); ctx.lineTo(x2,cssH); ctx.stroke();

    // ── Measure ───────────────────────────────────────────────────────────
    } else if (tool === 'measure') {
      const p1 = item.d ? (item.d as MeasureDrawing).p1 : item.dr!.p1;
      const p2 = item.d ? (item.d as MeasureDrawing).p2 : item.dr!.p2;
      const c1=toXY(chart,series,p1); const c2=toXY(chart,series,p2);
      if (!c1||!c2) { ctx.restore(); continue; }
      const [x1,y1]=c1,[x2,y2]=c2;
      const rx=Math.min(x1,x2), ry=Math.min(y1,y2);
      const rw=Math.abs(x2-x1), rh=Math.abs(y2-y1);
      const pd=p2.price-p1.price;
      const pct=p1.price>0?(pd/p1.price)*100:0;
      ctx.fillStyle=rgba('#2196F3',0.10);
      ctx.strokeStyle='#2196F3'; ctx.lineWidth=1;
      ctx.fillRect(rx,ry,rw,rh); ctx.strokeRect(rx,ry,rw,rh);
      // Cross hairs
      ctx.setLineDash([3,3]); ctx.strokeStyle=rgba('#2196F3',0.5);
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2,y1); ctx.lineTo(x2,y2); ctx.stroke();
      ctx.setLineDash([]);
      // Label
      const sign=pd>=0?'+':'';
      const txt=`${sign}${pd.toFixed(2)}  (${sign}${pct.toFixed(2)}%)`;
      ctx.font='bold 11px "SF Mono","Fira Code",monospace';
      const tw=ctx.measureText(txt).width;
      const mx=rx+rw/2, my=ry+rh/2;
      ctx.fillStyle='rgba(8,10,18,0.92)';
      (ctx as CanvasRenderingContext2D&{roundRect?:(x:number,y:number,w:number,h:number,r:number)=>void}).roundRect?.(mx-tw/2-8,my-10,tw+16,20,4)??ctx.rect(mx-tw/2-8,my-10,tw+16,20);
      ctx.fill();
      ctx.strokeStyle=rgba('#2196F3',0.35); ctx.lineWidth=1; ctx.stroke();
      ctx.fillStyle=pd>=0?'#2ebd85':'#f23645'; ctx.fillText(txt, mx-tw/2, my+4);
      // Endpoint price labels
      label(ctx, p1.price.toFixed(2), x1+4, y1-4, '#2196F3');
      label(ctx, p2.price.toFixed(2), x2+4, y2-4, '#2196F3');

    // ── Text label ────────────────────────────────────────────────────────
    } else if (tool === 'text') {
      const p = item.d ? (item.d as TextDrawing).p  : item.dr!.p1;
      const t = item.d ? (item.d as TextDrawing).label : '📝';
      const c = toXY(chart, series, p);
      if (!c) { ctx.restore(); continue; }
      ctx.font = 'bold 13px -apple-system, "SF Pro Text", sans-serif';
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = rgba(color, 0.14);
      (ctx as CanvasRenderingContext2D&{roundRect?:(x:number,y:number,w:number,h:number,r:number)=>void}).roundRect?.(c[0]-6,c[1]-14,tw+12,18,4)??ctx.rect(c[0]-6,c[1]-14,tw+12,18);
      ctx.fill();
      ctx.strokeStyle=rgba(color,0.4); ctx.lineWidth=1; ctx.stroke();
      ctx.fillStyle = color; ctx.fillText(t, c[0], c[1]);
      dot(ctx, c[0], c[1]+4, color, 3);

    // ── Brush / free draw ─────────────────────────────────────────────────
    } else if (tool === 'brush') {
      const pts = item.d ? (item.d as BrushDrawing).points : item.dr!.brushPoints ?? [];
      if (pts.length < 2) { ctx.restore(); continue; }
      ctx.strokeStyle = rgba(color, 0.8);
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      const first = toXY(chart, series, pts[0]);
      if (!first) { ctx.restore(); continue; }
      ctx.moveTo(first[0], first[1]);
      for (let i=1; i<pts.length; i++) {
        const c = toXY(chart, series, pts[i]);
        if (c) ctx.lineTo(c[0], c[1]);
      }
      ctx.stroke();
    }

    ctx.restore();
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: { id: DrawToolId; title: string; group: string; icon: React.ReactNode }[] = [
  // Cursor
  { id:'cursor',    group:'cursor', title:'Default Cursor',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 1 L4 20 L8.5 16 L12 23.5 L14.5 22.5 L11 15 L17 15 Z"/></svg> },
  { id:'crosshair', group:'cursor', title:'Crosshair',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.5"/></svg> },
  // Lines
  { id:'trendline', group:'lines', title:'Trend Line',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="21" x2="21" y2="3"/><circle cx="3" cy="21" r="2" fill="currentColor"/><circle cx="21" cy="3" r="2" fill="currentColor"/></svg> },
  { id:'ray',       group:'lines', title:'Ray',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="21" x2="21" y2="3"/><circle cx="3" cy="21" r="2" fill="currentColor"/><polyline points="16,3 21,3 21,8"/></svg> },
  { id:'extended',  group:'lines', title:'Extended Line',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 2"><line x1="1" y1="23" x2="23" y2="1"/></svg> },
  { id:'arrow',     group:'lines', title:'Arrow',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="9,5 19,5 19,15"/></svg> },
  { id:'hline',     group:'lines', title:'Horizontal Line',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="2" y1="12" x2="22" y2="12"/><polyline points="18,8 22,12 18,16"/></svg> },
  { id:'vline',     group:'lines', title:'Vertical Line',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="2" x2="12" y2="22"/><polyline points="8,18 12,22 16,18"/></svg> },
  { id:'hband',     group:'lines', title:'Horizontal Band',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="2" y1="8" x2="22" y2="8"/><line x1="2" y1="16" x2="22" y2="16"/><rect x="2" y="8" width="20" height="8" fill="currentColor" fillOpacity="0.12" strokeWidth="0"/></svg> },
  // Shapes
  { id:'rectangle', group:'shapes', title:'Rectangle',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="6" width="18" height="12" rx="1.5"/></svg> },
  { id:'ellipse',   group:'shapes', title:'Ellipse',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="9" ry="6"/></svg> },
  { id:'triangle',  group:'shapes', title:'Triangle',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="12,4 22,20 2,20 12,4"/></svg> },
  // Fibonacci
  { id:'fib',       group:'fib', title:'Fibonacci Retracement',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="3" y1="4" x2="21" y2="4"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="13" x2="21" y2="13"/><line x1="3" y1="17" x2="21" y2="17"/><line x1="4" y1="4" x2="20" y2="17" strokeWidth="2.5"/></svg> },
  { id:'fibarc',    group:'fib', title:'Fibonacci Arc',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 20 Q12 4 20 20"/><line x1="4" y1="20" x2="20" y2="20" strokeDasharray="2 2"/></svg> },
  { id:'fibfan',    group:'fib', title:'Fibonacci Fan',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="3" y1="20" x2="21" y2="4"/><line x1="3" y1="20" x2="21" y2="8"/><line x1="3" y1="20" x2="21" y2="12"/><line x1="3" y1="20" x2="21" y2="16"/></svg> },
  // Channel / Pitchfork
  { id:'channel',   group:'channel', title:'Parallel Channel',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="18" x2="21" y2="6"/><line x1="3" y1="14" x2="21" y2="2" strokeDasharray="3 2"/></svg> },
  { id:'pitchfork', group:'channel', title:"Andrews' Pitchfork",
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4 L12 20"/><path d="M4 8 Q8 12 12 12"/><path d="M20 8 Q16 12 12 12"/></svg> },
  // Annotations
  { id:'pricerange',group:'annot', title:'Price Range',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="6" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/><line x1="6" y1="12" x2="18" y2="12" strokeDasharray="3 2"/><polyline points="2,6 6,6 2,6"/><polyline points="22,6 18,6 22,6"/></svg> },
  { id:'daterange', group:'annot', title:'Date Range',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="4" x2="6" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/><line x1="12" y1="6" x2="12" y2="18" strokeDasharray="3 2"/><polyline points="6,8 2,8"/><polyline points="18,8 22,8"/></svg> },
  { id:'measure',   group:'annot', title:'Measure',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="8" width="20" height="8" rx="1"/><line x1="6" y1="8" x2="6" y2="16"/><line x1="10" y1="8" x2="10" y2="12"/><line x1="14" y1="8" x2="14" y2="12"/><line x1="18" y1="8" x2="18" y2="16"/></svg> },
  { id:'text',      group:'annot', title:'Text Label',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="12" y1="7" x2="12" y2="20"/></svg> },
  { id:'brush',     group:'annot', title:'Brush / Free Draw',
    icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1 1 2.48 1 3.5 1 1.66 0 3-1.34 3-3s-1.34-3.04-1.5-3.04z"/></svg> },
];

const GROUP_ORDER = ['cursor','lines','shapes','fib','channel','annot'];

// ── Shared handle type — lets WorkspaceRoot control the active pane's engine ──

export interface DrawingEngineHandle {
  activeTool: DrawToolId;
  setActiveTool: (t: DrawToolId) => void;
  drawings: Drawing[];
  clearAll: () => void;
  undo: () => void;
  canUndo: boolean;
}

// ── Sidebar component ─────────────────────────────────────────────────────────

interface DrawingToolbarProps {
  activeTool: DrawToolId;
  onToolChange: (t: DrawToolId) => void;
  open: boolean;
  onToggle: () => void;
  drawingCount: number;
  onClearAll: () => void;
  onUndo: () => void;
  canUndo: boolean;
}

const SEP = () => (
  <div style={{
    height: 1,
    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10) 20%, rgba(255,255,255,0.10) 80%, transparent)',
    margin: '2px 5px',
    flexShrink: 0,
  }} />
);

function ToolBtn({ tool, isActive, onClick, w = 32, h = 28 }: { tool: typeof TOOLS[0]; isActive: boolean; onClick: () => void; w?: number; h?: number }) {
  return (
    <button
      onClick={onClick}
      title={tool.title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: w, height: h, borderRadius: 5, flexShrink: 0,
        border: isActive ? '1.5px solid rgba(255,152,0,0.65)' : '1.5px solid transparent',
        background: isActive
          ? 'linear-gradient(135deg,rgba(255,152,0,0.20) 0%,rgba(255,152,0,0.09) 100%)'
          : 'transparent',
        color: isActive ? '#FFB74D' : '#8A8E9A',
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        position: 'relative',
        boxShadow: isActive ? '0 0 6px rgba(255,152,0,0.15)' : 'none',
        padding: 0,
      }}
      onMouseEnter={e => {
        if (!isActive) {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.background = 'rgba(255,255,255,0.08)';
          b.style.color = '#D1D4DC';
          b.style.borderColor = 'rgba(255,255,255,0.12)';
        }
      }}
      onMouseLeave={e => {
        if (!isActive) {
          const b = e.currentTarget as HTMLButtonElement;
          b.style.background = 'transparent';
          b.style.color = '#8A8E9A';
          b.style.borderColor = 'transparent';
        }
      }}
    >
      {tool.icon}
      {isActive && (
        <span style={{
          position: 'absolute', bottom: 2, right: 2,
          width: 3, height: 3, borderRadius: '50%',
          background: '#FF9800',
          boxShadow: '0 0 3px #FF9800',
        }} />
      )}
    </button>
  );
}

export function DrawingToolbar({ activeTool, onToolChange, open, onToggle, drawingCount, onClearAll, onUndo, canUndo }: DrawingToolbarProps) {
  const groups = GROUP_ORDER.map(g => TOOLS.filter(t => t.group === g));
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneH, setPaneH] = useState(600);

  // Measure parent height for compact mode
  useEffect(() => {
    const el = rootRef.current?.parentElement ?? null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPaneH(entry.contentRect.height));
    ro.observe(el);
    setPaneH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const compact = paneH < 320;
  const btnH    = compact ? 22 : 28;
  const btnW    = compact ? 28 : 32;

  return (
    <div ref={rootRef} style={{
      display: 'flex', flexDirection: 'row', alignItems: 'stretch',
      flexShrink: 0, height: '100%',
    }}>
      {/* Tools panel — full height sidebar */}
      {open && (
        <div style={{
          background: '#171717',
          borderRight: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', flexDirection: 'column',
          width: btnW + 8,
          height: '100%',
          overflow: 'hidden',
        }}>
          {/* Scrollable tools area */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarWidth: 'none',
            padding: compact ? '4px 4px 2px' : '6px 4px 4px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
          }}>
            {groups.map((group, gi) => (
              <div key={gi} style={{ display:'flex', flexDirection:'column', alignItems:'center', width:'100%' }}>
                {gi > 0 && <SEP />}
                {group.map(tool => (
                  <ToolBtn
                    key={tool.id}
                    tool={tool}
                    isActive={activeTool === tool.id}
                    onClick={() => onToolChange(tool.id)}
                    w={btnW} h={btnH}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Pinned bottom — undo + clear */}
          <div style={{
            flexShrink: 0,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            padding: compact ? '2px 4px' : '4px 4px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          }}>
            <button
              onClick={onUndo} title="Undo (Ctrl+Z)" disabled={!canUndo}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', width:btnW, height:btnH, borderRadius:5, flexShrink:0, border:'1px solid transparent', background:'transparent', color:canUndo?'#8A8E9A':'#363840', cursor:canUndo?'pointer':'default', transition:'background 0.1s, color 0.1s', padding:0 }}
              onMouseEnter={e => { if (canUndo) { const b=e.currentTarget as HTMLButtonElement; b.style.background='rgba(255,255,255,0.08)'; b.style.color='#D1D4DC'; b.style.borderColor='rgba(255,255,255,0.12)'; }}}
              onMouseLeave={e => { const b=e.currentTarget as HTMLButtonElement; b.style.background='transparent'; b.style.color=canUndo?'#8A8E9A':'#363840'; b.style.borderColor='transparent'; }}
            >
              <svg width={compact?11:13} height={compact?11:13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
              </svg>
            </button>
            <button
              onClick={onClearAll} title={drawingCount>0?`Clear all (${drawingCount})`:'No drawings'} disabled={drawingCount===0}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', width:btnW, height:btnH, borderRadius:5, flexShrink:0, border:'1px solid transparent', background:'transparent', color:drawingCount>0?'#c0404a':'#363840', cursor:drawingCount>0?'pointer':'default', transition:'background 0.1s, color 0.1s', padding:0 }}
              onMouseEnter={e => { if (drawingCount>0) { const b=e.currentTarget as HTMLButtonElement; b.style.background='rgba(242,54,69,0.13)'; b.style.color='#f23645'; b.style.borderColor='rgba(242,54,69,0.28)'; }}}
              onMouseLeave={e => { const b=e.currentTarget as HTMLButtonElement; b.style.background='transparent'; b.style.color=drawingCount>0?'#c0404a':'#363840'; b.style.borderColor='transparent'; }}
            >
              <svg width={compact?11:13} height={compact?11:13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Toggle strip — thin full-height chevron */}
      <button
        onClick={onToggle}
        title={open ? 'Hide drawing tools' : 'Drawing tools'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: compact ? 10 : 12, height: '100%', flexShrink: 0,
          background: open ? 'rgba(255,152,0,0.08)' : '#171717',
          border: 'none',
          borderRight: '1px solid rgba(255,255,255,0.07)',
          cursor: 'pointer',
          color: open ? '#FF9800' : '#4A4E5C',
          transition: 'color 0.15s, background 0.15s',
        }}
        onMouseEnter={e => { const b=e.currentTarget as HTMLButtonElement; b.style.background=open?'rgba(255,152,0,0.16)':'rgba(255,255,255,0.06)'; b.style.color=open?'#FFB74D':'#9B9EA8'; }}
        onMouseLeave={e => { const b=e.currentTarget as HTMLButtonElement; b.style.background=open?'rgba(255,152,0,0.08)':'#171717'; b.style.color=open?'#FF9800':'#4A4E5C'; }}
      >
        <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
          <path d={open ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
        </svg>
      </button>
    </div>
  );
}

// ── useDrawingEngine hook ─────────────────────────────────────────────────────

interface UseDrawingEngineProps {
  chartRef:            React.RefObject<IChartApi | null>;
  seriesRef:           React.RefObject<ISeriesApi<'Candlestick'> | null>;
  wrapperRef:          React.RefObject<HTMLDivElement | null>;
  onDrawingsChange?:   (state: { activeTool: DrawToolId; drawingCount: number; canUndo: boolean }) => void;
}

function uid() { return Math.random().toString(36).slice(2,9); }

// Multi-phase tools: how many clicks needed
const MULTI_PHASE: Partial<Record<DrawToolId, number>> = {
  triangle: 3, channel: 3, pitchfork: 3,
};

export function useDrawingEngine({ chartRef, seriesRef, wrapperRef, onDrawingsChange }: UseDrawingEngineProps) {
  const onDrawingsChangeRef = useRef(onDrawingsChange);
  onDrawingsChangeRef.current = onDrawingsChange;
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const overlayRef     = useRef<HTMLDivElement>(null);
  const drawingsRef    = useRef<Drawing[]>([]);
  const draftRef       = useRef<Draft | null>(null);
  const activeToolRef  = useRef<DrawToolId>('crosshair');
  const isDrawingRef   = useRef(false);
  const rafRef         = useRef<number | null>(null);
  // Multi-phase state (triangle, channel, pitchfork)
  const phaseRef       = useRef(0);
  const phase1PtsRef   = useRef<{p1:Point,p2:Point}|null>(null);

  const [drawings,     setDrawings]       = useState<Drawing[]>([]);
  const [activeTool,   setActiveToolState]= useState<DrawToolId>('crosshair');
  const [toolbarOpen,  setToolbarOpen]    = useState(true);

  drawingsRef.current = drawings;

  const notify = useCallback((overrides?: Partial<{ activeTool: DrawToolId; drawingCount: number; canUndo: boolean }>) => {
    onDrawingsChangeRef.current?.({
      activeTool:   overrides?.activeTool   ?? activeToolRef.current,
      drawingCount: overrides?.drawingCount ?? drawingsRef.current.length,
      canUndo:      overrides?.canUndo      ?? drawingsRef.current.length > 0,
    });
  }, []);

  const setActiveTool = useCallback((t: DrawToolId) => {
    activeToolRef.current = t;
    phaseRef.current = 0;
    phase1PtsRef.current = null;
    draftRef.current = null;
    isDrawingRef.current = false;
    setActiveToolState(t);
    notify({ activeTool: t });
  }, [notify]);

  // ── Sync canvas ────────────────────────────────────────────────────────────
  const syncCanvas = useCallback(() => {
    const canvas = canvasRef.current; const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width        = wrapper.clientWidth  * dpr;
    canvas.height       = wrapper.clientHeight * dpr;
    canvas.style.width  = wrapper.clientWidth  + 'px';
    canvas.style.height = wrapper.clientHeight + 'px';
  }, [wrapperRef]);

  const redraw = useCallback(() => {
    const canvas=canvasRef.current, chart=chartRef.current, series=seriesRef.current;
    if (!canvas||!chart||!series) return;
    renderAll(canvas, chart, series, drawingsRef.current, draftRef.current);
  }, [chartRef, seriesRef]);

  // Keep a stable ref to redraw so pointer handlers never need it in deps
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  const scheduleRedraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; redrawRef.current(); });
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current; if (!wrapper) return;
    const ro = new ResizeObserver(() => { syncCanvas(); redraw(); });
    ro.observe(wrapper); syncCanvas();
    return () => ro.disconnect();
  }, [syncCanvas, redraw, wrapperRef]);

  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const h = () => scheduleRedraw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(h);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(h);
  }, [chartRef, scheduleRedraw]);

  // ── Coordinate helper — stable, reads from refs ────────────────────────────
  // Keeps a last-known-good point so drawing never freezes at chart edges
  const lastGoodPointRef = useRef<Point | null>(null);

  const clientToPoint = useCallback((cx: number, cy: number): Point | null => {
    const chart=chartRef.current, series=seriesRef.current, wrapper=wrapperRef.current;
    if (!chart||!series||!wrapper) return lastGoodPointRef.current;
    const rect=wrapper.getBoundingClientRect();
    // Raw pixel coords relative to wrapper — always store these for pixel fallback
    const rawX=cx-rect.left, rawY=cy-rect.top;

    // Clamp for conversion only (raw coords stay unclamped for rendering)
    const clampedY = Math.max(0, Math.min(rawY, wrapper.clientHeight - 1));
    let price = series.coordinateToPrice(clampedY);

    // Try time conversion — scan leftward if it fails (right margin / price scale)
    const clampedX = Math.max(0, Math.min(rawX, wrapper.clientWidth - 1));
    let time = chart.timeScale().coordinateToTime(clampedX);
    if (time == null) {
      for (let tryX = Math.floor(clampedX) - 1; tryX >= 0; tryX -= 3) {
        time = chart.timeScale().coordinateToTime(tryX);
        if (time != null) break;
      }
    }

    // Always return a Point with raw pixel coords for rendering fallback
    const pt: Point = {
      x: rawX,
      y: rawY,
      price: price ?? lastGoodPointRef.current?.price ?? 0,
      time: (time as unknown as number) ?? lastGoodPointRef.current?.time ?? 0,
    };
    lastGoodPointRef.current = pt;
    return pt;
  }, [chartRef, seriesRef, wrapperRef]);

  // ── Commit drawing — stable, all state via refs ────────────────────────────
  const commitDrawing = useCallback((tool: DrawToolId, p1: Point, p2: Point, p3?: Point) => {
    const base: BaseDrawing = { id:uid(), color:DEFAULT_COLOR, lineWidth:1.5, tool };
    let d: Drawing | null = null;

    if      (tool==='hline')     d = {...base, tool:'hline',     price: p1.price} as HLineDrawing;
    else if (tool==='vline')     d = {...base, tool:'vline',     time: p1.time} as VLineDrawing;
    else if (tool==='hband')     d = {...base, tool:'hband',     price1:p1.price, price2:p2.price} as HBandDrawing;
    else if (tool==='rectangle') d = {...base, tool:'rectangle', p1, p2} as RectDrawing;
    else if (tool==='ellipse')   d = {...base, tool:'ellipse',   p1, p2} as EllipseDrawing;
    else if (tool==='triangle')  d = {...base, tool:'triangle',  p1, p2, p3:p3!, phase:2} as TriDrawing;
    else if (tool==='fib')       d = {...base, tool:'fib',       p1, p2} as FibDrawing;
    else if (tool==='fibarc')    d = {...base, tool:'fibarc',    p1, p2} as FibArcDrawing;
    else if (tool==='fibfan')    d = {...base, tool:'fibfan',    p1, p2} as FibFanDrawing;
    else if (tool==='channel')   d = {...base, tool:'channel',   p1, p2, p3:p3!, phase:2} as ChannelDrawing;
    else if (tool==='pitchfork') d = {...base, tool:'pitchfork', p1, p2, p3:p3!, phase:2} as PitchforkDrawing;
    else if (tool==='arrow')     d = {...base, tool:'arrow',     p1, p2} as ArrowDrawing;
    else if (tool==='pricerange')d = {...base, tool:'pricerange',p1, p2} as PriceRangeDrawing;
    else if (tool==='daterange') d = {...base, tool:'daterange', p1, p2} as DateRangeDrawing;
    else if (tool==='measure')   d = {...base, tool:'measure',   p1, p2} as MeasureDrawing;
    else if (tool==='text')      d = {...base, tool:'text',      p:p1, label:'Label'} as TextDrawing;
    else if (tool==='trendline'||tool==='ray'||tool==='extended')
      d = {...base, tool, p1, p2} as TrendDrawing;

    if (d) {
      const next = [...drawingsRef.current, d];
      drawingsRef.current = next;
      setDrawings(next);

      // Always revert to crosshair after any drawing is committed
      activeToolRef.current = 'crosshair'; setActiveToolState('crosshair');
      notify({ activeTool: 'crosshair', drawingCount: next.length, canUndo: true });
    } else {
      if (tool==='measure'||tool==='text'||tool==='hline'||tool==='vline') {
        activeToolRef.current = 'crosshair'; setActiveToolState('crosshair');
        notify({ activeTool: 'crosshair' });
      }
    }
    draftRef.current = null;
    redrawRef.current();
  }, [notify]);

  // Stable refs so pointer effect never needs to re-run
  const clientToPointRef = useRef(clientToPoint);
  clientToPointRef.current = clientToPoint;
  const commitDrawingRef = useRef(commitDrawing);
  commitDrawingRef.current = commitDrawing;
  const scheduleRedrawRef = useRef(scheduleRedraw);
  scheduleRedrawRef.current = scheduleRedraw;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // ── Single-click tools (commit on first click, no second point needed) ──────
  const SINGLE_CLICK = new Set<DrawToolId>(['hline', 'vline', 'text']);

  // ── Helper: forward mousemove to LWC chart so crosshair stays visible ──────
  // RAF-throttled to avoid jank from dispatching on every pointermove
  const crosshairRafRef = useRef<number | null>(null);
  const forwardCrosshair = (e: PointerEvent, el: HTMLElement) => {
    if (crosshairRafRef.current !== null) return;
    const cx = e.clientX, cy = e.clientY;
    crosshairRafRef.current = requestAnimationFrame(() => {
      crosshairRafRef.current = null;
      const wrapper = el.parentElement;
      if (!wrapper) return;
      const chartEl = wrapper.querySelector<HTMLElement>('[data-chart-container]');
      if (!chartEl) return;
      // LWC mounts its own root element inside the container — dispatch on it
      const lwcRoot = chartEl.firstElementChild as HTMLElement | null;
      if (lwcRoot) {
        lwcRoot.dispatchEvent(new MouseEvent('mousemove', {
          clientX: cx,
          clientY: cy,
          bubbles: true,
          cancelable: true,
        }));
      }
    });
  };

  // ── Native pointer event listeners — runs ONCE, reads everything via refs ──
  useEffect(() => {
    const el = overlayRef.current; if (!el) return;

    // ── CLICK handler: all tools use click-click (except brush=drag) ─────────
    const onDown = (e: PointerEvent) => {
      const tool = activeToolRef.current;
      if (tool==='cursor'||tool==='crosshair') return;
      e.preventDefault();
      e.stopPropagation();
      const p = clientToPointRef.current(e.clientX, e.clientY); if (!p) return;

      // ── Brush: the only drag tool — uses pointer capture ──────────────────
      if (tool === 'brush') {
        el.setPointerCapture(e.pointerId);
        isDrawingRef.current = true;
        draftRef.current = { tool, p1:p, p2:p, brushPoints:[p] };
        scheduleRedrawRef.current();
        return;
      }

      // ── Single-click tools: commit immediately on first click ─────────────
      if (SINGLE_CLICK.has(tool)) {
        commitDrawingRef.current(tool, p, p);
        return;
      }

      // ── All remaining tools: click-click (or click-click-click for 3-phase)
      const maxPhases = MULTI_PHASE[tool]; // 3 for triangle/channel/pitchfork

      if (phaseRef.current === 0) {
        // First click → set starting point, enter phase 1
        isDrawingRef.current = true;
        phaseRef.current = 1;
        phase1PtsRef.current = { p1:p, p2:p };
        draftRef.current = { tool, p1:p, p2:p, ...(maxPhases ? { phase: 1 } : {}) };
        scheduleRedrawRef.current();
      } else if (phaseRef.current === 1) {
        if (maxPhases) {
          // 3-phase tool: lock p2, enter phase 2
          const savedP1 = phase1PtsRef.current!.p1;
          const savedP2 = phase1PtsRef.current!.p2;
          phaseRef.current = 2;
          draftRef.current = { tool, p1:savedP1, p2:savedP2, p3:p, phase:2 };
          scheduleRedrawRef.current();
        } else {
          // 2-click tool: second click → commit drawing
          const dr = draftRef.current!;
          const dist = Math.hypot(p.x - dr.p1.x, p.y - dr.p1.y);
          if (dist < 3) return; // Ignore click if too close to start (accidental double-click)
          commitDrawingRef.current(tool, dr.p1, p);
          phaseRef.current = 0;
          phase1PtsRef.current = null;
          isDrawingRef.current = false;
        }
      } else if (phaseRef.current === 2) {
        // 3-phase tool: third click → commit
        const dr = draftRef.current!;
        commitDrawingRef.current(tool, dr.p1, dr.p2, p);
        phaseRef.current = 0;
        phase1PtsRef.current = null;
        isDrawingRef.current = false;
      }
    };

    // ── MOVE handler: update draft preview + forward to chart for crosshair ──
    const onMove = (e: PointerEvent) => {
      // Always forward to LWC so the chart crosshair tracks the mouse
      forwardCrosshair(e, el);

      const dr = draftRef.current;
      if (!dr) return;
      const p = clientToPointRef.current(e.clientX, e.clientY); if (!p) return;

      if (dr.tool === 'brush') {
        (dr.brushPoints ??= []).push(p);
        dr.p2 = p;
      } else if (phaseRef.current === 1) {
        dr.p2 = p;
        if (phase1PtsRef.current) phase1PtsRef.current.p2 = p;
      } else if (phaseRef.current === 2) {
        dr.p3 = p;
      } else {
        return;
      }
      scheduleRedrawRef.current();
    };

    // ── UP handler: only needed for brush (drag tool) ────────────────────────
    const onUp = (e: PointerEvent) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }

      const tool = activeToolRef.current;
      // Only brush commits on pointerup — all other tools commit on second click
      if (tool === 'brush' && draftRef.current?.brushPoints) {
        const pts = draftRef.current.brushPoints;
        if (pts.length >= 2) {
          const base: BaseDrawing = { id:uid(), color:DEFAULT_COLOR, lineWidth:1.5, tool:'brush' };
          const d: BrushDrawing = { ...base, tool:'brush', points:pts };
          const next = [...drawingsRef.current, d];
          drawingsRef.current = next; setDrawings(next);
          activeToolRef.current = 'crosshair'; setActiveToolState('crosshair');
          notifyRef.current({ activeTool: 'crosshair', drawingCount: next.length, canUndo: true });
        }
        draftRef.current = null; isDrawingRef.current = false;
        redrawRef.current();
      }
    };

    // ── CANCEL handler: full cleanup ─────────────────────────────────────────
    const onCancel = (e: PointerEvent) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      draftRef.current = null;
      isDrawingRef.current = false;
      phaseRef.current = 0;
      phase1PtsRef.current = null;
      redrawRef.current();
    };

    // ── KEYBOARD: Escape cancels in-progress drawing ─────────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (phaseRef.current > 0 || isDrawingRef.current)) {
        draftRef.current = null;
        isDrawingRef.current = false;
        phaseRef.current = 0;
        phase1PtsRef.current = null;
        // Revert to crosshair
        activeToolRef.current = 'crosshair'; setActiveToolState('crosshair');
        notifyRef.current({ activeTool: 'crosshair' });
        redrawRef.current();
      }
    };

    // ── Forward wheel for zoom ───────────────────────────────────────────────
    const onWheel = (e: WheelEvent) => {
      const wrapper = el.parentElement;
      if (!wrapper) return;
      const chartEl = wrapper.querySelector<HTMLElement>('[data-chart-container]') ?? wrapper.firstElementChild;
      if (chartEl && chartEl !== el) {
        chartEl.dispatchEvent(new WheelEvent(e.type, e));
      }
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup',   onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('wheel',        onWheel, { passive: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup',   onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('wheel',        onWheel);
      document.removeEventListener('keydown', onKeyDown);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isPassive = activeTool==='cursor' || activeTool==='crosshair';
  const cursorStyle = isPassive ? 'default' : activeTool==='measure'||activeTool==='daterange'||activeTool==='pricerange' ? 'cell' : activeTool==='text' ? 'text' : activeTool==='brush' ? 'cell' : 'crosshair';

  const undo = useCallback(() => {
    if (drawingsRef.current.length === 0) return;
    const next = drawingsRef.current.slice(0,-1);
    drawingsRef.current = next; setDrawings(next); notify({ activeTool: activeToolRef.current, drawingCount: next.length, canUndo: next.length > 0 }); redrawRef.current();
  }, [notify]);

  return {
    canvasRef, overlayRef,
    drawings, activeTool, setActiveTool,
    toolbarOpen, setToolbarOpen,
    isPassive, cursorStyle,
    clearAll: () => { drawingsRef.current=[]; draftRef.current=null; setDrawings([]); notify({ activeTool: activeToolRef.current, drawingCount: 0, canUndo: false }); redrawRef.current(); },
    undo,
    canUndo: drawings.length > 0,
    redraw, syncCanvas,
  };
}
