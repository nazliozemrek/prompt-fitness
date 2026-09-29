/**
 * Content script for chatgpt.com, claude.ai and gemini.google.com.
 *
 * Privacy contract (enforced by code review and scripts/check-privacy.mjs):
 * - Message text is read only inside the tracker (tracker.ts) and turned into numbers immediately.
 * - Text is never stored, logged, posted, or passed to another context. Only a numeric LogEntry leaves this file.
 * - No network access; no code is injected into the page's own JavaScript context.
 */
import { compute, getModel, type LogEntry } from '../../shared/core';
import { KEYS, api, modelForHost, readSettings, sanitizeSettings, type Settings } from './api';
import { adapterFor, createTracker, type Adapter } from './tracker';

const adapter = adapterFor(location.hostname);
if (adapter) start(adapter);

function start(ad: Adapter): void {
  let settings: Settings = sanitizeSettings(undefined);
  const pill = createPill();
  const tracker = createTracker(ad, {
    src: 'extension',
    modelId: () => modelForHost(settings, ad.host),
    report: (entry) => api.runtime.sendMessage({ type: 'log', entry }).then(() => pill.flash(entry)),
  });

  function applySettings(): void {
    if (settings.paused.includes(ad.host)) {
      tracker.stop();
      pill.setVisible(false);
      return;
    }
    pill.setVisible(settings.showPill);
    tracker.start();
  }

  api.storage.onChanged.addListener((changes: { [key: string]: { newValue?: unknown } }, area: string) => {
    if (area !== 'local' || !changes[KEYS.settings]) return;
    settings = sanitizeSettings(changes[KEYS.settings]?.newValue);
    applySettings();
  });

  readSettings()
    .then((s) => { settings = s; applySettings(); })
    .catch(() => applySettings());
}

/* ---------------- On-page indicator (transparency) ---------------- */

interface Pill { setVisible(v: boolean): void; flash(e: LogEntry): void; }

function createPill(): Pill {
  const host = document.createElement('prompt-fitness-indicator');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .pill {
      position: fixed; left: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
      font: 500 11px/1.2 ui-sans-serif, -apple-system, system-ui, sans-serif;
      color: #d9fbe9; background: rgba(6,10,16,.82); border: 1px solid rgba(78,240,168,.35);
      box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: none; opacity: .75; transition: opacity .3s ease;
    }
    .pill.active { opacity: 1; }
    @media (prefers-color-scheme: light) {
      .pill { color: #064e3b; background: rgba(255,255,255,.92); border-color: rgba(16,185,129,.4); }
    }
    @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
  `;
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  const idle = '🌱 Prompt Fitness is measuring on this device';
  pill.textContent = idle;
  root.append(style, pill);

  let mounted = false;
  let timer: number | undefined;
  return {
    setVisible(v) {
      if (v && !mounted) { document.documentElement.appendChild(host); mounted = true; }
      if (!v && mounted) { host.remove(); mounted = false; }
    },
    flash(e) {
      if (!mounted) return;
      const ml = compute(getModel(e.m), e.i, e.o).waterL * 1000;
      pill.textContent = `🌱 +${ml < 10 ? ml.toFixed(1) : Math.round(ml)} mL` + (e.s !== null ? `, prompt score ${e.s}` : '');
      pill.classList.add('active');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { pill.textContent = idle; pill.classList.remove('active'); }, 5000);
    },
  };
}
