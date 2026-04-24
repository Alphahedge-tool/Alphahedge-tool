'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as am5 from '@amcharts/amcharts5';
import * as am5percent from '@amcharts/amcharts5/percent';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import type { NubraInstrument } from './useNubraInstruments';
import base from './MasterOptionChain.module.css';
import styles from './ExpiryOiOverview.module.css';

export interface ExpiryOiOverviewSide {
  oi: number;
  volume: number;
  oiChgPct: number;
  delta: number;
}

export interface ExpiryOiOverviewRow {
  strike: number;
  ce: ExpiryOiOverviewSide;
  pe: ExpiryOiOverviewSide;
}

export interface ExpiryOiOverviewChain {
  rows: ExpiryOiOverviewRow[];
  spot?: number;
  atm?: number;
}

interface ExpiryOiOverviewProps {
  expiries?: string[];
  chains?: Record<string, ExpiryOiOverviewChain | undefined>;
  initialSelectedExpiry?: string;
  initialSymbol?: string;
  nubraInstruments?: NubraInstrument[];
}

interface ExpiryAggregate {
  callOi: number;
  putOi: number;
  callOiChg: number;
  putOiChg: number;
  callVolume: number;
  putVolume: number;
  callDeltaOi: number;
  putDeltaOi: number;
}

interface SymbolResolution {
  nubraSym: string;
  exchange: string;
}

interface SummaryTrendPoint {
  ts: number;
  call: number;
  put: number;
}

const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

function getSymbols(instruments: NubraInstrument[]): string[] {
  const seen = new Set<string>();
  for (const instrument of instruments) {
    const sym = instrument.asset ?? instrument.nubra_name ?? '';
    const assetType = (instrument.asset_type ?? '').toUpperCase();
    if (!sym || (assetType !== 'INDEX_FO' && assetType !== 'STOCK_FO')) continue;
    seen.add(sym);
  }
  return [...seen].sort();
}

