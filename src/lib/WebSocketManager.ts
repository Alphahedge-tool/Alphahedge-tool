'use client';

/**
 * WebSocketManager — singleton that owns the Upstox market-data WebSocket.
 *
 * Ported from frontend-beta. Key design:
 *  - Zero React state in the hot path.
 *  - Components subscribe to specific instrument keys; only those callbacks fire.
 *  - Data stored in a plain Map — reads are O(1).
 *  - Protobuf decode happens once per message, then dispatched to listeners.
 */

import { Buffer } from 'buffer';
import * as protobuf from 'protobufjs';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface InstrumentMarketData {
  ltp: number;
  ltt: string;
  ltq: string;
  cp: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  iv: number;
  oi: number;
  atp: number;
  vtt: string;
  bidAskQuote: Array<{ bidQ: string; bidP: number; askQ: string; askP: number }>;
  ohlc: Array<{
    interval: string;
    open: number;
    high: number;
    low: number;
    close: number;
    vol: string;
    ts: string;
  }>;
}

export type MarketDataListener = (data: InstrumentMarketData) => void;
export type ConnectionListener = (connected: boolean) => void;

// ─────────────────────────────────────────────────────────────
// Protobuf definition
// ─────────────────────────────────────────────────────────────

const PROTO_DEFINITION = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;

