/**
 * instruments.worker
 * Runs JSON.parse + TextDecoder off the main thread so the UI never freezes.
 * Receives a Uint8Array (decompressed instruments JSON bytes), returns parsed array.
 */

self.onmessage = (e: MessageEvent<Uint8Array>) => {
  try {
    const json = JSON.parse(new TextDecoder().decode(e.data));
    self.postMessage({ ok: true, json });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
