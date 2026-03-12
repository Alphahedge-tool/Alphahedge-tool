'use client';

/**
 * useWsConnection — thin React adapter over WebSocketManager.
 *
 * Handles token + instrument key subscriptions.
 * All WS logic (protobuf, reconnect, auth) lives in WebSocketManager.
 */

import { useEffect } from 'react';
import { wsManager } from '../lib/WebSocketManager';
import { useWsConnected } from './useMarketData';

interface UseWsConnectionProps {
  token: string;
  instrumentKeys: string[];
  enabled: boolean;
}

export function useWsConnection({ token, instrumentKeys, enabled }: UseWsConnectionProps) {
  // Connect — idempotent if already open with same token
  useEffect(() => {
    if (!enabled || !token) return;
    wsManager.connect(token);
  }, [token, enabled]);

  // Subscribe keys whenever list changes
  const keysStr = instrumentKeys.slice().sort().join(',');
  useEffect(() => {
    if (!enabled || !token || instrumentKeys.length === 0) return;
    return wsManager.requestKeys(instrumentKeys);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysStr, enabled, token]);

  const isConnected = useWsConnected();
  return { isConnected };
}
