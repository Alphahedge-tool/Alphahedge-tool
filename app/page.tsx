"use client";

import dynamic from "next/dynamic";

// Mount the entire trading app with no SSR.
// All features (Web Workers, IndexedDB, localStorage, WebSocket,
// AmCharts, Lightweight Charts) require browser APIs — SSR is disabled.
const App = dynamic(() => import("../src/App"), { ssr: false });

export default function Page() {
  return <App />;
}
