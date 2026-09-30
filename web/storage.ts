/**
 * On-device persistence for the dashboard.
 *
 * - Native (iOS/Android): @capacitor/preferences → UserDefaults / SharedPreferences.
 *   WKWebView localStorage can be evicted by iOS under storage pressure, so it is not used natively.
 * - Web: localStorage, wrapped in try/catch (private mode, quota, disabled storage).
 *
 * Only numeric metadata is ever stored (see LogEntry in shared/core.ts). Prompt text is never persisted.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { pruneLog, sanitizeEntry, sanitizeLifetime, seedLifetime, type Lifetime, type LogEntry } from '../shared/core';

export const KEYS = Object.freeze({
  log: 'pf.log.v1',
  budget: 'pf.budget.v1',
  seeded: 'pf.seeded.v1',
  migrated: 'pf.migrated.v1',
  /** Lifetime counters for streaks and milestones (numbers only). */
  lifetime: 'pf.lifetime.v1',
});

export interface KV {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

const parse = <T>(value: string | null, fallback: T): T => {
  if (value == null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const nativeKV: KV = {
  async get(key, fallback) {
    const { value } = await Preferences.get({ key });
    return parse(value, fallback);
  },
  async set(key, value) {
    await Preferences.set({ key, value: JSON.stringify(value) });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
};

const webKV: KV = {
  async get(key, fallback) {
    try { return parse(localStorage.getItem(key), fallback); } catch { return fallback; }
  },
  async set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: state stays in memory */ }
  },
  async remove(key) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  },
};

export const isNative = (): boolean => Capacitor.isNativePlatform();
export const kv: KV = isNative() ? nativeKV : webKV;

/** One-time move of data written by the web prototype (localStorage) into Preferences. */
async function migrateFromLocalStorage(): Promise<void> {
  if (!isNative()) return;
  if (await kv.get<boolean>(KEYS.migrated, false)) return;
  for (const key of [KEYS.log, KEYS.budget, KEYS.seeded, KEYS.lifetime]) {
    const legacy = await webKV.get<unknown>(key, undefined);
    const existing = await kv.get<unknown>(key, undefined);
    if (legacy !== undefined && existing === undefined) await kv.set(key, legacy);
    await webKV.remove(key);
  }
  await kv.set(KEYS.migrated, true);
}

export function sanitizeLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  for (const item of raw) {
    const e = sanitizeEntry(item);
    if (e) out.push(e);
  }
  return pruneLog(out);
}

export async function loadLog(): Promise<LogEntry[] | null> {
  await migrateFromLocalStorage();
  const raw = await kv.get<unknown>(KEYS.log, null);
  return raw === null ? null : sanitizeLog(raw);
}

let pendingWrite: ReturnType<typeof setTimeout> | undefined;
let pendingLog: LogEntry[] | null = null;

/** Debounced write-through. In-memory state is authoritative; call flushLog() before the app backgrounds. */
export function saveLog(log: LogEntry[]): void {
  pendingLog = log;
  clearTimeout(pendingWrite);
  pendingWrite = setTimeout(() => { void flushLog(); }, 250);
}

export async function flushLog(): Promise<void> {
  clearTimeout(pendingWrite);
  if (!pendingLog) return;
  const snapshot = pruneLog(pendingLog);
  pendingLog = null;
  await kv.set(KEYS.log, snapshot);
}

/** Lifetime counters; on first use they're rebuilt from the stored log so existing history counts. */
export async function loadLifetime(log: readonly LogEntry[]): Promise<Lifetime> {
  const raw = await kv.get<unknown>(KEYS.lifetime, null);
  if (raw !== null) return sanitizeLifetime(raw);
  const seeded = seedLifetime(log);
  await kv.set(KEYS.lifetime, seeded);
  return seeded;
}

export const saveLifetime = (l: Lifetime): Promise<void> => kv.set(KEYS.lifetime, l);

export const BUDGET_OPTIONS = [0.5, 1, 2, 3] as const;

export async function loadBudget(): Promise<number> {
  const v = await kv.get<number>(KEYS.budget, 1);
  return (BUDGET_OPTIONS as readonly number[]).includes(v) ? v : 1;
}

export const saveBudget = (v: number): Promise<void> => kv.set(KEYS.budget, v);
export const wasSeeded = (): Promise<boolean> => kv.get<boolean>(KEYS.seeded, false);
export const markSeeded = (): Promise<void> => kv.set(KEYS.seeded, true);

/** Deletes every value this app has stored on the device. */
export async function eraseAllLocalData(): Promise<void> {
  clearTimeout(pendingWrite);
  pendingLog = null;
  await Promise.all([KEYS.log, KEYS.budget, KEYS.lifetime].map((k) => kv.remove(k)));
  await markSeeded(); // don't re-insert demo data after an explicit wipe
}
