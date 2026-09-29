/**
 * Measurement script for the iOS in-app browser (native/ios/App/InAppBrowserViewController.swift).
 *
 * The app injects this file into chatgpt.com, claude.ai and gemini.google.com inside an isolated
 * WKContentWorld: the page's own scripts can't read its variables or reach its message handler.
 *
 * Privacy contract (same as the extension, enforced by scripts/check-privacy.mjs):
 * - Message text is read only inside the tracker and turned into numbers immediately.
 * - Only numbers are posted to the app (the entry plus its footprint for the live panel). Never text.
 * - No network access. The native side validates every field again before storing anything.
 */
import { compute, getModel } from '../../shared/core';
import { DEFAULT_SITE_MODEL } from './api';
import { adapterFor, createTracker } from './tracker';

interface NativeHandler { postMessage(body: unknown): void; }

const g = globalThis as unknown as { webkit?: { messageHandlers?: { promptFitness?: NativeHandler } } };
const handler = g.webkit?.messageHandlers?.promptFitness;
const adapter = adapterFor(location.hostname);

if (handler && adapter && window.top === window) {
  // Each site's default model, the same default the extension uses until the user picks another.
  const model = DEFAULT_SITE_MODEL[adapter.host];

  const tracker = createTracker(adapter, {
    src: 'inapp',
    modelId: () => model,
    report: async (entry) => {
      const fp = compute(getModel(entry.m), entry.i, entry.o);
      handler.postMessage({ type: 'log', entry, waterMl: fp.waterL * 1000, wh: fp.kWh * 1000, co2g: fp.co2g });
    },
  });
  handler.postMessage({ type: 'ready', model });
  tracker.start();
}
