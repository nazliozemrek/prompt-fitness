/**
 * Background service worker.
 * - Validates and stores numeric log entries sent by the content script.
 * - Serves the popup (summary, settings, clear).
 * - Safari only: forwards entries to the containing app through native messaging (App Group, on-device).
 * No network access: the extension CSP sets connect-src 'none'.
 */
import { dayStart, ecoFitness, pruneLog, sanitizeEntry, summarize, type LogEntry } from '../../shared/core';
import {
  KEYS, api, hostFromUrl, isSafari, readSettings, sanitizeSettings,
  type Message, type Response, type Settings, type SummaryResponse,
} from './api';

/* Serialize storage writes so concurrent messages can't lose entries. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function readLog(): Promise<LogEntry[]> {
  const res = await api.storage.local.get(KEYS.log);
  const raw = res[KEYS.log];
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEntry).filter((e): e is LogEntry => e !== null);
}

async function writeLog(log: LogEntry[]): Promise<void> {
  await api.storage.local.set({ [KEYS.log]: pruneLog(log) });
}

async function updateBadge(log?: LogEntry[], settings?: Settings): Promise<void> {
  try {
    const entries = log ?? (await readLog());
    const s = settings ?? (await readSettings());
    const today = summarize(entries.filter((e) => e.t >= dayStart()));
    const ml = today.waterL * 1000;
    const text = today.count === 0 ? '' : ml < 1000 ? `${Math.round(ml)}` : `${today.waterL.toFixed(1)}L`;
    const pct = s.budget > 0 ? today.waterL / s.budget : 0;
    await api.action.setBadgeText({ text });
    await api.action.setBadgeBackgroundColor({ color: pct > 1 ? '#ff7a7a' : pct >= 0.8 ? '#ffbe55' : '#1f9d6b' });
  } catch {
    /* badge APIs are best-effort (not shown on every platform) */
  }
}

async function forwardToApp(message: Record<string, unknown>): Promise<void> {
  if (!isSafari()) return;
  try {
    // In Safari the application identifier argument is ignored; the containing app receives the message.
    await (api.runtime as unknown as { sendNativeMessage(id: string, msg: unknown): Promise<unknown> })
      .sendNativeMessage('application.id', message);
  } catch {
    /* container app not reachable; entries remain in extension storage */
  }
}

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<Response> {
  if (sender.id !== api.runtime.id) return { ok: false, error: 'forbidden' };
  // Extension pages (popup) have an extension-origin URL; content scripts report the web page URL.
  const extOrigin = api.runtime.getURL('');
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(extOrigin);

  switch (msg?.type) {
    case 'log': {
      // Only content scripts on the three allowed sites may log.
      if (fromExtensionPage || !hostFromUrl(sender.url ?? sender.tab?.url)) return { ok: false, error: 'forbidden' };
      const entry = sanitizeEntry(msg.entry);
      if (!entry || entry.src !== 'extension') return { ok: false, error: 'invalid entry' };
      entry.t = Math.min(entry.t, Date.now());
      return serial(async () => {
        const settings = await readSettings();
        const log = await readLog();
        log.push(entry);
        await writeLog(log);
        await updateBadge(log, settings);
        await forwardToApp({ type: 'log', entry });
        return { ok: true } as const;
      });
    }

    case 'summary': {
      if (!fromExtensionPage) return { ok: false, error: 'forbidden' };
      const [log, settings] = await Promise.all([readLog(), readSettings()]);
      const today = log.filter((e) => e.t >= dayStart());
      const sum = summarize(today);
      const res: SummaryResponse = {
        ok: true, waterL: sum.waterL, kWh: sum.kWh, count: sum.count, avgScore: sum.avgScore,
        fitness: ecoFitness(sum, settings.budget), last: today[today.length - 1] ?? null, settings,
      };
      return res;
    }

    case 'updateSettings': {
      if (!fromExtensionPage) return { ok: false, error: 'forbidden' };
      return serial(async () => {
        const current = await readSettings();
        const next = sanitizeSettings({ ...current, ...(msg.patch ?? {}) });
        await api.storage.local.set({ [KEYS.settings]: next });
        await updateBadge(undefined, next);
        return { ok: true } as const;
      });
    }

    case 'clear': {
      if (!fromExtensionPage) return { ok: false, error: 'forbidden' };
      return serial(async () => {
        await api.storage.local.remove([KEYS.log]);
        await updateBadge([]);
        await forwardToApp({ type: 'clear' });
        return { ok: true } as const;
      });
    }

    default:
      return { ok: false, error: 'unknown message' };
  }
}

api.runtime.onMessage.addListener((msg: Message, sender: chrome.runtime.MessageSender, sendResponse: (r: Response) => void) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : 'error' }));
  return true; // keep the channel open for the async response (Chrome and Safari)
});

api.runtime.onInstalled.addListener(() => { void updateBadge(); });
api.runtime.onStartup?.addListener(() => { void updateBadge(); });
