/**
 * Thin, optional native bridges. Every function is a safe no-op on platforms
 * where the feature does not exist (web, or the other mobile OS).
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { sanitizeEntry, type LogEntry } from '../shared/core';

/** iOS only: reads entries the Safari extension wrote into the shared App Group. */
interface SharedLogPlugin {
  drain(): Promise<{ entries: unknown[] }>;
}
const SharedLog = registerPlugin<SharedLogPlugin>('SharedLog');

/** Android only: text shared into the app via the system share sheet. */
interface ShareIntentPlugin {
  getSharedText(): Promise<{ text?: string }>;
  addListener(event: 'shared', cb: (data: { text?: string }) => void): Promise<PluginListenerHandle>;
}
const ShareIntent = registerPlugin<ShareIntentPlugin>('ShareIntent');

const platform = (): string => Capacitor.getPlatform();

export async function drainExtensionEntries(): Promise<LogEntry[]> {
  if (platform() !== 'ios') return [];
  try {
    const { entries } = await SharedLog.drain();
    if (!Array.isArray(entries)) return [];
    return entries.map(sanitizeEntry).filter((e): e is LogEntry => e !== null);
  } catch {
    return [];
  }
}

const MAX_SHARED_CHARS = 20_000;

export async function initShareTarget(onText: (text: string) => void): Promise<void> {
  if (platform() !== 'android') return;
  const accept = (text?: string) => {
    if (typeof text === 'string' && text.trim()) onText(text.slice(0, MAX_SHARED_CHARS));
  };
  try {
    accept((await ShareIntent.getSharedText()).text);
    await ShareIntent.addListener('shared', (d) => accept(d.text));
  } catch { /* plugin not registered in this build */ }
}

export function onAppResume(cb: () => void): void {
  if (!Capacitor.isNativePlatform()) return;
  void App.addListener('appStateChange', ({ isActive }) => { if (isActive) cb(); });
}

export function onAppPause(cb: () => void): void {
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => { if (!isActive) cb(); });
  } else {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cb(); });
  }
}

export async function tapFeedback(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { await Haptics.impact({ style: ImpactStyle.Light }); } catch { /* no haptics hardware */ }
}

export const currentPlatform = platform;
