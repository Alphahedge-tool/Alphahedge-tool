'use client';

/**
 * NubraBridgeManager — singleton WebSocket for the Nubra bridge (ws://localhost:8765).
 *
 * Problem it solves:
 *   MasterOptionChain and CumulativeOiChain both open their own raw WebSocket.
 *   When the user switches between pages the old socket closes, and the new one
 *   sometimes fails to reconnect to the bridge in time → no live data until full refresh.
 *
 * Solution:
 *   One persistent socket, shared across all consumers.
 *   Components call subscribe() to register a message handler and a symbol list.
 *   The manager re-sends the subscribe frame whenever the socket (re)connects.
 *   Closing only happens when ALL consumers have unsubscribed and the socket is idle.
 */

const BRIDGE = 'ws://localhost:8765';
const RECONNECT_DELAY_MS = 1500;

type MsgHandler = (msg: Record<string, unknown>) => void;

interface Subscription {
  session: string;
  symbols: string[];
  exchange: string;
  dataType: string;
  handler: MsgHandler;
}

class NubraBridgeManager {
  private ws: WebSocket | null = null;
  private subs = new Map<symbol, Subscription>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // ── Public API ────────────────────────────────────────────────────────────

  subscribe(opts: {
    session: string;
    symbols: string[];
    exchange: string;
    dataType?: string;
    onMessage: MsgHandler;
  }): () => void {
    const key = Symbol();
    this.subs.set(key, {
      session: opts.session,
      symbols: opts.symbols,
      exchange: opts.exchange,
      dataType: opts.dataType ?? 'option',
      handler: opts.onMessage,
    });

    // If already open, send subscribe frame immediately
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribeFrame(this.subs.get(key)!);
    } else {
      // Ensure connection is being attempted
      this.ensureConnected();
    }

    return () => {
      this.subs.delete(key);
      // Don't close the socket — keep alive for fast re-subscribe
    };
  }

  // Update symbols for an existing subscription (call after expiry changes)
  // Returns a new unsubscribe fn — old one is invalidated.
  resubscribe(
    unsub: () => void,
    opts: { session: string; symbols: string[]; exchange: string; dataType?: string; onMessage: MsgHandler },
  ): () => void {
    unsub();
    return this.subscribe(opts);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private ensureConnected() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    try {
      const ws = new WebSocket(BRIDGE);
      this.ws = ws;

      ws.onopen = () => {
        // Re-send all active subscriptions
        for (const sub of this.subs.values()) {
          this.sendSubscribeFrame(sub);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as Record<string, unknown>;
          for (const sub of this.subs.values()) {
            sub.handler(msg);
          }
        } catch { /* ignore malformed frames */ }
      };

      ws.onerror = () => { /* onclose will handle reconnect */ };

      ws.onclose = () => {
        if (this.destroyed) return;
        // Only reconnect if someone is still subscribed
        if (this.subs.size > 0) {
          this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
        }
      };
    } catch {
      if (this.subs.size > 0) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    }
  }

  private sendSubscribeFrame(sub: Subscription) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      action: 'subscribe',
      session_token: sub.session,
      data_type: sub.dataType,
      symbols: sub.symbols,
      exchange: sub.exchange,
    }));
  }
}

// Singleton
export const nubraBridge = new NubraBridgeManager();