message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
}
message MarketLevel {
  repeated Quote bidAskQuote = 1;
}
message MarketOHLC {
  repeated OHLC ohlc = 1;
}
message Quote {
  int64 bidQ = 1;
  double bidP = 2;
  int64 askQ = 3;
  double askP = 4;
}
message OptionGreeks {
  double delta = 1;
  double theta = 2;
  double gamma = 3;
  double vega = 4;
  double rho = 5;
}
message OHLC {
  string interval = 1;
  double open = 2;
  double high = 3;
  double low = 4;
  double close = 5;
  int64 vol = 6;
  int64 ts = 7;
}
enum Type {
  initial_feed = 0;
  live_feed = 1;
  market_info = 2;
}
message MarketFullFeed {
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq = 9;
  double tsq = 10;
}
message IndexFullFeed {
  LTPC ltpc = 1;
  MarketOHLC marketOHLC = 2;
}
message FullFeed {
  oneof FullFeedUnion {
    MarketFullFeed marketFF = 1;
    IndexFullFeed indexFF = 2;
  }
}
message FirstLevelWithGreeks {
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}
message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}
enum RequestMode {
  ltpc = 0;
  full_d5 = 1;
  option_greeks = 2;
  full_d30 = 3;
}
enum MarketStatus {
  PRE_OPEN_START = 0;
  PRE_OPEN_END = 1;
  NORMAL_OPEN = 2;
  NORMAL_CLOSE = 3;
  CLOSING_START = 4;
  CLOSING_END = 5;
}
message MarketInfo {
  map<string, MarketStatus> segmentStatus = 1;
}
message FeedResponse {
  Type type = 1;
  map<string, Feed> feeds = 2;
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`;

const WS_URL_CACHE_KEY = 'upstox_ws_url_cache';

// ─────────────────────────────────────────────────────────────
// WebSocketManager class
// ─────────────────────────────────────────────────────────────

class WebSocketManager {
  private ws: WebSocket | null = null;
  private token: string = '';
  private protobufRoot: any = null;
  private protobufReady = false;

  private destroyed = false;
  private retryCount = 0;
  private readonly MAX_RETRIES = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;

  private data: Map<string, InstrumentMarketData> = new Map();

  private listeners: Map<string, Set<MarketDataListener>> = new Map();
  private wildcardListeners: Set<(key: string, data: InstrumentMarketData) => void> = new Set();
  private connectionListeners: Set<ConnectionListener> = new Set();

  private requestedKeys: Set<string> = new Set();
  private subscribedKeys: Set<string> = new Set();

  // Batch listener dispatch — accumulate per-tick, flush via setTimeout(0)
  private pendingFeeds: Map<string, any> = new Map();
  private feedTimerId: number | null = null;

  isConnected = false;

  // ── public API ────────────────────────────────────────────

  connect(token: string): void {
    if (token === this.token && (this.isConnecting || (this.ws && this.ws.readyState <= WebSocket.CLOSING))) return;
    this.token = token;
    this.destroyed = false;
    this._teardown();
    this._connect();
  }

  disconnect(): void {
    this.destroyed = true;
    this._teardown();
    this._notifyConnection(false);
  }

  requestKeys(keys: string[]): () => void {
    for (const k of keys) this.requestedKeys.add(k);
    this._syncSubscription();
    return () => {};
  }

  releaseKeys(keys: string[]): void {
    for (const k of keys) {
      this.requestedKeys.delete(k);
      this.subscribedKeys.delete(k);
    }
  }

  subscribe(instrumentKey: string, cb: MarketDataListener): () => void {
    if (!this.listeners.has(instrumentKey)) {
      this.listeners.set(instrumentKey, new Set());
    }
    this.listeners.get(instrumentKey)!.add(cb);
    const cached = this.data.get(instrumentKey);
    if (cached) cb(cached);
    return () => {
      this.listeners.get(instrumentKey)?.delete(cb);
    };
  }

  subscribeAll(cb: (key: string, data: InstrumentMarketData) => void): () => void {
    this.wildcardListeners.add(cb);
    this.data.forEach((d, k) => cb(k, d));
    return () => {
      this.wildcardListeners.delete(cb);
    };
  }

  onConnectionChange(cb: ConnectionListener): () => void {
    this.connectionListeners.add(cb);
    cb(this.isConnected);
    return () => {
      this.connectionListeners.delete(cb);
    };
  }

  get(instrumentKey: string): InstrumentMarketData | undefined {
    return this.data.get(instrumentKey);
  }

  snapshot(): ReadonlyMap<string, InstrumentMarketData> {
    return this.data;
  }

  // ── private helpers ───────────────────────────────────────

  private async _initProtobuf(): Promise<void> {
    if (this.protobufReady) return;
    this.protobufRoot = protobuf.parse(PROTO_DEFINITION).root;
    this.protobufReady = true;
  }

  private _decode(buffer: Buffer): any | null {
    if (!this.protobufReady || !this.protobufRoot) return null;
    try {
      const FeedResponse = this.protobufRoot.lookupType(
        'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse'
      );
      return FeedResponse.decode(buffer);
    } catch {
      return null;
    }
  }

  private async _getWsUrl(): Promise<string> {
    const res = await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize', {
      headers: { 'Content-type': 'application/json', Authorization: 'Bearer ' + this.token },
    });
    if (!res.ok) throw new Error('WS auth failed');
    const json = await res.json() as any;
    return json.data.authorizedRedirectUri;
  }

  private _teardown(): void {
    this.isConnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.feedTimerId !== null) {
      clearTimeout(this.feedTimerId);
      this.feedTimerId = null;
      this.pendingFeeds = new Map();
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.subscribedKeys.clear();
  }

  private async _connect(): Promise<void> {
    if (this.destroyed || !this.token) return;
    this.isConnecting = true;
    try {
      await this._initProtobuf();
      const url = await this._getWsUrl();
      if (this.destroyed) { this.isConnecting = false; return; }

      const ws = new WebSocket(url);
      this.isConnecting = false;
      this.ws = ws;

      ws.onopen = () => {
        if (this.destroyed) return;
        this.retryCount = 0;
        this._notifyConnection(true);
        this._sendSubscribe([...this.requestedKeys]);
        this.requestedKeys.forEach(k => this.subscribedKeys.add(k));
      };

      ws.onclose = (event) => {
        this.ws = null;
        this.subscribedKeys.clear();
        this._notifyConnection(false);
        localStorage.removeItem(WS_URL_CACHE_KEY);
        if (!this.destroyed && this.retryCount < this.MAX_RETRIES) {
          this.retryCount += 1;
          const delay = Math.min(2000 * Math.pow(2, this.retryCount - 1), 30_000);
          this.reconnectTimer = setTimeout(() => this._connect(), delay);
        }
      };

      ws.onerror = () => {};

      ws.onmessage = async (event) => {
        try {
          const ab: ArrayBuffer = event.data instanceof Blob
            ? await event.data.arrayBuffer()
            : event.data;
          const buf = Buffer.from(ab);
          const response = this._decode(buf);
          if (!response?.feeds) return;
          this._processFeed(response.feeds);
        } catch (err) {
          console.error('[WSManager] message error', err);
        }
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[WSManager] connect error', err);
      if (!this.destroyed && this.retryCount < this.MAX_RETRIES) {
        this.retryCount += 1;
        const delay = Math.min(2000 * Math.pow(2, this.retryCount - 1), 30_000);
        this.reconnectTimer = setTimeout(() => this._connect(), delay);
      }
    }
  }

  private _syncSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const toAdd = [...this.requestedKeys].filter(k => !this.subscribedKeys.has(k));
    if (toAdd.length === 0) return;
    this._sendSubscribe(toAdd);
    toAdd.forEach(k => this.subscribedKeys.add(k));
  }

  private _sendSubscribe(keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || keys.length === 0) return;
    const msg = {
      guid: 'sub_' + Date.now(),
      method: 'sub',
      data: { mode: 'full', instrumentKeys: keys },
    };
    this.ws.send(Buffer.from(JSON.stringify(msg)));
  }

  private _processFeed(feeds: Record<string, any>): void {
    // Parse and store data immediately (so .get() is always fresh),
    // but batch listener dispatch into rAF so it never blocks scroll/zoom.
    for (const key of Object.keys(feeds)) {
      const feed = feeds[key];
      let parsed: InstrumentMarketData | null = null;

      if (feed.fullFeed?.marketFF) {
        const { ltpc = {}, optionGreeks = {}, marketLevel = {}, marketOHLC, iv, oi, atp, vtt } =
          feed.fullFeed.marketFF;
        const safeMarketOHLC = marketOHLC ?? {};
        parsed = {
          ltp: ltpc.ltp || 0,
          ltt: ltpc.ltt?.toString() || '',
          ltq: ltpc.ltq?.toString() || '',
          cp: ltpc.cp || 0,
          delta: optionGreeks.delta || 0,
          gamma: optionGreeks.gamma || 0,
          theta: optionGreeks.theta || 0,
          vega: optionGreeks.vega || 0,
          rho: optionGreeks.rho || 0,
          iv: (iv || 0) * 100,
          oi: oi || 0,
          atp: atp || 0,
          vtt: vtt?.toString() || '',
          bidAskQuote: (marketLevel.bidAskQuote || []).map((q: any) => ({
            bidQ: q.bidQ?.toString() || '',
            bidP: q.bidP || 0,
            askQ: q.askQ?.toString() || '',
            askP: q.askP || 0,
          })),
          ohlc: (safeMarketOHLC.ohlc || []).map((c: any) => ({
            interval: c.interval || '',
            open: c.open || 0,
            high: c.high || 0,
            low: c.low || 0,
            close: c.close || 0,
            vol: c.vol?.toString() || '',
            ts: c.ts?.toString() || '',
          })),
        };
      } else if (feed.fullFeed?.indexFF) {
        const { ltpc = {}, marketOHLC: indexMarketOHLC } = feed.fullFeed.indexFF;
        const safeIndexOHLC = indexMarketOHLC ?? {};
        parsed = {
          ltp: ltpc.ltp || 0,
          ltt: ltpc.ltt?.toString() || '',
          ltq: ltpc.ltq?.toString() || '',
          cp: ltpc.cp || 0,
          delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0,
          iv: 0, oi: 0, atp: 0, vtt: '',
          bidAskQuote: [],
          ohlc: (safeIndexOHLC.ohlc || []).map((c: any) => ({
            interval: c.interval || '',
            open: c.open || 0,
            high: c.high || 0,
            low: c.low || 0,
            close: c.close || 0,
            vol: c.vol?.toString() || '',
            ts: c.ts?.toString() || '',
          })),
        };
      }

      if (!parsed) continue;

      // Always update data map synchronously so .get() reads are fresh
      this.data.set(key, parsed);
      // Accumulate into pending batch (latest value per key wins within one tick)
      this.pendingFeeds.set(key, parsed);
    }

    // Flush once per event-loop tick via setTimeout(0) — batches all keys from
    // one WS message into a single listener dispatch, never blocking mid-frame
    if (this.feedTimerId === null) {
      this.feedTimerId = window.setTimeout((): void => {
        this.feedTimerId = null;
        const batch = this.pendingFeeds;
        this.pendingFeeds = new Map();
        for (const [key, parsed] of batch) {
          const keySubs = this.listeners.get(key);
          if (keySubs) {
            for (const cb of keySubs) cb(parsed);
          }
          for (const cb of this.wildcardListeners) cb(key, parsed);
        }
      }, 0) as unknown as number;
    }
  }

  private _notifyConnection(connected: boolean): void {
    this.isConnected = connected;
    for (const cb of this.connectionListeners) cb(connected);
  }
}

export const wsManager = new WebSocketManager();
