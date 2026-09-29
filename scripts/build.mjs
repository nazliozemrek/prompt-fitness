#!/usr/bin/env node
/**
 * Build script.
 *   node scripts/build.mjs                  → web dashboard (dist/) + all extensions (build/)
 *   node scripts/build.mjs --target=web     → dist/ only (run `npm run build:css` first)
 *   node scripts/build.mjs --target=extension
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.find((a) => a.startsWith('--target='));
const target = arg ? arg.split('=')[1] : 'all';
const production = process.env.NODE_ENV !== 'development';

const common = {
  bundle: true,
  format: 'iife',
  minify: production,
  sourcemap: production ? false : 'inline',
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
};

async function buildWeb() {
  const out = join(root, 'dist');
  await mkdir(out, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(root, 'web/app.ts')],
    outfile: join(out, 'app.js'),
    target: ['es2020', 'safari14', 'chrome100'],
  });
  await cp(join(root, 'web/index.html'), join(out, 'index.html'));
  await cp(join(root, 'web/favicon.png'), join(out, 'favicon.png'));
  if (!existsSync(join(out, 'styles.css'))) {
    console.warn('⚠ dist/styles.css missing. Run `npm run build:css` (included in `npm run build`).');
  }
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

async function buildExtension(flavor) {
  const src = join(root, 'extension');
  const out = join(root, 'build', `extension-${flavor}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const targets = { chrome: ['es2020', 'chrome116'], safari: ['es2020', 'safari16'], firefox: ['es2020', 'firefox121'] }[flavor];
  await build({
    ...common,
    entryPoints: {
      background: join(src, 'src/background.ts'),
      content: join(src, 'src/content.ts'),
      popup: join(src, 'src/popup.ts'),
    },
    outdir: out,
    target: targets,
  });
  for (const f of ['popup.html', 'popup.css']) await cp(join(src, f), join(out, f));
  await cp(join(src, 'icons'), join(out, 'icons'), { recursive: true });

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const base = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  const patch = JSON.parse(await readFile(join(src, `manifest.${flavor}.json`), 'utf8'));
  const manifest = merge(base, patch);
  manifest.version = pkg.version;
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ build/extension-${flavor}`);
}

if (target === 'all' || target === 'web') await buildWeb();
if (target === 'all' || target === 'extension') {
  await buildExtension('chrome');
  await buildExtension('safari');
  await buildExtension('firefox');
}
