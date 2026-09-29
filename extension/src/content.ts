/**
 * Content script for chatgpt.com, claude.ai and gemini.google.com.
 *
 * Privacy contract (enforced by code review and scripts/check-privacy.mjs):
 * - Message text is read from the page ONLY inside measure functions and turned into numbers immediately.
 * - Text is never stored, logged, posted, or passed to another context. Only a numeric LogEntry leaves this file.
 * - No network access; no code is injected into the page's own JavaScript context.
 *
 * Counting rule: a reply is counted once, when it was observed GROWING (i.e. streamed live in this tab)
 * and has then been stable for STABLE_MS. Replies that render complete at once (conversation history,
 * re-renders, navigation to an old chat) are never counted, which prevents double counting.
 */
import { C, analyze, compute, estTokens, getModel, type LogEntry } from '../../shared/core';
import {
  KEYS, api, isAllowedHost, modelForHost, readSettings, sanitizeSettings,
  type AllowedHost, type Settings,
} from './api';

interface Adapter {
  host: AllowedHost;
  /** Selector lists are tried in order; the first one that matches anything is used. */
  user: string[];
  assistant: string[];
  isStreaming: (el: Element) => boolean;
}

/*
 * DOM selectors for each site. These sites change their markup over time:
 * keep these lists up to date (see README, "Maintaining selectors").
 */
const ADAPTERS: readonly Adapter[] = [
  {
    host: 'chatgpt.com',
    user: ['[data-message-author-role="user"]'],
    assistant: ['[data-message-author-role="assistant"]'],
    isStreaming: () =>
      document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]') !== null,
  },
  {
    host: 'claude.ai',
    user: ['[data-testid="user-message"]'],
    assistant: ['[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
    isStreaming: (el) =>
      el.getAttribute('data-is-streaming') === 'true' || el.closest('[data-is-streaming="true"]') !== null,
  },
  {
    host: 'gemini.google.com',
    user: ['user-query'],
    assistant: ['model-response'],
    isStreaming: () => document.querySelector('button[aria-label="Stop response"]') !== null,
  },
];

const STABLE_MS = 1800;
const SCAN_DEBOUNCE_MS = 400;
const STARTUP_SETTLE_MS = 4000;

interface Track { len: number; grew: boolean; stableSince: number; counted: boolean; }
interface Item { el: Element; role: 'user' | 'assistant'; }

const hostname = location.hostname;
const adapter = isAllowedHost(hostname) ? ADAPTERS.find((a) => a.host === hostname) : undefined;
if (adapter) start(adapter);

function start(ad: Adapter): void {
  let settings: Settings = sanitizeSettings(undefined);
  const tracked = new WeakMap<Element, Track>();
  const startedAt = performance.now();
  let observer: MutationObserver | null = null;
  let scanTimer: number | undefined;
  let tickTimer: number | undefined;
  const pill = createPill();

  const isPaused = () => settings.paused.includes(ad.host);

  const firstMatch = (selectors: string[]): Element[] => {
    for (const s of selectors) {
      const list = Array.from(document.querySelectorAll(s));
      if (list.length) return outermost(list);
    }
    return [];
  };

  function collect(): Item[] {
    const items: Item[] = [
      ...firstMatch(ad.user).map((el) => ({ el, role: 'user' as const })),
      ...firstMatch(ad.assistant).map((el) => ({ el, role: 'assistant' as const })),
    ];
    return items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function scan(): void {
    scanTimer = undefined;
    if (isPaused()) return;
    const items = collect();
    const now = performance.now();
    let pending = false;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!item || item.role !== 'assistant') continue;
      const len = (item.el.textContent ?? '').length;
      let st = tracked.get(item.el);

      if (!st) {
        // Anything already on the page right after load is history: baseline it.
        const baseline = now - startedAt < STARTUP_SETTLE_MS && len > 0;
        st = { len, grew: false, stableSince: now, counted: baseline };
        tracked.set(item.el, st);
        if (!baseline) pending = true;
        continue;
      }
      if (st.counted) continue;
      if (len !== st.len) {
        if (len > st.len) st.grew = true;
        st.len = len;
        st.stableSince = now;
        pending = true;
        continue;
      }
      if (!st.grew) continue;
      if (ad.isStreaming(item.el) || now - st.stableSince < STABLE_MS) { pending = true; continue; }

      st.counted = true;
      logExchange(items, idx);
    }
    if (pending) scheduleTick();
  }

  function logExchange(items: Item[], idx: number): void {
    // Text is read and converted to numbers inside this function only.
    let u = idx - 1;
    while (u >= 0 && items[u]?.role !== 'user') u--;
    const promptText = u >= 0 ? items[u]?.el.textContent ?? '' : '';
    let history = 0;
    for (let k = 0; k < (u >= 0 ? u : idx); k++) history += estTokens(items[k]?.el.textContent);
    history = Math.min(C.MAX_TOKENS, history);

    const model = getModel(modelForHost(settings, ad.host));
    const a = analyze(promptText, model, 'auto', history);
    const visible = estTokens(items[idx]?.el.textContent);
    if (visible === 0) return;
    const output = Math.min(C.MAX_TOKENS, model.reasoning ? visible * C.REASONING_MULT : visible);

    const entry: LogEntry = {
      t: Date.now(),
      m: model.id,
      i: a ? a.inputTok : history,
      o: output,
      s: a ? a.score : null,
      f: a ? a.fit : null,
      src: 'extension',
    };
    api.runtime.sendMessage({ type: 'log', entry })
      .then(() => pill.flash(entry))
      .catch(() => { /* extension reloaded or service worker unavailable */ });
  }

  function scheduleScan(): void {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(scan, SCAN_DEBOUNCE_MS);
  }
  function scheduleTick(): void {
    window.clearTimeout(tickTimer);
    tickTimer = window.setTimeout(scan, STABLE_MS / 2);
  }

  function applySettings(): void {
    if (isPaused()) {
      observer?.disconnect();
      observer = null;
      pill.setVisible(false);
      return;
    }
    pill.setVisible(settings.showPill);
    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleScan();
    }
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

/** Keep only elements not nested inside another match (avoids counting wrappers twice). */
function outermost(list: Element[]): Element[] {
  return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
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
