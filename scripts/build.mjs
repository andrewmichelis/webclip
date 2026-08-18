// WebClip build — bundles the MV3 extension into dist/ with esbuild.
// No runtime CDN, no remote code. Entry points are bundled self-contained
// (MV3 service workers do not support code-splitting). Version is injected from package.json
// so the product version has a single source.
import { build } from 'esbuild';
import { readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Bundle TS entry points -> dist/*.js
await build({
  entryPoints: {
    'service-worker': resolve(src, 'background/service-worker.ts'),
    'popup': resolve(src, 'popup/popup.ts'),
    'options': resolve(src, 'options/options.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
  define: { __VERSION__: JSON.stringify(VERSION) },
});

// 1b. Content controller as a classic (IIFE) script — injected via chrome.scripting, not an ES module.
await build({
  entryPoints: { 'page-controller': resolve(src, 'content/page-controller.ts') },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
  define: { __VERSION__: JSON.stringify(VERSION) },
});

// 2. Copy static UI assets
for (const f of ['popup/popup.html', 'popup/popup.css', 'options/options.html', 'options/options.css']) {
  const base = f.split('/').pop();
  await cp(resolve(src, f), resolve(dist, base));
}

// 3. Icons
if (existsSync(resolve(src, 'assets/icons'))) {
  await cp(resolve(src, 'assets/icons'), resolve(dist, 'icons'), { recursive: true });
}

// 4. Manifest with injected version (single source of truth = package.json)
const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
manifest.version = VERSION;
await writeFile(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`WebClip build OK -> dist/  (v${VERSION})`);