function fmtExpiry(expiry: string | null | undefined) {
  if (!expiry) return 'Select expiry';
  const str = String(expiry);
  if (!/^\d{8}$/.test(str)) return str;
  return new Date(`${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtOi(n: number) {
  if (!n) return '0';
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  return Math.round(n).toLocaleString('en-IN');
}

function fmtRatio(n: number) {
  if (!isFinite(n)) return '--';
  return n.toFixed(2);
}

function fmtSignedOi(n: number) {
  if (!isFinite(n) || n === 0) return '0';
  const sign = n > 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)}L`;
  return `${sign}${Math.round(abs).toLocaleString('en-IN')}`;
}

function fmtMetricCompact(n: number) {
  if (!n) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${abs.toFixed(0)}`;
  return abs.toFixed(2);
}

function nubraHeaders() {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  return {
    'x-session-token': sessionToken,
    'x-device-id': deviceId,
    'x-raw-cookie': rawCookie,
  };
}

function getSession() {
  return localStorage.getItem('nubra_session_token') ?? '';
}

function resolveNubra(sym: string, nubraInstruments: NubraInstrument[]): SymbolResolution {
  const upper = sym.toUpperCase();
  const found = nubraInstruments.find(i =>
    (i.option_type === 'CE' || i.option_type === 'PE') &&
    (i.asset?.toUpperCase() === upper || i.nubra_name?.toUpperCase() === upper || i.stock_name?.toUpperCase().startsWith(upper))
  );
  if (found?.asset) {
    return {
      nubraSym: found.asset,
      exchange: found.exchange ?? 'NSE',
    };
  }
  return { nubraSym: sym, exchange: 'NSE' };
}

async function fetchExpiries(sym: string, exchange: string): Promise<string[]> {
  const headers = nubraHeaders();
  if (!headers['x-session-token']) return [];
  const res = await fetch(`/api/nubra-refdata?asset=${encodeURIComponent(sym)}&exchange=${exchange}`, { headers });
  if (!res.ok) return [];
  const json = await res.json();
  const list: string[] = json?.expiries ?? [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return list.filter(exp => String(exp) >= today).sort();
}

function parseRestOption(opt: Record<string, number>) {
  const volume = opt.volume ?? opt.vol ?? opt.total_volume ?? 0;
  return {
    oi: opt.oi ?? 0,
    volume,
    oiChgPct: opt.prev_oi != null && (opt.oi ?? 0) > 0 ? (((opt.oi ?? 0) - opt.prev_oi) / (opt.oi ?? 0)) * 100 : 0,
    delta: opt.delta ?? 0,
  };
}

function buildChainSnapshot(
  ceList: Record<string, number>[],
  peList: Record<string, number>[],
  atmRaw: number,
  spotRaw: number,
): ExpiryOiOverviewChain {
  const scale = 100;
  const map = new Map<number, ExpiryOiOverviewRow>();

  for (const opt of ceList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) {
      map.set(strike, {
        strike,
        ce: { oi: 0, volume: 0, oiChgPct: 0, delta: 0 },
        pe: { oi: 0, volume: 0, oiChgPct: 0, delta: 0 },
      });
    }
    map.get(strike)!.ce = parseRestOption(opt);
  }

  for (const opt of peList) {
    const strike = (opt.sp ?? 0) / scale;
    if (!map.has(strike)) {
      map.set(strike, {
        strike,
        ce: { oi: 0, volume: 0, oiChgPct: 0, delta: 0 },
        pe: { oi: 0, volume: 0, oiChgPct: 0, delta: 0 },
      });
    }
    map.get(strike)!.pe = parseRestOption(opt);
  }

  return {
    rows: [...map.values()].sort((a, b) => a.strike - b.strike),
    spot: spotRaw / scale,
    atm: atmRaw > 0 ? atmRaw / scale : spotRaw / scale,
  };
}

async function fetchOptionChainSnapshot(session: string, sym: string, exchange: string, expiry: string): Promise<ExpiryOiOverviewChain> {
  const url = `/api/nubra-optionchain?session_token=${encodeURIComponent(session)}&instrument=${encodeURIComponent(sym)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load option chain (${res.status})`);
  const json = await res.json();
  const chain = json.chain ?? json;
  return buildChainSnapshot(chain.ce ?? [], chain.pe ?? [], chain.atm ?? 0, chain.cp ?? chain.current_price ?? 0);
}

function normalizeSummaryTrendHistory(points: SummaryTrendPoint[], maxPoints = 480): SummaryTrendPoint[] {
  if (points.length <= 1) return points;
  const sorted = [...points]
    .filter(point => isWithinMarketSession(point.ts))
    .sort((a, b) => a.ts - b.ts);
  const deduped: SummaryTrendPoint[] = [];
  for (const point of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && last.ts === point.ts) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  if (deduped.length <= maxPoints) return deduped;
  const step = Math.ceil(deduped.length / maxPoints);
  return deduped.filter((_, index) => index % step === 0 || index === deduped.length - 1);
}

function getIstSessionMinute(ts: number) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function isWithinMarketSession(ts: number) {
  const minute = getIstSessionMinute(ts);
  return minute >= MARKET_OPEN_MIN && minute <= MARKET_CLOSE_MIN;
}

function getSessionEndIso(date: string, now = new Date()) {
  const closeIso = istToUtcIso(date, '15:30');
  const closeMs = new Date(closeIso).getTime();
  return now.getTime() < closeMs ? now.toISOString() : closeIso;
}

function resolveIntradayTradingDate(now = new Date()) {
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const yyyy = istNow.getFullYear();
  const mm = String(istNow.getMonth() + 1).padStart(2, '0');
  const dd = String(istNow.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function istToUtcIso(date: string, hhmm: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const msUtc = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0, 0);
  return new Date(msUtc).toISOString();
}

function buildNubraChainValue(symbol: string, expiry: string) {
  return `${symbol}_${expiry}`;
}

async function fetchNubraChainOiHistory(
  exchange: string,
  chainValues: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, SummaryTrendPoint[]>> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken || chainValues.length === 0) return {};

  const res = await fetch('/api/nubra-timeseries', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chart: 'Put_Call_Ratio',
      query: [
        {
          exchange,
          type: 'CHAIN',
          values: chainValues,
          fields: ['cumulative_call_oi', 'cumulative_put_oi'],
          startDate,
          endDate,
          interval: '1m',
          intraDay: false,
          realTime: false,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`nubra-timeseries ${res.status}`);

  const json = await res.json();
  const out: Record<string, SummaryTrendPoint[]> = {};

  for (const chainValue of chainValues) out[chainValue] = [];

  for (const entry of json?.result ?? []) {
    for (const valObj of entry?.values ?? []) {
      for (const chainValue of chainValues) {
        const chainData = valObj?.[chainValue];
        if (!chainData) continue;
        const callOi: Array<{ ts: number; v: number }> = chainData.cumulative_call_oi ?? [];
        const putOi: Array<{ ts: number; v: number }> = chainData.cumulative_put_oi ?? [];
        const bucket = new Map<number, SummaryTrendPoint>();

        for (const point of callOi) {
          const ts = Math.floor((point.ts ?? 0) / 1e9) * 1000;
          const row = bucket.get(ts) ?? { ts, call: 0, put: 0 };
          row.call = Number(point.v ?? 0);
          bucket.set(ts, row);
        }
        for (const point of putOi) {
          const ts = Math.floor((point.ts ?? 0) / 1e9) * 1000;
          const row = bucket.get(ts) ?? { ts, call: 0, put: 0 };
          row.put = Number(point.v ?? 0);
          bucket.set(ts, row);
        }

        out[chainValue] = normalizeSummaryTrendHistory([...bucket.values()].sort((a, b) => a.ts - b.ts));
      }
    }
  }

  return out;
}

function appendSummaryTrendPoint(
  prev: SummaryTrendPoint[],
  callValue: number,
  putValue: number,
  maxPoints = 480,
): SummaryTrendPoint[] {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  if (!isWithinMarketSession(ts)) return normalizeSummaryTrendHistory(prev, maxPoints);
  const next = normalizeSummaryTrendHistory(prev, maxPoints);
  const last = next[next.length - 1];
  if (last && last.ts === ts) {
    next[next.length - 1] = { ts, call: callValue, put: putValue };
  } else {
    next.push({ ts, call: callValue, put: putValue });
  }
  return normalizeSummaryTrendHistory(next, maxPoints);
}

function buildSummaryChangeHistory(points: SummaryTrendPoint[]): SummaryTrendPoint[] {
  if (points.length === 0) return [];
  const basePoint = points[0];
  return normalizeSummaryTrendHistory(points.map(point => ({
    ts: point.ts,
    call: point.call - basePoint.call,
    put: point.put - basePoint.put,
  })));
}

function sameExpirySelection(setA: Set<string>, values: string[]) {
  if (setA.size !== values.length) return false;
  return values.every(value => setA.has(value));
}

function formatSummaryTrendTimestamp(tsSec: number | null) {
  if (!tsSec) return '--';
  return new Date(tsSec * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toSummaryTrendTsSec(value: Time | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'year' in value && 'month' in value && 'day' in value) {
    return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 1000);
  }
  return null;
}

function aggregateExpiry(chain?: ExpiryOiOverviewChain): ExpiryAggregate {
  const empty: ExpiryAggregate = {
    callOi: 0,
    putOi: 0,
    callOiChg: 0,
    putOiChg: 0,
    callVolume: 0,
    putVolume: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
  };
  if (!chain) return empty;

  return chain.rows.reduce<ExpiryAggregate>((acc, row) => {
    const ceOi = row.ce.oi || 0;
    const peOi = row.pe.oi || 0;
    acc.callOi += ceOi;
    acc.putOi += peOi;
    acc.callOiChg += ceOi * ((row.ce.oiChgPct || 0) / 100);
    acc.putOiChg += peOi * ((row.pe.oiChgPct || 0) / 100);
    acc.callVolume += row.ce.volume || 0;
    acc.putVolume += row.pe.volume || 0;
    acc.callDeltaOi += Math.abs((row.ce.delta || 0) * ceOi);
    acc.putDeltaOi += Math.abs((row.pe.delta || 0) * peOi);
    return acc;
  }, empty);
}

function aggregateTrendHistories(histories: SummaryTrendPoint[][]): SummaryTrendPoint[] {
  const bucket = new Map<number, SummaryTrendPoint>();
  for (const history of histories) {
    for (const point of history) {
      const row = bucket.get(point.ts) ?? { ts: point.ts, call: 0, put: 0 };
      row.call += point.call;
      row.put += point.put;
      bucket.set(point.ts, row);
    }
  }
  return normalizeSummaryTrendHistory([...bucket.values()].sort((a, b) => a.ts - b.ts));
}

function MetricPie({
  callValue,
  putValue,
  size = 96,
  centerValue,
  centerLabel,
}: {
  callValue: number;
  putValue: number;
  size?: number;
  centerValue?: string;
  centerLabel?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = am5.Root.new(host);
    const chart = root.container.children.push(
      am5percent.PieChart.new(root, {
        layout: root.verticalLayout,
        innerRadius: am5.percent(68),
        startAngle: -90,
        endAngle: 270,
      }),
    );
    const series = chart.series.push(
      am5percent.PieSeries.new(root, {
        valueField: 'value',
        categoryField: 'category',
        alignLabels: false,
        startAngle: -90,
        endAngle: 270,
      }),
    );

    series.slices.template.setAll({
      strokeOpacity: 0,
      cornerRadius: 6,
      shadowColor: am5.color(0x000000),
      shadowBlur: 10,
      shadowOffsetX: 0,
      shadowOffsetY: 2,
      shadowOpacity: 0.18,
    });
    series.slices.template.adapters.add('fill', (_, target) => (
      (target.dataItem?.dataContext as { color?: am5.Color } | undefined)?.color ?? am5.color(0x516079)
    ));
    series.slices.template.adapters.add('stroke', (_, target) => (
      (target.dataItem?.dataContext as { color?: am5.Color } | undefined)?.color ?? am5.color(0x516079)
    ));
    series.labels.template.setAll({ forceHidden: true });
    series.ticks.template.setAll({ forceHidden: true });

    series.data.setAll([
      { category: 'Call', value: Math.max(callValue, 0), color: am5.color(0x1fe0af) },
      { category: 'Put', value: Math.max(putValue, 0), color: am5.color(0xff6f91) },
    ]);

    return () => root.dispose();
  }, [callValue, putValue]);

  return (
    <div className={styles.metricPieShell} style={{ width: size, height: size }}>
      <div ref={hostRef} className={base.summaryPieHost} style={{ width: size, height: size }} aria-hidden="true" />
      {(centerValue || centerLabel) && (
        <div className={styles.metricPieCenter}>
          {centerLabel ? <span className={styles.metricPieCenterLabel}>{centerLabel}</span> : null}
          {centerValue ? <strong className={styles.metricPieCenterValue}>{centerValue}</strong> : null}
        </div>
      )}
    </div>
  );
}

function CompactMetricPie({
  callValue,
  putValue,
  size = 72,
  centerValue,
  centerLabel,
}: {
  callValue: number;
  putValue: number;
  size?: number;
  centerValue?: string;
  centerLabel?: string;
}) {
  const total = Math.max(callValue, 0) + Math.max(putValue, 0);
  const callPct = total > 0 ? (Math.max(callValue, 0) / total) * 100 : 50;
  const pieBg = `conic-gradient(#1fe0af 0 ${callPct}%, #ff6f91 ${callPct}% 100%)`;

  return (
    <div className={styles.metricPieShell} style={{ width: size, height: size }}>
      <div className={styles.compactMetricPie} style={{ width: size, height: size, background: pieBg }} aria-hidden="true" />
      {(centerValue || centerLabel) && (
        <div className={styles.metricPieCenter}>
          {centerLabel ? <span className={styles.metricPieCenterLabel}>{centerLabel}</span> : null}
          {centerValue ? <strong className={styles.metricPieCenterValue}>{centerValue}</strong> : null}
        </div>
      )}
    </div>
  );
}

function ExpiryTotalOiCard({
  expiry,
  title,
  subtitle,
  aggregate,
  active,
  onClick,
}: {
  expiry: string;
  title?: string;
  subtitle?: string;
  aggregate: ExpiryAggregate;
  active: boolean;
  onClick: () => void;
}) {
  const total = aggregate.callOi + aggregate.putOi;
  const pcr = aggregate.callOi > 0 ? aggregate.putOi / aggregate.callOi : 0;
  const totalLabel = fmtOi(total);
  const centerScale = totalLabel.length > 10 ? 0.72 : totalLabel.length > 8 ? 0.82 : totalLabel.length > 6 ? 0.92 : 1;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.topCardButton} ${active ? styles.topCardButtonActive : ''}`}
    >
      <article className={base.summaryCard}>
        <div className={base.summaryCardTop}>
          <div>
            <div className={base.summaryCardTitle}>{title ?? fmtExpiry(expiry)}</div>
            <div className={base.summaryCardSubtitle}>{subtitle ?? 'Total OI for this expiry'}</div>
          </div>
          <div className={base.summaryPcrChip}>PCR {fmtRatio(pcr)}</div>
        </div>

        <div className={base.summaryCardBody}>
          <div className={base.summaryDonutWrap}>
            <MetricPie callValue={aggregate.callOi} putValue={aggregate.putOi} />
            <div className={base.summaryDonutCenter}>
              <span className={base.summaryDonutCenterLabel}>Total</span>
              <strong className={base.summaryDonutCenterValue} style={{ transform: `scale(${centerScale})` }}>
                {totalLabel}
              </strong>
            </div>
          </div>

          <div className={base.summaryLegend}>
            <div className={base.summaryLegendItem}>
              <span className={`${base.summaryLegendDot} ${base.summaryLegendDotCall}`} />
              <div>
                <div className={base.summaryLegendLabel}>Call</div>
                <div className={base.summaryLegendValue}>{fmtOi(aggregate.callOi)}</div>
              </div>
            </div>
            <div className={base.summaryLegendItem}>
              <span className={`${base.summaryLegendDot} ${base.summaryLegendDotPut}`} />
              <div>
                <div className={base.summaryLegendLabel}>Put</div>
                <div className={base.summaryLegendValue}>{fmtOi(aggregate.putOi)}</div>
              </div>
            </div>
          </div>
        </div>
      </article>
    </button>
  );
}

function DetailMetricCard({
  title,
  subtitle,
  callValue,
  putValue,
  totalValue,
  pcr,
  formatter,
  className,
}: {
  title: string;
  subtitle: string;
  callValue: number;
  putValue: number;
  totalValue: string;
  pcr: number;
  formatter: (value: number) => string;
  className?: string;
}) {
  return (
    <article className={`${base.summaryCard} ${base.summaryCardCompact} ${className ?? ''}`}>
      <div className={base.summaryCardCompactHeader}>
        <div>
          <div className={base.summaryCardTitle}>{title}</div>
          <div className={base.summaryCardSubtitle}>{subtitle}</div>
        </div>
        <span className={base.summaryPcrChipSm}>PCR {fmtRatio(pcr)}</span>
      </div>
      <div className={styles.detailMetricBody}>
        <div className={styles.detailMetricPieWrap}>
          <CompactMetricPie callValue={callValue} putValue={putValue} size={72} centerLabel="Total" centerValue={totalValue} />
        </div>
        <div className={base.summaryCardCompactBody}>
          <div className={base.summaryCompactRow}>
            <span className={`${base.summaryLegendDot} ${base.summaryLegendDotCall}`} />
            <span className={base.summaryCompactLabel}>CE</span>
            <span className={base.summaryCompactValue}>{formatter(callValue)}</span>
          </div>
          <div className={base.summaryCompactRow}>
            <span className={`${base.summaryLegendDot} ${base.summaryLegendDotPut}`} />
            <span className={base.summaryCompactLabel}>PE</span>
            <span className={base.summaryCompactValue}>{formatter(putValue)}</span>
          </div>
          <div className={base.summaryCompactTotal}>
            <span className={base.summaryCompactTotalLabel}>Total</span>
            <span className={base.summaryCompactTotalValue}>{totalValue}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function OverviewMetricCard({
  title,
  subtitle,
  callValue,
  putValue,
  totalValue,
  pcr,
  formatter,
  trendHistory,
  trendChgHistory,
  callChgValue = 0,
  putChgValue = 0,
  defaultShowChg = false,
  className,
}: {
  title: string;
  subtitle: string;
  callValue: number;
  putValue: number;
  totalValue: string;
  pcr: number;
  formatter: (value: number) => string;
  trendHistory?: SummaryTrendPoint[];
  trendChgHistory?: SummaryTrendPoint[];
  callChgValue?: number;
  putChgValue?: number;
  defaultShowChg?: boolean;
  className?: string;
}) {
  const centerScale = totalValue.length > 10 ? 0.72 : totalValue.length > 8 ? 0.82 : totalValue.length > 6 ? 0.92 : 1;

  return (
    <article className={`${base.summaryCard} ${className ?? ''}`}>
      <div className={base.summaryCardTop}>
        <div>
          <div className={base.summaryCardTitle}>{title}</div>
          <div className={base.summaryCardSubtitle}>{subtitle}</div>
        </div>
        <div className={base.summaryPcrChip}>PCR {fmtRatio(pcr)}</div>
      </div>

      <div className={`${base.summaryCardBody} ${trendHistory ? base.summaryCardBodyWithTrend : ''}`}>
        <div className={base.summaryDonutWrap}>
          <MetricPie callValue={callValue} putValue={putValue} />
          <div className={base.summaryDonutCenter}>
            <span className={base.summaryDonutCenterLabel}>Total</span>
            <strong className={base.summaryDonutCenterValue} style={{ transform: `scale(${centerScale})` }}>
              {totalValue}
            </strong>
          </div>
        </div>

        <div className={base.summaryLegend}>
          <div className={base.summaryLegendItem}>
            <span className={`${base.summaryLegendDot} ${base.summaryLegendDotCall}`} />
            <div>
              <div className={base.summaryLegendLabel}>Call</div>
              <div className={base.summaryLegendValue}>{formatter(callValue)}</div>
            </div>
          </div>
          <div className={base.summaryLegendItem}>
            <span className={`${base.summaryLegendDot} ${base.summaryLegendDotPut}`} />
            <div>
              <div className={base.summaryLegendLabel}>Put</div>
              <div className={base.summaryLegendValue}>{formatter(putValue)}</div>
            </div>
          </div>
        </div>

        {trendHistory && (
          <ExpiryTrendChart
            callValue={callValue}
            putValue={putValue}
            callChgValue={callChgValue}
            putChgValue={putChgValue}
            initialHistory={trendHistory}
            initialChgHistory={trendChgHistory}
            defaultShowChg={defaultShowChg}
          />
        )}
      </div>
    </article>
  );
}

function ExpiryTrendChart({
  callValue,
  putValue,
  callChgValue,
  putChgValue,
  initialHistory,
  initialChgHistory,
  defaultShowChg = false,
}: {
  callValue: number;
  putValue: number;
  callChgValue: number;
  putChgValue: number;
  initialHistory?: SummaryTrendPoint[];
  initialChgHistory?: SummaryTrendPoint[];
  defaultShowChg?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const callSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const putSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const initialFitDoneRef = useRef(false);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const hoveredTimeRef = useRef<number | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const [showChg, setShowChg] = useState(defaultShowChg);
  const [history, setHistory] = useState<SummaryTrendPoint[]>(
    initialHistory && initialHistory.length > 0
      ? appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialHistory), callValue, putValue)
      : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }],
  );
  const [chgHistory, setChgHistory] = useState<SummaryTrendPoint[]>(
    initialChgHistory && initialChgHistory.length > 0
      ? appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialChgHistory), callChgValue, putChgValue)
      : buildSummaryChangeHistory(
          initialHistory && initialHistory.length > 0
            ? appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialHistory), callValue, putValue)
            : [{ ts: Math.floor(Date.now() / 60000) * 60000, call: 0, put: 0 }],
        ),
  );

  useEffect(() => {
    setShowChg(defaultShowChg);
  }, [defaultShowChg]);

  useEffect(() => {
    if (initialHistory && initialHistory.length > 0) {
      setHistory(appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialHistory), callValue, putValue));
      initialFitDoneRef.current = false;
      return;
    }
    setHistory([{ ts: Math.floor(Date.now() / 60000) * 60000, call: callValue, put: putValue }]);
  }, [initialHistory, callValue, putValue]);

  useEffect(() => {
    if (initialChgHistory && initialChgHistory.length > 0) {
      setChgHistory(appendSummaryTrendPoint(normalizeSummaryTrendHistory(initialChgHistory), callChgValue, putChgValue));
      initialFitDoneRef.current = false;
      return;
    }
    setChgHistory(buildSummaryChangeHistory(history));
  }, [initialChgHistory, callChgValue, putChgValue, history]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const pushHoveredTime = (nextTime: number | null) => {
      if (hoveredTimeRef.current === nextTime) return;
      hoveredTimeRef.current = nextTime;
      if (hoverRafRef.current != null) cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = requestAnimationFrame(() => {
        setHoveredTime(nextTime);
        hoverRafRef.current = null;
      });
    };

    const chart = createChart(host, {
      width: Math.max(host.clientWidth, 120),
      height: 96,
      layout: {
        background: { color: 'transparent' },
        textColor: '#90a7cb',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.1)' },
      },
      rightPriceScale: { visible: false, borderVisible: false },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: {
        visible: false,
        borderVisible: false,
        secondsVisible: false,
        timeVisible: true,
        rightOffset: 1,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        vertLine: { visible: true, labelVisible: false, color: 'rgba(214, 226, 255, 0.42)', width: 1, style: 2 },
        horzLine: { visible: true, labelVisible: false, color: 'rgba(214, 226, 255, 0.22)', width: 1, style: 2 },
      },
      handleScroll: false,
      handleScale: false,
    });

    const callSeries = chart.addSeries(LineSeries, {
      color: '#1fe0af',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#10251e',
      crosshairMarkerBackgroundColor: '#1fe0af',
    });
    const putSeries = chart.addSeries(LineSeries, {
      color: '#ff6f91',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#2b1420',
      crosshairMarkerBackgroundColor: '#ff6f91',
    });

    chartRef.current = chart;
    callSeriesRef.current = callSeries;
    putSeriesRef.current = putSeries;

    chart.subscribeCrosshairMove(param => {
      const directTime = toSummaryTrendTsSec(param.time);
      if (directTime != null) {
        pushHoveredTime(directTime);
        return;
      }
      if (param.point) {
        const coordinateTime = toSummaryTrendTsSec(chart.timeScale().coordinateToTime(param.point.x));
        if (coordinateTime != null) {
          pushHoveredTime(coordinateTime);
          return;
        }
      }
      pushHoveredTime(null);
    });

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      chart.applyOptions({ width: Math.max(Math.floor(entry.contentRect.width), 120) });
    });
    resizeObserver.observe(host);

    return () => {
      if (hoverRafRef.current != null) cancelAnimationFrame(hoverRafRef.current);
      resizeObserver.disconnect();
      callSeriesRef.current = null;
      putSeriesRef.current = null;
      initialFitDoneRef.current = false;
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  const normalizedHistory = useMemo(() => normalizeSummaryTrendHistory(history), [history]);
  const normalizedChgHistory = useMemo(() => normalizeSummaryTrendHistory(chgHistory), [chgHistory]);
  const activeHistory = showChg ? normalizedChgHistory : normalizedHistory;

  const chartData = useMemo(() => ({
    call: activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.call })),
    put: activeHistory.map(p => ({ time: Math.floor(p.ts / 1000) as Time, value: p.put })),
  }), [activeHistory]);

  const displayPoint = useMemo(() => {
    if (activeHistory.length === 0) return null;
    if (hoveredTime != null) {
      const hoveredMs = hoveredTime * 1000;
      for (let idx = activeHistory.length - 1; idx >= 0; idx -= 1) {
        if (activeHistory[idx].ts <= hoveredMs) return activeHistory[idx];
      }
    }
    return activeHistory[activeHistory.length - 1];
  }, [activeHistory, hoveredTime]);

  const displayTime = displayPoint ? Math.floor(displayPoint.ts / 1000) : null;
  const prevShowChgRef = useRef(showChg);

  useEffect(() => {
    callSeriesRef.current?.setData(chartData.call);
    putSeriesRef.current?.setData(chartData.put);
    const modeChanged = prevShowChgRef.current !== showChg;
    prevShowChgRef.current = showChg;
    if (!initialFitDoneRef.current || modeChanged) {
      if (chartData.call.length > 0 || chartData.put.length > 0) {
        chartRef.current?.timeScale().fitContent();
        initialFitDoneRef.current = true;
      }
    }
  }, [chartData, showChg]);

  const fmtChg = (v: number) => fmtSignedOi(v);

  return (
    <div className={base.summaryTrendInline}>
      <div className={base.summaryTrendChartWrap}>
        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 2, display: 'flex', gap: 2, background: 'rgba(0,0,0,0.45)', borderRadius: 5, padding: '2px 3px' }}>
          <button
            type="button"
            onClick={() => setShowChg(false)}
            style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: !showChg ? '#2563eb' : 'transparent', color: !showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}
          >OI</button>
          <button
            type="button"
            onClick={() => setShowChg(true)}
            style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: showChg ? '#2563eb' : 'transparent', color: showChg ? '#fff' : '#6b7280', letterSpacing: '0.04em' }}
          >CHG</button>
        </div>
        <div ref={hostRef} className={base.summaryTrendChart} aria-hidden="true" />
      </div>
      <div className={base.summaryTrendInlineMeta}>
        <span className={base.summaryTrendCaption}>{showChg ? 'OI change' : (history.length > 2 ? 'Session trend' : 'Live trend')}</span>
        <span className={base.summaryTrendTime}>{formatSummaryTrendTimestamp(displayTime)}</span>
        <span className={base.summaryTrendLive}>{hoveredTime != null ? 'INSPECT' : 'LIVE'}</span>
      </div>
      <div className={base.summaryTrendValues}>
        {showChg ? (
          <>
            <span className={`${base.summaryTrendValuePill} ${base.summaryTrendValueCall}`}>CE {fmtChg(displayPoint?.call ?? callChgValue)}</span>
            <span className={`${base.summaryTrendValuePill} ${base.summaryTrendValuePut}`}>PE {fmtChg(displayPoint?.put ?? putChgValue)}</span>
            {(() => {
              const c = displayPoint?.call ?? callChgValue;
              const p = displayPoint?.put ?? putChgValue;
              const chgPcr = c !== 0 ? p / c : null;
              return chgPcr != null ? (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                  PCR {fmtRatio(chgPcr)}
                </span>
              ) : null;
            })()}
          </>
        ) : (
          <>
            <span className={`${base.summaryTrendValuePill} ${base.summaryTrendValueCall}`}>CE {fmtOi(displayPoint?.call ?? callValue)}</span>
            <span className={`${base.summaryTrendValuePill} ${base.summaryTrendValuePut}`}>PE {fmtOi(displayPoint?.put ?? putValue)}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function ExpiryOiOverview({
  expiries: externalExpiries = [],
  chains: externalChains = {},
  initialSelectedExpiry,
  initialSymbol = 'NIFTY',
  nubraInstruments = [],
}: ExpiryOiOverviewProps) {
  const symbols = useMemo(() => getSymbols(nubraInstruments), [nubraInstruments]);
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol);
  const [selectedExpiries, setSelectedExpiries] = useState<Set<string>>(
    () => new Set(initialSelectedExpiry ? [initialSelectedExpiry] : []),
  );
  const [expiryDropOpen, setExpiryDropOpen] = useState(false);
  const expiryDropRef = useRef<HTMLDivElement | null>(null);
  const [loadedExpiries, setLoadedExpiries] = useState<string[]>([]);
  const [loadedChains, setLoadedChains] = useState<Record<string, ExpiryOiOverviewChain | undefined>>({});
  const [trendHistory, setTrendHistory] = useState<Record<string, SummaryTrendPoint[]>>({});
  const effectiveExpiries = externalExpiries.length > 0 ? externalExpiries : loadedExpiries;
  const effectiveChains = Object.keys(externalChains).length > 0 ? externalChains : loadedChains;
  const topExpiries = useMemo(() => {
    const available = effectiveExpiries.filter(Boolean);
    if (selectedExpiries.size === 0) return available.slice(0, 3);
    return available.filter(expiry => selectedExpiries.has(expiry)).slice(0, 3);
  }, [effectiveExpiries, selectedExpiries]);

  useEffect(() => {
    if (!symbols.length) return;
    if (!symbols.includes(selectedSymbol)) {
      setSelectedSymbol(symbols.includes(initialSymbol) ? initialSymbol : symbols[0]);
    }
  }, [symbols, selectedSymbol, initialSymbol]);

  useEffect(() => {
    if (!expiryDropOpen) return;
    const handler = (event: MouseEvent) => {
      if (expiryDropRef.current && !expiryDropRef.current.contains(event.target as Node)) {
        setExpiryDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expiryDropOpen]);

  useEffect(() => {
    if (externalExpiries.length > 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isMarketOpen = () => {
      const now = new Date();
      const istMin = ((now.getUTCHours() * 60 + now.getUTCMinutes()) + 330) % 1440;
      const istDay = new Date(now.getTime() + 330 * 60000);
      if ([0, 6].includes(istDay.getUTCDay())) return false;
      return istMin >= 9 * 60 + 15 && istMin < 15 * 60 + 30;
    };

    const load = async () => {
      const session = getSession();
      if (!session || !selectedSymbol || nubraInstruments.length === 0) {
        if (!cancelled) {
          setLoadedExpiries([]);
          setLoadedChains({});
        }
        return;
      }

      const resolved = resolveNubra(selectedSymbol, nubraInstruments);
      const expiries = await fetchExpiries(resolved.nubraSym, resolved.exchange);
      if (cancelled) return;
      setLoadedExpiries(expiries);
      setSelectedExpiries(prev => {
        const preserved = expiries.filter(expiry => prev.has(expiry)).slice(0, 3);
        const nextValues = preserved.length > 0
          ? preserved
          : initialSelectedExpiry && expiries.includes(initialSelectedExpiry)
            ? [initialSelectedExpiry]
            : expiries.slice(0, 3);
        return sameExpirySelection(prev, nextValues) ? prev : new Set(nextValues);
      });

      const picked = expiries.filter(expiry => selectedExpiries.has(expiry)).slice(0, 3);
      const topThree = picked.length > 0 ? picked : expiries.slice(0, 3);

      if (topThree.length === 0) {
        setLoadedChains({});
        return;
      }

      try {
        const entries = await Promise.all(
          topThree.map(async expiry => [expiry, await fetchOptionChainSnapshot(session, resolved.nubraSym, resolved.exchange, expiry)] as const),
        );
        if (!cancelled) setLoadedChains(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setLoadedChains({});
      } finally {
        if (!cancelled && externalExpiries.length === 0) {
          timer = setTimeout(load, isMarketOpen() ? 15_000 : 60_000);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [externalExpiries.length, initialSelectedExpiry, nubraInstruments, selectedExpiries, selectedSymbol]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loadHistory = async () => {
      if (!selectedSymbol || nubraInstruments.length === 0 || topExpiries.length === 0) {
        if (!cancelled) setTrendHistory({});
        return;
      }

      const resolved = resolveNubra(selectedSymbol, nubraInstruments);
      const tradingDate = resolveIntradayTradingDate();
      const startDate = istToUtcIso(tradingDate, '09:15');
      const endDate = getSessionEndIso(tradingDate);
      const chainValues = topExpiries.map(expiry => buildNubraChainValue(resolved.nubraSym, expiry));

      try {
        const result = await fetchNubraChainOiHistory(resolved.exchange, chainValues, startDate, endDate);
        if (cancelled) return;
        const next: Record<string, SummaryTrendPoint[]> = {};
        for (const expiry of topExpiries) {
          next[expiry] = result[buildNubraChainValue(resolved.nubraSym, expiry)] ?? [];
        }
        setTrendHistory(next);
      } catch {
        if (!cancelled) setTrendHistory(prev => prev);
      } finally {
        if (!cancelled) timer = setTimeout(loadHistory, 15_000);
      }
    };

    loadHistory();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nubraInstruments, selectedSymbol, topExpiries]);

  const aggregates = useMemo(
    () => Object.fromEntries(effectiveExpiries.map(expiry => [expiry, aggregateExpiry(effectiveChains[expiry])])),
    [effectiveChains, effectiveExpiries],
  );
  const combinedAggregate = useMemo<ExpiryAggregate>(() => {
    return topExpiries.reduce<ExpiryAggregate>((acc, expiry) => {
      const item = aggregates[expiry] ?? aggregateExpiry(undefined);
      acc.callOi += item.callOi;
      acc.putOi += item.putOi;
      acc.callOiChg += item.callOiChg;
      acc.putOiChg += item.putOiChg;
      acc.callVolume += item.callVolume;
      acc.putVolume += item.putVolume;
      acc.callDeltaOi += item.callDeltaOi;
      acc.putDeltaOi += item.putDeltaOi;
      return acc;
    }, {
      callOi: 0,
      putOi: 0,
      callOiChg: 0,
      putOiChg: 0,
      callVolume: 0,
      putVolume: 0,
      callDeltaOi: 0,
      putDeltaOi: 0,
    });
  }, [aggregates, topExpiries]);
  const combinedTrendHistory = useMemo(
    () => aggregateTrendHistories(topExpiries.map(expiry => trendHistory[expiry] ?? [])),
    [topExpiries, trendHistory],
  );
  const combinedTrendChgHistory = useMemo(
    () => buildSummaryChangeHistory(combinedTrendHistory),
    [combinedTrendHistory],
  );

  if (effectiveExpiries.length === 0) {
    return <div className={styles.emptyState}>No expiries available right now.</div>;
  }

  return (
    <section className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarControls}>
          <div className={styles.compactField}>
            <span className={styles.compactLabel}>Symbol</span>
            <select
              className={styles.compactSelect}
              value={selectedSymbol}
              onChange={event => setSelectedSymbol(event.target.value)}
              disabled={symbols.length === 0}
            >
              {symbols.length === 0 && <option value="">Select</option>}
              {symbols.map(symbol => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </div>

          <div ref={expiryDropRef} className={styles.expiryDropdownWrap}>
            <button
              type="button"
              className={styles.expiryDropdownBtn}
              disabled={effectiveExpiries.length === 0}
              onClick={() => setExpiryDropOpen(open => !open)}
            >
              <span className={styles.compactLabel}>Expiries</span>
              <span className={styles.expiryDropdownValue}>
                {topExpiries.length === 0 ? 'Select' : topExpiries.length === 1 ? fmtExpiry(topExpiries[0]) : `${topExpiries.length} selected`}
              </span>
              <span className={styles.expiryDropdownCaret}>▼</span>
            </button>

            {expiryDropOpen && effectiveExpiries.length > 0 && (
              <div className={styles.expiryDropdownMenu}>
                {effectiveExpiries.map(expiry => {
                  const checked = selectedExpiries.has(expiry);
                  const disabled = !checked && selectedExpiries.size >= 3;
                  return (
                    <label key={expiry} className={`${styles.expiryDropdownItem} ${checked ? styles.expiryDropdownItemActive : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => {
                          setSelectedExpiries(prev => {
                            const next = new Set(prev);
                            if (next.has(expiry)) next.delete(expiry);
                            else if (next.size < 3) next.add(expiry);
                            return next;
                          });
                        }}
                      />
                      <span>{fmtExpiry(expiry)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.topGrid}>
        <OverviewMetricCard
          className={styles.prominentCard}
          title="Total OI"
          subtitle="Combined CE vs PE OI across top 3 expiries"
          callValue={combinedAggregate.callOi}
          putValue={combinedAggregate.putOi}
          callChgValue={combinedAggregate.callOiChg}
          putChgValue={combinedAggregate.putOiChg}
          totalValue={fmtOi(combinedAggregate.callOi + combinedAggregate.putOi)}
          pcr={combinedAggregate.callOi > 0 ? combinedAggregate.putOi / combinedAggregate.callOi : 0}
          formatter={fmtOi}
          trendHistory={combinedTrendHistory}
          trendChgHistory={combinedTrendChgHistory}
        />
        <OverviewMetricCard
          className={styles.prominentCard}
          title="OI Change"
          subtitle="Approx change from previous OI across top 3 expiries"
          callValue={combinedAggregate.callOiChg}
          putValue={combinedAggregate.putOiChg}
          totalValue={fmtSignedOi(combinedAggregate.callOiChg + combinedAggregate.putOiChg)}
          pcr={combinedAggregate.callOiChg !== 0 ? combinedAggregate.putOiChg / combinedAggregate.callOiChg : 0}
          formatter={fmtSignedOi}
          trendHistory={combinedTrendHistory}
          trendChgHistory={combinedTrendChgHistory}
          callChgValue={combinedAggregate.callOiChg}
          putChgValue={combinedAggregate.putOiChg}
          defaultShowChg
        />
        <OverviewMetricCard
          className={styles.prominentCard}
          title="Delta OI"
          subtitle="Absolute delta exposure across top 3 expiries"
          callValue={combinedAggregate.callDeltaOi}
          putValue={combinedAggregate.putDeltaOi}
          totalValue={fmtMetricCompact(combinedAggregate.callDeltaOi + combinedAggregate.putDeltaOi)}
          pcr={combinedAggregate.callDeltaOi > 0 ? combinedAggregate.putDeltaOi / combinedAggregate.callDeltaOi : 0}
          formatter={fmtMetricCompact}
        />
        <OverviewMetricCard
          className={styles.prominentCard}
          title="Volume"
          subtitle="Traded volume across top 3 expiries"
          callValue={combinedAggregate.callVolume}
          putValue={combinedAggregate.putVolume}
          totalValue={fmtOi(combinedAggregate.callVolume + combinedAggregate.putVolume)}
          pcr={combinedAggregate.callVolume > 0 ? combinedAggregate.putVolume / combinedAggregate.callVolume : 0}
          formatter={fmtOi}
        />
      </div>

      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTitle}>Single Expiry Snapshots</div>
        </div>
      </div>

      <div className={styles.sectionGrid}>
        {topExpiries.map(expiry => {
          const detail = aggregates[expiry] ?? aggregateExpiry(undefined);
          const totalOi = detail.callOi + detail.putOi;
          const pcr = detail.callOi > 0 ? detail.putOi / detail.callOi : 0;

          return (
            <section key={expiry} className={styles.expirySection}>
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>{fmtExpiry(expiry)}</div>
                  <div className={styles.sectionSub}>Live single expiry breakdown</div>
                </div>
                <div className={styles.sectionPcr}>PCR {fmtRatio(pcr)}</div>
              </div>

              <div className={styles.sectionChartWrap}>
                <div className={base.summaryDonutWrap}>
                  <MetricPie callValue={detail.callOi} putValue={detail.putOi} />
                  <div className={base.summaryDonutCenter}>
                    <span className={base.summaryDonutCenterLabel}>Total</span>
                    <strong className={base.summaryDonutCenterValue}>
                      {fmtOi(totalOi)}
                    </strong>
                  </div>
                </div>

                <div className={styles.sectionLegend}>
                  <div className={base.summaryLegendItem}>
                    <span className={`${base.summaryLegendDot} ${base.summaryLegendDotCall}`} />
                    <div>
                      <div className={base.summaryLegendLabel}>Call OI</div>
                      <div className={base.summaryLegendValue}>{fmtOi(detail.callOi)}</div>
                    </div>
                  </div>
                  <div className={base.summaryLegendItem}>
                    <span className={`${base.summaryLegendDot} ${base.summaryLegendDotPut}`} />
                    <div>
                      <div className={base.summaryLegendLabel}>Put OI</div>
                      <div className={base.summaryLegendValue}>{fmtOi(detail.putOi)}</div>
                    </div>
                  </div>
                </div>
              </div>

              <ExpiryTrendChart
                callValue={detail.callOi}
                putValue={detail.putOi}
                callChgValue={detail.callOiChg}
                putChgValue={detail.putOiChg}
                initialHistory={trendHistory[expiry]}
              />

              <div className={styles.detailMetricGrid}>
                <DetailMetricCard
                  className={styles.detailMetricCard}
                  title="Total OI"
                  subtitle="Expiry total open interest"
                  callValue={detail.callOi}
                  putValue={detail.putOi}
                  totalValue={fmtOi(totalOi)}
                  pcr={pcr}
                  formatter={fmtOi}
                />
                <DetailMetricCard
                  className={styles.detailMetricCard}
                  title="OI Change"
                  subtitle="Approx change from previous OI"
                  callValue={detail.callOiChg}
                  putValue={detail.putOiChg}
                  totalValue={fmtSignedOi(detail.callOiChg + detail.putOiChg)}
                  pcr={detail.callOiChg !== 0 ? detail.putOiChg / detail.callOiChg : 0}
                  formatter={fmtSignedOi}
                />
                <DetailMetricCard
                  className={styles.detailMetricCard}
                  title="Delta OI"
                  subtitle="Absolute delta exposure"
                  callValue={detail.callDeltaOi}
                  putValue={detail.putDeltaOi}
                  totalValue={fmtMetricCompact(detail.callDeltaOi + detail.putDeltaOi)}
                  pcr={detail.callDeltaOi > 0 ? detail.putDeltaOi / detail.callDeltaOi : 0}
                  formatter={fmtMetricCompact}
                />
                <DetailMetricCard
                  className={styles.detailMetricCard}
                  title="Volume"
                  subtitle="Expiry traded volume"
                  callValue={detail.callVolume}
                  putValue={detail.putVolume}
                  totalValue={fmtOi(detail.callVolume + detail.putVolume)}
                  pcr={detail.callVolume > 0 ? detail.putVolume / detail.callVolume : 0}
                  formatter={fmtOi}
                />
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
