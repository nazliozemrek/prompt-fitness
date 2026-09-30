/**
 * Thin, optional native bridges. Every function is a safe no-op on platforms
 * where the feature does not exist (web, or the other mobile OS).
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { sanitizeEntry, type LogEntry } from '../shared/core';

/** iOS only: reads entries the Safari extension and the in-app browser wrote into the shared App Group. */
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

/** iOS only: in-app browser for the three chat sites, and the Safari extension settings shortcut. */
export type InAppSite = 'chatgpt.com' | 'claude.ai' | 'gemini.google.com';
interface InAppBrowserPlugin {
  open(options: { site: InAppSite }): Promise<void>;
  openExtensionSettings(): Promise<{ opened: boolean; target: 'safari' | 'app' | 'none' }>;
  addListener(event: 'closed', cb: (data: { counted?: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'entry', cb: (data: { entry?: unknown }) => void): Promise<PluginListenerHandle>;
}
const InAppBrowser = registerPlugin<InAppBrowserPlugin>('InAppBrowser');

const platform = (): string => Capacitor.getPlatform();

export const hasInAppBrowser = (): boolean => platform() === 'ios';

/** Opens the in-app browser. Resolves false where it isn't available (web, Android, older builds). */
export async function openInAppBrowser(site: InAppSite): Promise<boolean> {
  if (!hasInAppBrowser()) return false;
  try {
    await InAppBrowser.open({ site });
    return true;
  } catch {
    return false;
  }
}

export function onInAppBrowserClosed(cb: (counted: number) => void): void {
  if (!hasInAppBrowser()) return;
  InAppBrowser.addListener('closed', (d) => cb(Number.isInteger(d.counted) ? (d.counted as number) : 0))
    .catch(() => { /* plugin not registered in this build */ });
}

/** Each reply counted in the in-app browser, validated again here before it reaches the log. */
export function onInAppEntry(cb: (entry: LogEntry) => void): void {
  if (!hasInAppBrowser()) return;
  InAppBrowser.addListener('entry', (d) => {
    const e = sanitizeEntry(d.entry);
    if (e && e.src === 'inapp') cb(e);
  }).catch(() => { /* plugin not registered in this build */ });
}

/** Where the settings shortcut landed: Safari's extension list (iOS 26.2+), this app's settings page, or nowhere. */
export async function openSafariExtensionSettings(): Promise<'safari' | 'app' | 'none'> {
  if (platform() !== 'ios') return 'none';
  try {
    const r = await InAppBrowser.openExtensionSettings();
    return r.opened ? r.target : 'none';
  } catch {
    return 'none';
  }
}

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
