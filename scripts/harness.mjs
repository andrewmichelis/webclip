#!/usr/bin/env node
// harness.mjs — end-to-end headless verification of WebClip: loads the extension in
// headless Chromium, captures a committed fixture page in multiple modes, and asserts each PDF with
// verify-pdf.mjs. Fully automated. Exit 0 = pass, 1 = fail.
//
// A TEST-ONLY build (dist-test/) adds a host permission for the loopback fixture origin so capture
// works without a toolbar-click activeTab grant. The shipped dist/ is never modified.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[1], '../..');
const dist = resolve(root, 'dist');
const distTest = resolve(root, 'dist-test');
const fixture = readFileSync(resolve(root, 'tests/fixtures/sample.html'));
const PORT = 8899;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (...a) => console.log(...a);

// 1. Build + make the test build (dist-test = dist + a loopback host permission).
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
if (existsSync(distTest)) rmSync(distTest, { recursive: true, force: true });
cpSync(dist, distTest, { recursive: true });
const mani = JSON.parse(readFileSync(resolve(distTest, 'manifest.json'), 'utf8'));
// TEST ONLY (never shipped): captureVisibleTab needs <all_urls> or a gesture-granted activeTab; the
// harness has no toolbar-click gesture, so the test build gets <all_urls>. dist/ stays permission-clean.
mani.host_permissions = ['<all_urls>'];
writeFileSync(resolve(distTest, 'manifest.json'), JSON.stringify(mani));

// 2. Serve the fixture on loopback.
const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixture); });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${PORT}/sample.html`;

const userDir = mkdtempSync(tmpdir() + '/wc-harness-');
const dlDir = mkdtempSync(tmpdir() + '/wc-dl-');
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${distTest}`, `--load-extension=${distTest}`, '--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  // 3. Service worker + extension id.
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  log(`extension loaded: ${extId}`);

  // 4. Force downloads to a known dir (extension chrome.downloads.download).
  const cdp = await ctx.newCDPSession(await ctx.newPage());
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

  // 5. Open the fixture (the tab we want captured) at a fixed viewport for deterministic pagination.
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(fixtureUrl, { waitUntil: 'load' });
  await page.bringToFront();
  await sleep(300);

  const modes = [
    { name: 'AUTO', settings: { paperSize: 'AUTO' }, verify: ['--expect-links', '--min-pages', '1'] },
    { name: 'A4', settings: { paperSize: 'A4' }, verify: ['--expect-links', '--breaks', '--min-pages', '2'] },
  ];
  for (const m of modes) {
    for (const f of readdirSync(dlDir)) rmSync(resolve(dlDir, f), { force: true }); // each capture downloads as download.pdf
    // Ensure the fixture tab is the active tab, then trigger capture from the popup context.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
    // Re-activate the fixture tab (opening the popup page stole focus) so the screenshot targets it.
    await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      if (t) await chrome.tabs.update(t.id, { active: true });
    }, fixtureUrl);
    await sleep(200);
    // Send START_CAPTURE with the mode's settings, layered over defaults, from the popup (an extension context).
    await popup.evaluate((settings) => chrome.runtime.sendMessage({ type: 'START_CAPTURE', settings }), {
      captureMode: 'full-page', orientation: 'auto', imageFormat: 'png', jpegQuality: 0.92,
      evidenceMode: false, saveChecksum: false, warmupLazyContent: true, suppressAnimations: true,
      suppressRepeatedFixedElements: true, declutter: true, stamp: false, links: true, debugTiles: false,
      filenameTemplate: 'harness_{title}_{date}_{time}', ...m.settings,
    });

    // Wait for the PDF to land in the download dir.
    let pdf = null;
    for (let i = 0; i < 60 && !pdf; i++) {
      await sleep(500);
      const now = readdirSync(dlDir).filter((f) => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
      if (now.length) pdf = resolve(dlDir, now[0]);
    }
    await popup.close();
    if (!pdf) { log(`  ${m.name}: FAIL — no PDF produced`); failed = true; continue; }
    log(`  ${m.name}: captured ${pdf}`);
    try {
      execFileSync('node', [resolve(root, 'scripts/verify-pdf.mjs'), pdf, ...m.verify], { cwd: root, stdio: 'inherit' });
      log(`  ${m.name}: verify-pdf PASS`);
    } catch {
      log(`  ${m.name}: verify-pdf FAIL`);
      failed = true;
    }
  }
} finally {
  await ctx.close();
  server.close();
  rmSync(userDir, { recursive: true, force: true });
  rmSync(dlDir, { recursive: true, force: true });
  rmSync(distTest, { recursive: true, force: true });
}
log(failed ? '\nHARNESS: FAIL' : '\nHARNESS: PASS');
process.exit(failed ? 1 : 0);
