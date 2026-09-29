/**
 * Cross-browser extension helpers shared by background, content and popup scripts.
 * Safari exposes the promise-based `browser` namespace; Chrome MV3 exposes promise-returning `chrome`.
 */
import { isModelId, type LogEntry, type ModelId } from '../../shared/core';

type ExtApi = typeof chrome;
const g = globalThis as unknown as { browser?: ExtApi; chrome?: ExtApi };
export const api: ExtApi = (g.browser ?? g.chrome) as ExtApi;

export const isSafari = (): boolean => api.runtime.getURL('').startsWith('safari-web-extension:');

export const ALLOWED_HOSTS = ['chatgpt.com', 'claude.ai', 'gemini.google.com'] as const;
export type AllowedHost = (typeof ALLOWED_HOSTS)[number];
export const isAllowedHost = (h: string): h is AllowedHost => (ALLOWED_HOSTS as readonly string[]).includes(h);

export function hostFromUrl(url: string | undefined): AllowedHost | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return isAllowedHost(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

export const KEYS = Object.freeze({ log: 'pf.log.v1', settings: 'pf.settings.v1' });

export interface Settings {
  paused: AllowedHost[];
  siteModels: Partial<Record<AllowedHost, ModelId>>;
  showPill: boolean;
  budget: number;
}

export const DEFAULT_SITE_MODEL: Record<AllowedHost, ModelId> = {
  'chatgpt.com': 'gpt4o',
  'claude.ai': 'sonnet',
  'gemini.google.com': 'gemini-pro',
};

export const DEFAULT_SETTINGS: Settings = Object.freeze({ paused: [], siteModels: {}, showPill: true, budget: 1 }) as Settings;
const BUDGETS = [0.5, 1, 2, 3];

export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const paused = Array.isArray(r.paused) ? r.paused.filter((h): h is AllowedHost => typeof h === 'string' && isAllowedHost(h)) : [];
  const siteModels: Settings['siteModels'] = {};
  if (r.siteModels && typeof r.siteModels === 'object') {
    for (const [h, m] of Object.entries(r.siteModels as Record<string, unknown>)) {
      if (isAllowedHost(h) && isModelId(m)) siteModels[h] = m;
    }
  }
  const budget = typeof r.budget === 'number' && BUDGETS.includes(r.budget) ? r.budget : 1;
  return { paused: [...new Set(paused)], siteModels, showPill: r.showPill !== false, budget };
}

export async function readSettings(): Promise<Settings> {
  const res = await api.storage.local.get(KEYS.settings);
  return sanitizeSettings(res[KEYS.settings]);
}

export const modelForHost = (s: Settings, host: AllowedHost): ModelId => s.siteModels[host] ?? DEFAULT_SITE_MODEL[host];

/* ---------------- Messages ---------------- */

export type Message =
  | { type: 'log'; entry: LogEntry }
  | { type: 'summary' }
  | { type: 'updateSettings'; patch: Partial<Settings> }
  | { type: 'clear' };

export interface SummaryResponse {
  ok: true;
  waterL: number;
  kWh: number;
  count: number;
  avgScore: number | null;
  fitness: number | null;
  last: LogEntry | null;
  settings: Settings;
}

export type Response = SummaryResponse | { ok: true } | { ok: false; error: string };
