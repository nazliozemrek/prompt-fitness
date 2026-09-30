/**
 * Reply tracker shared by the browser extension (content.ts) and the iOS in-app browser (inapp.ts).
 *
 * Privacy contract (enforced by code review and scripts/check-privacy.mjs):
 * - Message text is read from the page ONLY inside logExchange and turned into numbers immediately.
 * - Text is never stored, logged, posted, or passed to another context. Only a numeric LogEntry leaves this file.
 * - No network access.
 *
 * Counting rule: a reply is counted once, when it was observed GROWING (i.e. streamed live in this tab)
 * and has then been stable for STABLE_MS. Replies that render complete at once (conversation history,
 * re-renders, navigation to an old chat) are never counted, which prevents double counting.
 */
import { C, analyze, estTokens, getModel, type EntrySource, type LogEntry, type ModelId } from '../../shared/core';
import { isAllowedHost, type AllowedHost } from './api';

export interface Adapter {
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
    // data-message-role: 2026 layout (mobile web, signed-out); data-message-author-role: earlier layout.
    user: ['[data-message-role="user"]', '[data-message-author-role="user"]'],
    assistant: ['[data-message-role="assistant"]', '[data-message-author-role="assistant"]'],
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

export const adapterFor = (hostname: string): Adapter | undefined =>
  isAllowedHost(hostname) ? ADAPTERS.find((a) => a.host === hostname) : undefined;

const STABLE_MS = 1800;
const SCAN_DEBOUNCE_MS = 400;
const STARTUP_SETTLE_MS = 4000;

interface Track { len: number; grew: boolean; stableSince: number; counted: boolean; }
interface Item { el: Element; role: 'user' | 'assistant'; }

export interface TrackerOptions {
  src: EntrySource;
  /** Model to attribute the next reply to (read at count time, so setting changes apply immediately). */
  modelId: () => ModelId;
  /** Receives each numeric entry. Rejections are ignored (the receiver may be gone). */
  report: (entry: LogEntry) => Promise<void>;
}

export interface Tracker { start(): void; stop(): void; }

export function createTracker(ad: Adapter, opts: TrackerOptions): Tracker {
  const tracked = new WeakMap<Element, Track>();
  const startedAt = performance.now();
  let observer: MutationObserver | null = null;
  let scanTimer: number | undefined;
  let tickTimer: number | undefined;

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
    if (!observer) return;
    const items = collect();
    const now = performance.now();
    let pending = false;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!item || item.role !== 'assistant') continue;
      const len = textOf(item.el).length;
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
    const textAt = (k: number): string => { const it = items[k]; return it ? textOf(it.el) : ''; };
    const promptText = u >= 0 ? textAt(u) : '';
    let history = 0;
    for (let k = 0; k < (u >= 0 ? u : idx); k++) history += estTokens(textAt(k));
    history = Math.min(C.MAX_TOKENS, history);

    const model = getModel(opts.modelId());
    const a = analyze(promptText, model, 'auto', history);
    const visible = estTokens(textAt(idx));
    if (visible === 0) return;
    const output = Math.min(C.MAX_TOKENS, model.reasoning ? visible * C.REASONING_MULT : visible);

    const entry: LogEntry = {
      t: Date.now(),
      m: model.id,
      i: a ? a.inputTok : history,
      o: output,
      s: a ? a.score : null,
      f: a ? a.fit : null,
      src: opts.src,
    };
    opts.report(entry).catch(() => { /* receiver unavailable */ });
  }

  function scheduleScan(): void {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(scan, SCAN_DEBOUNCE_MS);
  }
  function scheduleTick(): void {
    window.clearTimeout(tickTimer);
    tickTimer = window.setTimeout(scan, STABLE_MS / 2);
  }

  return {
    start() {
      if (observer) return;
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleScan();
    },
    stop() {
      observer?.disconnect();
      observer = null;
    },
  };
}

const NON_TEXT = 'script, style, template, noscript';

/**
 * The message's readable text. Skips script/style/template/noscript content, which textContent would include
 * (ChatGPT, for example, embeds large JSON <script> blocks inside reply elements).
 */
function textOf(el: Element): string {
  if (!el.querySelector(NON_TEXT)) return el.textContent ?? '';
  let out = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest(NON_TEXT)) out += n.nodeValue ?? '';
  }
  return out;
}

/** Keep only elements not nested inside another match (avoids counting wrappers twice). */
function outermost(list: Element[]): Element[] {
  return list.filter((el) => !list.some((other) => other !== el && other.contains(el)));
}
