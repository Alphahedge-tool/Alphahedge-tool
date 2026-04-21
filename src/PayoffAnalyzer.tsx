import { useEffect, useMemo, useRef, useState } from 'react';

interface LegLike {
  symbol: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  action: 'B' | 'S';
  price: number;
  lots: number;
  lotSize: number;
  entrySpot?: number;
  refId?: number;
  exchange?: string;
}

interface Props {
  legs: LegLike[];
  spot: number;
}

type PlotlyLike = {
  newPlot: (root: HTMLElement, data: any[], layout: any, config?: any) => Promise<any> | void;
  react?: (root: HTMLElement, data: any[], layout: any, config?: any) => Promise<any> | void;
  purge: (root: HTMLElement) => void;
  Plots?: { resize?: (root: HTMLElement) => void };
};

type EvaluatePoint = { at: number; payoff: number };

type EvaluateResponse = {
  current_spot?: number;
  sd1?: number;
  sd2?: number;
  sd3?: number;
  profits?: {
    breakeven_points?: number[];
    profit_probability?: number;
    max_profit?: number;
    max_loss?: number;
    total_profit_current?: number;
    total_profit_expiry?: number;
    payoff_at_expiry?: EvaluatePoint[];
    payoff_at_expiry_offset?: EvaluatePoint[];
  };
  message?: string;
  error?: string;
};

type RangeWindow = {
  start: number;
  end: number;
};

function SkeletonBlock({
  width = '100%',
  height,
  radius = 10,
}: {
  width?: number | string;
  height: number | string;
  radius?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.035) 100%)',
        backgroundSize: '220% 100%',
        animation: 'payoffSkeletonPulse 1.35s ease-in-out infinite',
      }}
    />
  );
}

function fromPaisa(v: number | undefined | null): number {
  return Number(v ?? 0) / 100;
}

function fmtRs(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSpot(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShortRs(v: number): string {
  const abs = Math.abs(v);
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`;
  return `${sign}₹${abs.toFixed(0)}`;
}

function metricTone(v: number): string {
  return v > 0 ? '#2dd4bf' : v < 0 ? '#fb7185' : '#CBD5E1';
}

function levelTone(value: number, spot: number): string {
  if (!Number.isFinite(value)) return '#94A3B8';
  if (Math.abs(value - spot) < 0.01) return '#E5E7EB';
  return value < spot ? '#fbbf24' : '#34d399';
}

function extractWindows(x: number[], y: number[], positive: boolean): RangeWindow[] {
  const windows: RangeWindow[] = [];
  let start: number | null = null;

  for (let i = 0; i < x.length; i += 1) {
    const match = positive ? y[i] > 0 : y[i] < 0;
    if (match && start === null) start = x[i];
    const nextMatch = i < x.length - 1 ? (positive ? y[i + 1] > 0 : y[i + 1] < 0) : false;
    if (match && !nextMatch && start !== null) {
      windows.push({ start, end: x[i] });
      start = null;
    }
  }

  return windows;
}

function nearestPoint(x: number[], y: number[], target: number): { x: number; y: number } | null {
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < x.length; i += 1) {
    const distance = Math.abs(x[i] - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return { x: x[bestIndex], y: y[bestIndex] };
}

function findExtremePoint(x: number[], y: number[], kind: 'max' | 'min'): { x: number; y: number } | null {
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return null;
  let bestIndex = 0;
  for (let i = 1; i < y.length; i += 1) {
    if ((kind === 'max' && y[i] > y[bestIndex]) || (kind === 'min' && y[i] < y[bestIndex])) {
      bestIndex = i;
    }
  }
  return { x: x[bestIndex], y: y[bestIndex] };
}

async function ensurePlotly(): Promise<PlotlyLike | null> {
  const mod = await import('plotly.js-dist-min');
  return ((mod as any).default ?? mod) as PlotlyLike;
}

function dteFromExpiry(expiry: string): number {
  try {
    const expiryDate = new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T00:00:00+05:30`);
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    nowIST.setHours(0, 0, 0, 0);
    const dte = Math.round((expiryDate.getTime() - nowIST.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, dte);
  } catch {
    return 0;
  }
}

function makeEvaluateLeg(leg: LegLike) {
  return {
    ref_id: leg.refId!,
    price: Math.round(leg.price * 100),
    quantity: leg.lots,
    lot_size: leg.lotSize,
    buy: leg.action === 'B',
    sell: leg.action === 'S',
    exchange: leg.exchange ?? 'NSE',
  };
}

async function fetchEvaluate(legs: LegLike[], exchange: string): Promise<EvaluateResponse | null> {
  const sessionToken = localStorage.getItem('nubra_session_token') ?? '';
  const deviceId = localStorage.getItem('nubra_device_id') ?? 'web';
  const rawCookie = localStorage.getItem('nubra_raw_cookie') ?? '';
  if (!sessionToken) return null;

  const validLegs = legs.filter(leg => leg.refId);
  if (validLegs.length === 0) return null;

  const customSpot = Math.round((validLegs[0].entrySpot ?? 0) * 100);
  const expiryOffset = validLegs.reduce((minDte, leg) => {
    const dte = dteFromExpiry(leg.expiry);
    return dte < minDte ? dte : minDte;
  }, Infinity);

  const res = await fetch('/api/nubra-evaluate', {
    method: 'POST',
    headers: {
      'x-session-token': sessionToken,
      'x-device-id': deviceId,
      'x-raw-cookie': rawCookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      custom_spot: customSpot,
      expiry_offset: isFinite(expiryOffset) ? expiryOffset : 0,
      payoff: true,
      legs: validLegs.map((leg) => ({ ...makeEvaluateLeg(leg), exchange })),
    }),
  });

  const text = await res.text();
  let json: EvaluateResponse | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) return json;
  return json;
}

