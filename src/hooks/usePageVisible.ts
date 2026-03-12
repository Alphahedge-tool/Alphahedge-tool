'use client';

import { useEffect, useRef } from 'react';
import { wsManager } from '../lib/WebSocketManager';

/**
 * Call this in any component that has WS subscriptions.
 *
 * - When `visible` flips false  → releaseKeys so the server stops pushing ticks
 *   for this page (saves bandwidth / Upstox subscription quota).
 * - When `visible` flips true   → re-requestKeys + call `onReconnect` so the
 *   component can reload REST candles and resubscribe its own WS callbacks.
 *
 * `getKeys`   – function that returns the current set of subscribed instrument keys.
 * `onReconnect` – callback fired when page becomes visible again (re-fetch + re-sub).
 */
export function usePageVisible(
  visible: boolean,
  getKeys: () => string[],
  onReconnect: () => void,
) {
  const prevVisible = useRef(visible);

  useEffect(() => {
    const was = prevVisible.current;
    prevVisible.current = visible;

    if (was && !visible) {
      // Page hidden — release WS keys
      const keys = getKeys();
      if (keys.length > 0) wsManager.releaseKeys(keys);
    } else if (!was && visible) {
      // Page visible again — re-request keys and reload chart data
      const keys = getKeys();
      if (keys.length > 0) wsManager.requestKeys(keys);
      onReconnect();
    }
  // visible is the only real dep — getKeys/onReconnect should be stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
}
