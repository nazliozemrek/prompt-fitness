#!/usr/bin/env node
/**
 * Release gate: verifies the built artifacts can't transmit data.
 * Fails (exit 1) on any violation. Run after `npm run build`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (file, msg) => problems.push(`✗ ${file}: ${msg}`);

const NETWORK_APIS = [
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bsendBeacon\b/, /\bEventSource\b/,
  /\bimportScripts\s*\(/, /\bnew\s+Worker\s*\(/, /\beval\s*\(/, /\bnew\s+Function\s*\(/,
];
const EXTERNAL_URL = /https?:\/\/(?!www\.w3\.org\/)[a-z0-9.-]+\.[a-z]{2,}/i;
const ALLOWED_EXT_URLS = /https:\/\/(chatgpt\.com|claude\.ai|gemini\.google\.com)\//;

/* 1. Extensions: zero network APIs, zero external URLs except the three match patterns in the manifest. */
for (const flavor of ['chrome', 'safari', 'firefox']) {
  const dir = join(root, 'build', `extension-${flavor}`);
  if (!existsSync(dir)) { fail(dir, 'missing, run `npm run build` first'); continue; }
  for (const f of ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css']) {
    const text = await readFile(join(dir, f), 'utf8');
    for (const re of NETWORK_APIS) if (re.test(text)) fail(`${flavor}/${f}`, `uses ${re}`);
    const url = text.match(EXTERNAL_URL);
    if (url) fail(`${flavor}/${f}`, `references external URL ${url[0]}`);
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const perms = new Set(manifest.permissions ?? []);
  // activeTab grants no install-time access; it only lets the popup read the current tab's URL after a click.
  const allowedPerms = flavor === 'safari' ? ['storage', 'activeTab', 'nativeMessaging'] : ['storage', 'activeTab'];
  for (const p of perms) if (!allowedPerms.includes(p)) fail(`${flavor}/manifest.json`, `unexpected permission "${p}"`);
  if (manifest.host_permissions?.length) fail(`${flavor}/manifest.json`, 'host_permissions must stay empty (content_scripts matches only)');
  for (const cs of manifest.content_scripts ?? []) {
    for (const m of cs.matches) if (!ALLOWED_EXT_URLS.test(m)) fail(`${flavor}/manifest.json`, `unexpected match pattern ${m}`);
  }
  if (!/connect-src 'none'/.test(manifest.content_security_policy?.extension_pages ?? '')) {
    fail(`${flavor}/manifest.json`, "extension_pages CSP must include connect-src 'none'");
  }
}

/* 2. Web dashboard: CSP present, no external resources. */
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  fail('dist/index.html', 'missing, run `npm run build` first');
} else {
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  if (!/connect-src 'self'/.test(html)) fail('dist/index.html', "CSP must restrict connect-src to 'self'");
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) fail('dist/index.html', 'inline <script> found (CSP forbids it)');
  if (/\binapp\.js\b/.test(html)) fail('dist/index.html', 'must not load the in-app browser script');
  const ext = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\//gi)];
  if (ext.length) fail('dist/index.html', 'loads an external resource');
  for (const f of (await readdir(dist)).filter((n) => n.endsWith('.css'))) {
    const css = await readFile(join(dist, f), 'utf8');
    if (/url\(\s*["']?(https?:)?\/\//i.test(css) || /@import\s+url\(\s*["']?https?:/i.test(css)) fail(`dist/${f}`, 'external url() in CSS');
  }
}

/* 3. In-app browser script (injected by the iOS app into the three chat sites): same rules as the extensions. */
const inapp = join(dist, 'inapp.js');
if (!existsSync(inapp)) {
  fail('dist/inapp.js', 'missing, run `npm run build` first');
} else {
  const text = await readFile(inapp, 'utf8');
  for (const re of NETWORK_APIS) if (re.test(text)) fail('dist/inapp.js', `uses ${re}`);
  const url = text.match(EXTERNAL_URL);
  if (url) fail('dist/inapp.js', `references external URL ${url[0]}`);
}

/* 4. Share extension coaching bundle (JavaScriptCore): no network APIs, no external URLs. */
const coachJs = join(root, 'build', 'share', 'coach.js');
if (!existsSync(coachJs)) {
  fail('build/share/coach.js', 'missing, run `npm run build` first');
} else {
  const text = await readFile(coachJs, 'utf8');
  for (const re of NETWORK_APIS) if (re.test(text)) fail('build/share/coach.js', `uses ${re}`);
  const url = text.match(EXTERNAL_URL);
  if (url) fail('build/share/coach.js', `references external URL ${url[0]}`);
}

/* 5. Capacitor config: bundled assets only. */
const cap = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
if (cap.server?.url) fail('capacitor.config.json', 'server.url must not be set for release builds');
if (cap.plugins?.CapacitorHttp?.enabled) fail('capacitor.config.json', 'CapacitorHttp must stay disabled');
if (cap.android?.webContentsDebuggingEnabled || cap.ios?.webContentsDebuggingEnabled) fail('capacitor.config.json', 'web debugging must be off in release');

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nPrivacy check failed with ${problems.length} problem(s).`);
  process.exit(1);
}
console.log('✓ Privacy check passed: no network APIs in extensions, no external resources, bundled-only app.');