function ExchangePayoffCard({ exchange, legs, fallbackSpot }: { exchange: string; legs: LegLike[]; fallbackSpot: number }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const hasRenderedPlotRef = useRef(false);
  const plotlyRef = useRef<PlotlyLike | null>(null);
  const latestFetchInputsRef = useRef({ exchange, legs });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [evalData, setEvalData] = useState<EvaluateResponse | null>(null);
  const [showExtremaMarkers, setShowExtremaMarkers] = useState(true);
  const [liveUpdateSeconds, setLiveUpdateSeconds] = useState<10 | 15>(10);
  const [nextUpdateIn, setNextUpdateIn] = useState(10);
  const showSkeleton = loading && !evalData && !error;

  const requestKey = useMemo(
    () => legs.map(leg => `${leg.refId}:${leg.action}:${leg.price}:${leg.lots}:${leg.lotSize}:${leg.exchange ?? 'NSE'}`).join('|'),
    [legs]
  );

  useEffect(() => {
    latestFetchInputsRef.current = { exchange, legs };
  }, [exchange, legs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setNextUpdateIn(liveUpdateSeconds);
    hasRenderedPlotRef.current = false;

    fetchEvaluate(legs, exchange)
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setEvalData(null);
          setError(`No evaluate data for ${exchange}.`);
          return;
        }
        if (data.error) {
          setEvalData(null);
          setError(data.error);
          return;
        }
        setEvalData(data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setEvalData(null);
        setError(err?.message || `Failed to load ${exchange} payoff.`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [exchange, requestKey]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimeout: number | null = null;
    let countdownInterval: number | null = null;
    let nextRefreshAt = Date.now() + liveUpdateSeconds * 1000;

    const syncCountdown = () => {
      setNextUpdateIn(Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000)));
    };

    const queueRefresh = () => {
      refreshTimeout = window.setTimeout(async () => {
        const { exchange: currentExchange, legs: currentLegs } = latestFetchInputsRef.current;

        try {
          const data = await fetchEvaluate(currentLegs, currentExchange);
          if (cancelled) return;

          if (!data) {
            setError(`No evaluate data for ${currentExchange}.`);
          } else if (data.error) {
            setError(data.error);
          } else {
            setEvalData(data);
            setError('');
          }
        } catch (err: any) {
          if (cancelled) return;
          setError(err?.message || `Failed to refresh ${currentExchange} payoff.`);
        }

        if (cancelled) return;
        nextRefreshAt = Date.now() + liveUpdateSeconds * 1000;
        setNextUpdateIn(liveUpdateSeconds);
        queueRefresh();
      }, liveUpdateSeconds * 1000);
    };

    setNextUpdateIn(liveUpdateSeconds);
    countdownInterval = window.setInterval(syncCountdown, 250);
    queueRefresh();

    return () => {
      cancelled = true;
      if (refreshTimeout !== null) window.clearTimeout(refreshTimeout);
      if (countdownInterval !== null) window.clearInterval(countdownInterval);
    };
  }, [liveUpdateSeconds, requestKey]);

  useEffect(() => {
    let cancelled = false;

    async function renderChart() {
      const root = plotRef.current;
      const expirySeries = evalData?.profits?.payoff_at_expiry ?? [];
      const todaySeries = evalData?.profits?.payoff_at_expiry_offset ?? [];
      if (!root || expirySeries.length === 0 || todaySeries.length === 0) return;

      const Plotly = await ensurePlotly();
      if (cancelled || !Plotly) return;

      const chartSpot = fromPaisa(evalData?.current_spot) || fallbackSpot || fromPaisa(todaySeries[Math.floor(todaySeries.length / 2)]?.at ?? 0);
      const titleLabel = [...new Set(legs.map(leg => leg.symbol))].join(', ');
      const expiryX = expirySeries.map(point => fromPaisa(point.at));
      const expiryY = expirySeries.map(point => fromPaisa(point.payoff));
      const todayX = todaySeries.map(point => fromPaisa(point.at));
      const todayY = todaySeries.map(point => fromPaisa(point.payoff));
      const expiryPositiveY = expiryY.map(value => (value > 0 ? value : 0));
      const expiryNegativeY = expiryY.map(value => (value < 0 ? value : 0));
      const yMin = Math.min(...expiryY, ...todayY, 0);
      const yMax = Math.max(...expiryY, ...todayY, 0);
      const breakevens = (evalData?.profits?.breakeven_points ?? []).map(fromPaisa);
      const sd1 = fromPaisa(evalData?.sd1);
      const sd2 = fromPaisa(evalData?.sd2);
      const sd3 = fromPaisa(evalData?.sd3);
      const sdLines = [
        { label: '-3SD', x: chartSpot - sd3, color: 'rgba(251,191,36,0.26)' },
        { label: '-2SD', x: chartSpot - sd2, color: 'rgba(250,204,21,0.30)' },
        { label: '-1SD', x: chartSpot - sd1, color: 'rgba(52,211,153,0.40)' },
        { label: '+1SD', x: chartSpot + sd1, color: 'rgba(52,211,153,0.40)' },
        { label: '+2SD', x: chartSpot + sd2, color: 'rgba(250,204,21,0.30)' },
        { label: '+3SD', x: chartSpot + sd3, color: 'rgba(251,191,36,0.26)' },
      ].filter(item => Number.isFinite(item.x) && item.x > 0);
      const positiveWindows = extractWindows(expiryX, expiryY, true);
      const negativeWindows = extractWindows(expiryX, expiryY, false);
      const maxPoint = findExtremePoint(expiryX, expiryY, 'max');
      const minPoint = findExtremePoint(expiryX, expiryY, 'min');
      const todayAtSpot = nearestPoint(todayX, todayY, chartSpot);
      const expiryAtSpot = nearestPoint(expiryX, expiryY, chartSpot);
      const yRange = Math.max(1, yMax - yMin);
      const spotTooltipOverlap =
        todayAtSpot && expiryAtSpot
          ? Math.abs(todayAtSpot.y - expiryAtSpot.y) < yRange * 0.12
          : false;
      const todaySpotAy = spotTooltipOverlap
        ? (todayAtSpot && todayAtSpot.y >= 0 ? 48 : -48)
        : (todayAtSpot && todayAtSpot.y >= 0 ? -36 : 36);
      const expirySpotAy = spotTooltipOverlap
        ? (expiryAtSpot && expiryAtSpot.y >= 0 ? -54 : 54)
        : (expiryAtSpot && expiryAtSpot.y >= 0 ? -52 : 52);
      const todaySpotAx = spotTooltipOverlap ? -34 : 0;
      const expirySpotAx = spotTooltipOverlap ? 34 : 0;

      plotlyRef.current = Plotly;

      await (hasRenderedPlotRef.current && Plotly.react ? Plotly.react : Plotly.newPlot)(
        root,
        [
          {
            x: expiryX,
            y: expiryPositiveY,
            type: 'scatter',
            mode: 'lines',
            name: 'Profit Zone',
            line: { color: 'rgba(34,197,94,0)', width: 0 },
            fill: 'tozeroy',
            fillcolor: 'rgba(34,197,94,0.22)',
            hoverinfo: 'skip',
            showlegend: false,
          },
          {
            x: expiryX,
            y: expiryNegativeY,
            type: 'scatter',
            mode: 'lines',
            name: 'Loss Zone',
            line: { color: 'rgba(239,68,68,0)', width: 0 },
            fill: 'tozeroy',
            fillcolor: 'rgba(239,68,68,0.22)',
            hoverinfo: 'skip',
            showlegend: false,
          },
          {
            x: todayX,
            y: todayY,
            type: 'scatter',
            mode: 'lines',
            name: 'P/L Today',
            line: { color: '#60a5fa', width: 2.5, shape: 'spline' },
            hovertemplate: 'Spot %{x:,.2f}<br>Today %{y:,.2f}<extra></extra>',
          },
          {
            x: expiryX,
            y: expiryY,
            type: 'scatter',
            mode: 'lines',
            name: 'P/L At Expiry',
            line: { color: '#f43f5e', width: 2.5 },
            hovertemplate: 'Spot %{x:,.2f}<br>Expiry %{y:,.2f}<extra></extra>',
          },
        ],
        {
          autosize: true,
          margin: { l: 72, r: 28, t: 54, b: 88 },
          paper_bgcolor: '#15120f',
          plot_bgcolor: '#181512',
          showlegend: true,
          legend: {
            orientation: 'h',
            x: 1,
            xanchor: 'right',
            y: 1.17,
            font: { color: '#D1D4DC', size: 11 },
            bgcolor: 'rgba(0,0,0,0)',
          },
          title: {
            text: `${exchange} · ${titleLabel}`,
            x: 0.02,
            xanchor: 'left',
            font: { color: '#E5E7EB', size: 14, family: 'var(--font-family-sans)' },
          },
          xaxis: {
            title: { text: 'Underlying Spot', font: { color: '#9CA3AF', size: 11 }, standoff: 18 },
            color: '#9CA3AF',
            gridcolor: 'rgba(255,255,255,0.08)',
            zeroline: false,
            automargin: true,
            tickfont: { size: 12 },
            tickformat: ',.0f',
            showspikes: true,
            spikecolor: 'rgba(255,255,255,0.24)',
            spikethickness: 1,
          },
          yaxis: {
            title: { text: 'Profit / Loss', font: { color: '#9CA3AF', size: 11 }, standoff: 12 },
            color: '#9CA3AF',
            gridcolor: 'rgba(255,255,255,0.08)',
            zeroline: true,
            zerolinecolor: 'rgba(255,255,255,0.42)',
            automargin: true,
            tickprefix: '₹',
            tickformat: ',.0f',
            showspikes: true,
            spikecolor: 'rgba(255,255,255,0.24)',
            spikethickness: 1,
          },
          shapes: [
            ...positiveWindows.map((window) => ({
              type: 'rect',
              x0: window.start,
              x1: window.end,
              y0: 0,
              y1: yMax,
              fillcolor: 'rgba(34,197,94,0.08)',
              line: { width: 0 },
              layer: 'below',
            })),
            ...negativeWindows.map((window) => ({
              type: 'rect',
              x0: window.start,
              x1: window.end,
              y0: yMin,
              y1: 0,
              fillcolor: 'rgba(239,68,68,0.08)',
              line: { width: 0 },
              layer: 'below',
            })),
            {
              type: 'line',
              x0: chartSpot,
              x1: chartSpot,
              y0: yMin,
              y1: yMax,
              line: { color: 'rgba(255,255,255,0.56)', width: 1.2, dash: 'dot' },
            },
            ...sdLines.map((item) => ({
              type: 'line',
              x0: item.x,
              x1: item.x,
              y0: yMin,
              y1: yMax,
              line: { color: item.color, width: 1, dash: 'dot' },
            })),
            ...breakevens.map((x) => ({
              type: 'line',
              x0: x,
              x1: x,
              y0: yMin,
              y1: yMax,
              line: { color: 'rgba(245,158,11,0.34)', width: 1, dash: 'dash' },
            })),
          ],
          annotations: [
            {
              x: chartSpot,
              y: yMax,
              yanchor: 'bottom',
              text: `Spot ${fmtSpot(chartSpot)}`,
              showarrow: false,
              font: { color: '#E5E7EB', size: 11 },
              bgcolor: 'rgba(28,24,21,0.96)',
              bordercolor: 'rgba(255,255,255,0.12)',
              borderwidth: 1,
              borderpad: 6,
            },
            ...sdLines.map((item) => ({
              x: item.x,
              y: yMax,
              yanchor: 'bottom',
              text: item.label,
              showarrow: false,
              font: { color: '#A3A3A3', size: 10 },
              bgcolor: 'rgba(21,18,15,0.86)',
              bordercolor: 'rgba(255,255,255,0.06)',
              borderwidth: 1,
              borderpad: 4,
            })),
            ...breakevens.map((x, index) => ({
              x,
              y: 0,
              yanchor: 'bottom',
              text: `BE ${index + 1}<br>${fmtSpot(x)}`,
              showarrow: false,
              font: { color: '#fbbf24', size: 10 },
              bgcolor: 'rgba(28,24,21,0.96)',
              bordercolor: 'rgba(245,158,11,0.20)',
              borderwidth: 1,
              borderpad: 5,
            })),
            ...(todayAtSpot ? [{
              x: todayAtSpot.x,
              y: todayAtSpot.y,
              text: `Today @ Spot<br>${fmtRs(todayAtSpot.y)}`,
              showarrow: true,
              arrowhead: 0,
              arrowsize: 1,
              arrowwidth: 1,
              arrowcolor: '#60a5fa',
              ax: todaySpotAx,
              ay: todaySpotAy,
              font: { color: '#dbeafe', size: 10 },
              bgcolor: 'rgba(30,41,59,0.92)',
              bordercolor: 'rgba(96,165,250,0.30)',
              borderwidth: 1,
              borderpad: 6,
            }] : []),
            ...(expiryAtSpot ? [{
              x: expiryAtSpot.x,
              y: expiryAtSpot.y,
              text: `Expiry @ Spot<br>${fmtRs(expiryAtSpot.y)}`,
              showarrow: true,
              arrowhead: 0,
              arrowsize: 1,
              arrowwidth: 1,
              arrowcolor: '#f43f5e',
              ax: expirySpotAx,
              ay: expirySpotAy,
              font: { color: '#ffe4e6', size: 10 },
              bgcolor: 'rgba(76,5,25,0.88)',
              bordercolor: 'rgba(244,63,94,0.28)',
              borderwidth: 1,
              borderpad: 6,
            }] : []),
            ...(showExtremaMarkers && maxPoint ? [{
              x: maxPoint.x,
              y: maxPoint.y,
              text: `Max<br>${fmtShortRs(maxPoint.y)}`,
              showarrow: false,
              font: { color: '#dcfce7', size: 10 },
              bgcolor: 'rgba(20,83,45,0.58)',
              bordercolor: 'rgba(34,197,94,0.30)',
              borderwidth: 1,
              borderpad: 5,
            }] : []),
            ...(showExtremaMarkers && minPoint ? [{
              x: minPoint.x,
              y: minPoint.y,
              text: `Min<br>${fmtShortRs(minPoint.y)}`,
              showarrow: false,
              font: { color: '#ffe4e6', size: 10 },
              bgcolor: 'rgba(127,29,29,0.58)',
              bordercolor: 'rgba(239,68,68,0.30)',
              borderwidth: 1,
              borderpad: 5,
            }] : []),
          ],
        },
        {
          displayModeBar: true,
          responsive: true,
          displaylogo: false,
          modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines'],
        }
      );

      hasRenderedPlotRef.current = true;

      if (!resizeRef.current) {
        resizeRef.current = new ResizeObserver(() => {
          plotlyRef.current?.Plots?.resize?.(root);
        });
        resizeRef.current.observe(root);
      }
    }

    renderChart();

    return () => {
      cancelled = true;
    };
  }, [evalData, exchange, fallbackSpot, legs, showExtremaMarkers]);

  useEffect(() => {
    return () => {
      if (resizeRef.current) {
        resizeRef.current.disconnect();
        resizeRef.current = null;
      }
      if (plotRef.current && plotlyRef.current) {
        plotlyRef.current.purge(plotRef.current);
      }
      plotlyRef.current = null;
      hasRenderedPlotRef.current = false;
    };
  }, []);

  const summary = useMemo(() => {
    const profits = evalData?.profits;
    const expirySeries = profits?.payoff_at_expiry ?? [];
    const expiryX = expirySeries.map(point => fromPaisa(point.at));
    const expiryY = expirySeries.map(point => fromPaisa(point.payoff));
    const positiveWindows = extractWindows(expiryX, expiryY, true);
    const negativeWindows = extractWindows(expiryX, expiryY, false);
    const chartSpot = fromPaisa(evalData?.current_spot) || fallbackSpot;
    const maxPoint = findExtremePoint(expiryX, expiryY, 'max');
    const minPoint = findExtremePoint(expiryX, expiryY, 'min');
    const maxProfit = fromPaisa(profits?.max_profit);
    const maxLoss = fromPaisa(profits?.max_loss);
    return {
      current: fromPaisa(profits?.total_profit_current),
      expiry: fromPaisa(profits?.total_profit_expiry),
      maxProfit,
      maxLoss,
      pop: Number(profits?.profit_probability ?? 0) * 100,
      rewardRisk: Math.abs(maxLoss) > 0.0001 ? maxProfit / Math.abs(maxLoss) : 0,
      centerDrift: fromPaisa(profits?.total_profit_expiry) - fromPaisa(profits?.total_profit_current),
      maxPoint,
      minPoint,
      profitableRange: positiveWindows.map(window => `${fmtSpot(window.start)} - ${fmtSpot(window.end)}`).join('  |  ') || 'None',
      riskRange: negativeWindows.map(window => `${fmtSpot(window.start)} - ${fmtSpot(window.end)}`).join('  |  ') || 'None',
      chartSpot,
    };
  }, [evalData, fallbackSpot]);

  const levelPills = useMemo(() => {
    const profits = evalData?.profits;
    const breakevens = (profits?.breakeven_points ?? []).map(fromPaisa);
    const sd1 = fromPaisa(evalData?.sd1);
    const sd2 = fromPaisa(evalData?.sd2);
    const sd3 = fromPaisa(evalData?.sd3);
    const chartSpot = summary.chartSpot;

    return [
      { label: 'Spot', value: chartSpot },
      ...breakevens.map((value, index) => ({ label: `BE ${index + 1}`, value })),
      ...(sd1 > 0 ? [{ label: '-1SD', value: chartSpot - sd1 }, { label: '+1SD', value: chartSpot + sd1 }] : []),
      ...(sd2 > 0 ? [{ label: '-2SD', value: chartSpot - sd2 }, { label: '+2SD', value: chartSpot + sd2 }] : []),
      ...(sd3 > 0 ? [{ label: '-3SD', value: chartSpot - sd3 }, { label: '+3SD', value: chartSpot + sd3 }] : []),
    ];
  }, [evalData, summary.chartSpot]);

  return (
    <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, overflow: 'hidden', background: 'linear-gradient(180deg, #171310 0%, #120f0d 100%)', boxShadow: '0 18px 40px rgba(0,0,0,0.28)' }}>
      <style>{`
        @keyframes payoffSkeletonPulse {
          0% { background-position: 100% 50%; opacity: 0.7; }
          50% { background-position: 0% 50%; opacity: 1; }
          100% { background-position: -100% 50%; opacity: 0.7; }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 12px 7px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap', background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#E5E7EB', letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 10px', borderRadius: 999, background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.18)' }}>{exchange}</span>
          <span style={{ fontSize: 13, color: '#C9D1DC', fontWeight: 600 }}>{[...new Set(legs.map(leg => leg.symbol))].join(', ')}</span>
          <span style={{ fontSize: 12, color: '#7A8391' }}>{legs.length} leg{legs.length !== 1 ? 's' : ''}</span>
          <span style={{ fontSize: 10, color: '#7C8799', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Live</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 3, borderRadius: 999, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {[10, 15].map((seconds) => (
              <button
                key={seconds}
                type="button"
                onClick={() => setLiveUpdateSeconds(seconds as 10 | 15)}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: liveUpdateSeconds === seconds ? '#E5E7EB' : '#8B95A7',
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: liveUpdateSeconds === seconds ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.02)',
                  cursor: 'pointer',
                }}
              >
                {seconds}s
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: '#fcd34d', fontWeight: 600, padding: '5px 10px', borderRadius: 999, background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.14)' }}>
            Next update in {nextUpdateIn}s
          </span>
          {loading && <span style={{ fontSize: 12, color: '#60a5fa' }}>Loading...</span>}
          {error && <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 6, flex: '1 1 420px' }}>
          {(showSkeleton ? new Array(6).fill(null).map((_, idx) => ({ label: `s-${idx}` })) : [
            { label: 'Today', value: fmtShortRs(summary.current), tone: metricTone(summary.current) },
            { label: 'Expiry', value: fmtShortRs(summary.expiry), tone: metricTone(summary.expiry) },
            { label: 'Max Profit', value: fmtShortRs(summary.maxProfit), tone: '#E5E7EB' },
            { label: 'Max Loss', value: fmtShortRs(summary.maxLoss), tone: '#E5E7EB' },
            { label: 'POP', value: `${summary.pop.toFixed(2)}%`, tone: '#E5E7EB' },
            { label: 'Reward / Risk', value: summary.rewardRisk ? `${summary.rewardRisk.toFixed(2)}x` : 'Flat', tone: '#E5E7EB' },
          ]).map((item: any) => (
            <div key={item.label} style={{ minWidth: 0, padding: '7px 9px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {showSkeleton ? (
                <>
                  <SkeletonBlock width="52%" height={8} radius={4} />
                  <SkeletonBlock width="74%" height={14} radius={5} />
                </>
              ) : (
                <>
                  <span style={{ fontSize: 8, fontWeight: 700, color: '#7C8799', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{item.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: item.tone, lineHeight: 1.05 }}>{item.value}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', background: 'rgba(255,255,255,0.015)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#60a5fa', padding: '4px 8px', borderRadius: 999, background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.18)' }}>Today Curve</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#f43f5e', padding: '4px 8px', borderRadius: 999, background: 'rgba(244,63,94,0.10)', border: '1px solid rgba(244,63,94,0.18)' }}>Expiry Curve</span>
          <span style={{ fontSize: 10, color: '#94A3B8', padding: '4px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>Spot {fmtSpot(fromPaisa(evalData?.current_spot) || fallbackSpot)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: '#fbbf24', padding: '4px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.16)' }}>Break-even {evalData?.profits?.breakeven_points?.length ?? 0}</span>
          <span style={{ fontSize: 10, color: '#A3A3A3', padding: '4px 8px', borderRadius: 999, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>SD visible</span>
          <button
            type="button"
            onClick={() => setShowExtremaMarkers(v => !v)}
            style={{
              fontSize: 10,
              color: showExtremaMarkers ? '#D1D4DC' : '#7C8799',
              padding: '4px 8px',
              borderRadius: 999,
              background: showExtremaMarkers ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              cursor: 'pointer',
            }}
          >
            {showExtremaMarkers ? 'Max/Min On' : 'Max/Min Off'}
          </button>
        </div>
      </div>
      <div style={{ padding: '6px 12px 12px', background: 'linear-gradient(180deg, rgba(255,255,255,0.01) 0%, rgba(0,0,0,0.04) 100%)' }}>
        <div style={{ position: 'relative', borderRadius: 16, overflow: 'visible', border: '1px solid rgba(255,255,255,0.06)', background: '#15120f', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)' }}>
          {showSkeleton ? (
            <div style={{ padding: '18px 18px 22px', height: 'clamp(540px, 72vh, 820px)', minHeight: 540, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <SkeletonBlock width={140} height={18} radius={6} />
                <SkeletonBlock width={120} height={12} radius={6} />
              </div>
              <div style={{ flex: 1, borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)', background: 'linear-gradient(180deg, rgba(255,255,255,0.015), rgba(255,255,255,0.005))', position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, opacity: 0.35, backgroundImage: 'radial-gradient(circle, rgba(148,163,184,0.28) 1px, transparent 1.15px)', backgroundSize: '12px 12px' }} />
                <div style={{ position: 'absolute', left: 22, right: 18, top: 40, bottom: 28, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.16)' }} />
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
                </div>
                <div style={{ position: 'absolute', left: 34, right: 30, bottom: 40, height: 2, background: 'linear-gradient(90deg, rgba(96,165,250,0.2), rgba(96,165,250,0.9), rgba(96,165,250,0.15))', borderRadius: 999, transform: 'translateY(-120px) rotate(-8deg)', transformOrigin: 'left center' }} />
                <div style={{ position: 'absolute', left: 34, right: 30, bottom: 28, height: 2, background: 'linear-gradient(90deg, rgba(244,63,94,0.15), rgba(244,63,94,0.9), rgba(244,63,94,0.15))', borderRadius: 999, transform: 'translateY(-90px) rotate(6deg)', transformOrigin: 'left center' }} />
              </div>
            </div>
          ) : (
            <>
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: '34px 18px 30px 38px',
                  borderRadius: 10,
                  pointerEvents: 'none',
                  opacity: 0.55,
                  backgroundImage: 'radial-gradient(circle, rgba(148,163,184,0.32) 1px, transparent 1.15px)',
                  backgroundSize: '11px 11px',
                  backgroundPosition: '0 0',
                  zIndex: 0,
                }}
              />
              <div ref={plotRef} style={{ position: 'relative', zIndex: 1, height: 'clamp(540px, 72vh, 820px)', minHeight: 540, paddingBottom: 10 }} />
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8, padding: '0 12px 0' }}>
        <div style={{ borderRadius: 12, border: '1px solid rgba(34,197,94,0.12)', background: 'linear-gradient(180deg, rgba(34,197,94,0.08) 0%, rgba(21,18,15,0.92) 100%)', padding: '9px 10px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#86efac', marginBottom: 5 }}>Profitable Window</div>
          <div style={{ fontSize: 12, lineHeight: 1.35, color: '#dcfce7', fontWeight: 600 }}>{summary.profitableRange}</div>
        </div>
        <div style={{ borderRadius: 12, border: '1px solid rgba(239,68,68,0.12)', background: 'linear-gradient(180deg, rgba(239,68,68,0.08) 0%, rgba(21,18,15,0.92) 100%)', padding: '9px 10px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#fda4af', marginBottom: 5 }}>Risk Window</div>
          <div style={{ fontSize: 12, lineHeight: 1.35, color: '#ffe4e6', fontWeight: 600 }}>{summary.riskRange}</div>
        </div>
        <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(21,18,15,0.94) 100%)', padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#94A3B8' }}>Strategy Read</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#D8DEE9', fontWeight: 500 }}>Drift <span style={{ color: metricTone(summary.centerDrift), fontWeight: 600 }}>{fmtShortRs(summary.centerDrift)}</span></span>
            <span style={{ fontSize: 11, color: '#D8DEE9', fontWeight: 500 }}>Best <span style={{ color: '#86efac', fontWeight: 600 }}>{summary.maxPoint ? fmtSpot(summary.maxPoint.x) : '--'}</span></span>
            <span style={{ fontSize: 11, color: '#D8DEE9', fontWeight: 500 }}>Worst <span style={{ color: '#fda4af', fontWeight: 600 }}>{summary.minPoint ? fmtSpot(summary.minPoint.x) : '--'}</span></span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 12px 12px' }}>
        {levelPills.map((item) => (
          <span
            key={`${item.label}-${item.value}`}
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: levelTone(item.value, summary.chartSpot),
              padding: '4px 8px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            {item.label} {fmtSpot(item.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function PayoffAnalyzer({ legs, spot }: Props) {
  const validLegs = useMemo(() => legs.filter(leg => leg.refId), [legs]);

  const groups = useMemo(() => {
    const map = new Map<string, { exchange: string; label: string; legs: LegLike[] }>();
    for (const leg of validLegs) {
      const exchange = leg.exchange ?? 'NSE';
      const label = leg.symbol || exchange;
      const bucketKey = `${exchange}::${label}`;
      const bucket = map.get(bucketKey) ?? { exchange, label, legs: [] };
      bucket.legs.push(leg);
      map.set(bucketKey, bucket);
    }
    return [...map.entries()].map(([bucketKey, bucket]) => ({
      exchange: bucket.exchange,
      legs: bucket.legs,
      label: bucket.label,
      key: bucketKey,
    }));
  }, [validLegs]);

  const [activeGroupKey, setActiveGroupKey] = useState<string>('');

  useEffect(() => {
    if (groups.length === 0) {
      setActiveGroupKey('');
      return;
    }
    if (!groups.some(group => group.key === activeGroupKey)) {
      setActiveGroupKey(groups[0].key);
    }
  }, [groups, activeGroupKey]);

  const activeGroup = groups.find(group => group.key === activeGroupKey) ?? groups[0] ?? null;

  if (validLegs.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 13, fontFamily: 'var(--font-family-sans)' }}>
        Add legs to load Nubra payoff data
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px 12px', background: 'radial-gradient(circle at top right, rgba(96,165,250,0.07), transparent 22%), radial-gradient(circle at top left, rgba(244,63,94,0.05), transparent 24%), linear-gradient(180deg, #15120f 0%, #120f0d 100%)', overflow: 'auto' }}>
      {groups.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: 0 }}>
          {groups.map((group) => {
            const active = group.key === activeGroup?.key;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => setActiveGroupKey(group.key)}
                style={{
                  border: active ? '1px solid rgba(96,165,250,0.38)' : '1px solid rgba(255,255,255,0.08)',
                  background: active ? 'linear-gradient(180deg, rgba(96,165,250,0.16) 0%, rgba(37,99,235,0.08) 100%)' : 'rgba(255,255,255,0.03)',
                  color: active ? '#E5EEFf' : '#A8B0BD',
                  borderRadius: 10,
                  padding: '5px 9px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 600 }}>{group.label}</span>
                <span style={{ fontSize: 8, color: active ? '#BFDBFE' : '#6B7280' }}>{group.exchange}</span>
              </button>
            );
          })}
        </div>
      )}
      {groups.map((group) => {
        const active = group.key === activeGroup?.key;
        return (
          <div
            key={group.key}
            style={{
              minHeight: 0,
              display: active ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            <ExchangePayoffCard exchange={group.exchange} legs={group.legs} fallbackSpot={spot} />
          </div>
        );
      })}
    </div>
  );
}
