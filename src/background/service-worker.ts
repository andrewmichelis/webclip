// WebClip MV3 service worker — capture orchestrator (M1: message router + active-tab resolution).
// MV3 workers are event-driven and may be suspended; keep no durable state in globals (§15.2).

import { PRODUCT_NAME, VERSION, RESTRICTED_SCHEMES, MIN_CAPTURE_INTERVAL_MS } from '../shared/constants.js';
import { isExtensionMessage } from '../shared/messages.js';
import type { PingResult, ActiveTabResult, StartCaptureResult } from '../shared/messages.js';
import type { ActiveTabInfo, CaptureCapability, UserSettings } from '../shared/types.js';
import { makeError } from '../shared/errors.js';
import { renderImageToPdfBytes, renderFullPagePdf, renderFullPageImage, renderStackedImages, renderAtlasWithInjections } from '../renderer/pdf-renderer.js';
import type { LinkPx } from '../renderer/pdf-renderer.js';
import { saveArtifacts } from './artifacts.js';
import { buildFilename, formatStamp } from '../shared/filename.js';
import { loadSettings, coerceSettings } from '../shared/settings.js';
import { captureFullPage, captureFullPageBase, captureScrollerImage } from './capture-fullpage.js';
import { injectController, startPick, stopPick, clearPick, hasPick, notifyInPage, scrollContext, collectLinks, collectRegionLinks, preparePage, setFixedHidden, restorePage, showSnapshotBar, setSnapshotBarHidden, removeSnapshotBar, startMark, cancelMark, setMarkArmed, regionInfo, regionPositionTile, useMarkedBlockAsScroller, clearForcedScroller, installSessionKeys, removeSessionKeys, setScrollLock, measureTopFrozen } from './page-inject.js';
import type { PageLink } from '../shared/types.js';
import { PDFDocument } from 'pdf-lib';
import { downloadPdf } from './downloads.js';
import { computeCropTops } from '../shared/tiles.js';
import { addSnapshot, getSnapshots, snapshotCount, clearSnapshots, deleteLastSnapshot } from './snapshots.js';
import type { SnapshotRecord } from './snapshots.js';
import type { ImageFormat } from '../shared/types.js';

const SNAP_REPAINT_MS = 80;
const snapSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Test-only probe: lets the headless harness exercise findMarkInBase (which needs ImageBitmap/OffscreenCanvas,
// so it can't run in Vitest) on synthetic base+mark images, giving the atlas pixel-relocate a real image-level
// regression guard. Installed ONLY in the harness's test build — gated on a host permission the SHIPPED build
// never has (ARCH-WC-04: the production manifest declares no host_permissions), so it never exists in production.
try {
  if ((chrome.runtime.getManifest().host_permissions ?? []).length > 0) {
    (globalThis as unknown as { __wcFindMarkProbe?: unknown }).__wcFindMarkProbe = async (baseB64: string, markB64: string, scaleY: number, leftCss: number, wPx: number, hPx: number, baseLeftCss: number): Promise<{ bandY: number; whole: boolean } | null> => {
      const dec = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const baseBmp = await createImageBitmap(new Blob([dec(baseB64) as unknown as BlobPart]));
      const rec = { bytes: dec(markB64).buffer, regionWidthPx: wPx, regionHeightPx: hPx, regionContentLeftCss: leftCss, rect: { top: 0, left: 0, width: 0, height: 0 } } as unknown as SnapshotRecord;
      const r = await findMarkInBase(baseBmp, scaleY, rec, baseLeftCss);
      baseBmp.close();
      return r;
    };
    // Test-only probe: replay a captured tile set through the full-page PDF stitch, so a REAL capture (whose
    // frozen-header seam can't be reproduced by a synthetic fixture) can be validated + guarded deterministically
    // in the harness browser. Same host-permission gate → never in the shipped build.
    (globalThis as unknown as { __wcReplayFullPage?: unknown }).__wcReplayFullPage = async (tilesB64: string[], params: unknown): Promise<string> => {
      const tiles = tilesB64.map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
      const r = await renderFullPagePdf(tiles, params as Parameters<typeof renderFullPagePdf>[1]);
      let s = '';
      const bytes = r.bytes;
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    };
  }
} catch { /* no manifest access → not the test build → no probe */ }

// WC-M12: a mark session can span LESSONS/pages. The captures live in IndexedDB (durable), but the
// toolbar is per-page; track the active session in storage.session and re-inject the toolbar when the
// session's tab finishes navigating, so you keep marking across pages and Done assembles them all.
// WC-M13 G1: the session carries the popup's per-capture paper/layout so the mark/atlas ASSEMBLY honours the
// same Paper/Layout the user picked in the popup (not only the saved options) — matching mode 1.
type SessionState = { active: boolean; tabId: number; paperSize?: import('../shared/types.js').PaperSize; orientation?: import('../shared/types.js').Orientation };
async function setSessionActive(tabId: number, paperSize?: import('../shared/types.js').PaperSize, orientation?: import('../shared/types.js').Orientation): Promise<void> {
  try {
    await chrome.storage.session.set({ wcSession: { active: true, tabId, paperSize, orientation } satisfies SessionState });
  } catch {
    /* storage unavailable */
  }
}
async function clearSessionState(): Promise<void> {
  try {
    await chrome.storage.session.remove('wcSession');
  } catch {
    /* ignore */
  }
}
async function getSessionState(): Promise<SessionState | null> {
  try {
    const r = await chrome.storage.session.get('wcSession');
    return (r.wcSession as SessionState | undefined) ?? null;
  } catch {
    return null;
  }
}

// Set by CANCEL_CAPTURE; polled by the full-page loop to abort mid-capture (restore runs in finally).
let captureCancelled = false;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function capabilityFor(url: string): CaptureCapability {
  const scheme = (url.split(':', 1)[0] + ':').toLowerCase();
  if (RESTRICTED_SCHEMES.includes(scheme)) {
    return { visible: true, fullPage: false, reason: 'This is a restricted browser page; only visible-area capture may work.' };
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'file:') {
    return { visible: true, fullPage: true };
  }
  return { visible: false, fullPage: false, reason: 'This page cannot be captured.' };
}

async function resolveActiveTab(): Promise<ActiveTabResult> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return { ok: false, error: makeError('NO_ACTIVE_TAB', 'No active tab to capture.') };
  }
  const url = tab.url ?? '';
  const info: ActiveTabInfo = {
    tabId: tab.id,
    windowId: tab.windowId,
    url,
    title: tab.title ?? '',
    domain: domainOf(url),
    capability: capabilityFor(url),
  };
  return { ok: true, tab: info };
}

async function captureVisible(tab: ActiveTabInfo, settings: UserSettings): Promise<StartCaptureResult> {
  try {
    const format = settings.imageFormat;
    const shotOpts: chrome.tabs.CaptureVisibleTabOptions =
      format === 'jpeg' ? { format: 'jpeg', quality: Math.round(settings.jpegQuality * 100) } : { format: 'png' };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
    const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
    const now = new Date();
    const pdf = await renderImageToPdfBytes(
      { bytes, format },
      { paperSize: settings.paperSize, orientation: settings.orientation, title: tab.title, url: tab.url, stamp: settings.stamp, capturedAt: now.toLocaleString() },
    );
    const stamp = formatStamp(now);
    const filename = buildFilename(settings.filenameTemplate, {
      domain: tab.domain || tab.url,
      title: tab.title,
      date: stamp.date,
      time: stamp.time,
    });
    await saveArtifacts(pdf, filename, { url: tab.url, title: tab.title, domain: tab.domain }, 'visible', settings, {
      capturedAtUtc: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      captureId: crypto.randomUUID(),
    });
    return { ok: true, filename };
  } catch (e) {
    return {
      ok: false,
      error: makeError('SCREENSHOT_FAILED', 'Capture failed. Please try again.', {
        recoverable: true,
        technicalMessage: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

async function dispatchCapture(settings: UserSettings): Promise<StartCaptureResult> {
  captureCancelled = false; // fresh capture
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false, error: tabRes.error };
  const tab = tabRes.tab;

  if (settings.captureMode === 'full-page') {
    if (!tab.capability.fullPage) {
      return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'Full-page capture is not available on this page.') };
    }
    return captureFullPage(tab, settings, () => captureCancelled);
  }
  if (!tab.capability.visible) {
    return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'This page cannot be captured.') };
  }
  return captureVisible(tab, settings);
}

// --- Manual snapshot & stitch mode (WC-M10) ---
async function snapshotStart(paperSize?: import('../shared/types.js').PaperSize, orientation?: import('../shared/types.js').Orientation): Promise<{ ok: boolean }> {
  await clearSnapshots();
  const tabRes = await resolveActiveTab();
  if (tabRes.ok) {
    await injectController(tabRes.tab.tabId).catch(() => undefined);
    await showSnapshotBar(tabRes.tab.tabId, 0);
    await installSessionKeys(tabRes.tab.tabId);
    await setSessionActive(tabRes.tab.tabId, paperSize, orientation);
  }
  return { ok: true };
}

// WC-M12: composite capture — grab the full page as a BASE atlas first, then run the mark session on
// top of it. On Done, each marked region is SPLICED into the base at its confidently-located anchor
// (in-place), so the result reads as the real page with those sections expanded.
async function snapshotStartAtlas(paperSize?: import('../shared/types.js').PaperSize, orientation?: import('../shared/types.js').Orientation): Promise<{ ok: boolean; error?: ReturnType<typeof makeError> }> {
  await clearSnapshots();
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false, error: tabRes.error };
  const tab = tabRes.tab;
  if (!tab.capability.fullPage) {
    return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'Full-page capture is not available here.') };
  }
  const settings = await loadSettings();
  const base = await captureFullPageBase(tab, settings);
  if ('error' in base) {
    return { ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not capture the base page.', { recoverable: true, technicalMessage: base.error }) };
  }
  await addSnapshot({
    seq: 0,
    bytes: base.bytes.buffer as ArrayBuffer,
    scrollTop: 0,
    viewportWidthCss: 0,
    viewportHeightCss: 0,
    rect: { top: 0, left: 0, width: 0, height: 0 },
    clientHeight: 0,
    links: base.links, // G2: base-page links (content-absolute px), laid over the unmarked base by the atlas renderer
    kind: 'base',
    regionWidthPx: base.wPx,
    regionHeightPx: base.hPx,
    anchors: base.anchors,
    tabPanels: base.tabPanels,
    scaleY: base.scaleY,
    contentLeftCss: base.contentLeftCss,
  });
  await injectController(tab.tabId).catch(() => undefined);
  await showSnapshotBar(tab.tabId, await snapshotCount());
  await installSessionKeys(tab.tabId);
  await setSessionActive(tab.tabId, paperSize, orientation);
  return { ok: true };
}

async function snapshotAdd(): Promise<StartCaptureResult & { count?: number }> {
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false, error: tabRes.error };
  const tab = tabRes.tab;
  if (!tab.capability.visible) {
    return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'This page cannot be captured.') };
  }
  const settings = await loadSettings();
  await injectController(tab.tabId);
  // Prepare the page like a full-page tile: hide sticky/fixed chrome so it isn't repeated at the top of
  // every snapshot (which defeats the overlap match), suppress animations, declutter. NOT expand — the
  // user opens sections by hand in snapshot mode. Restored after each shot so the user keeps navigating.
  await preparePage(tab.tabId, {
    suppressAnimations: settings.suppressAnimations,
    suppressRepeatedFixedElements: settings.suppressRepeatedFixedElements,
    declutter: settings.declutter,
    expandCollapsible: false,
  });
  // Measure the pane geometry on the INTACT page, BEFORE hiding anything — so the crop rect is always
  // valid even if suppression would perturb layout.
  const ctx = await scrollContext(tab.tabId);
  if (!ctx || ctx.rectWidth < 4) {
    await restorePage(tab.tabId);
    return { ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not read the page for a snapshot.', { recoverable: true }) };
  }
  // Hide only BAR-LIKE fixed/sticky chrome (a course player's "EXIT COURSE"/nav strip, a pinned
  // header/footer) so it isn't baked into every shot. barLikeOnly is critical: Rise/SCORM lay their
  // MAIN content out with position:fixed, so hiding fixed/sticky wholesale blanks the lesson.
  await setFixedHidden(tab.tabId, true, true);
  const format = settings.imageFormat;
  const shotOpts: chrome.tabs.CaptureVisibleTabOptions =
    format === 'jpeg' ? { format: 'jpeg', quality: Math.round(settings.jpegQuality * 100) } : { format: 'png' };
  await setSnapshotBarHidden(tab.tabId, true); // never capture our own toolbar
  await snapSleep(SNAP_REPAINT_MS);
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
  } finally {
    await setSnapshotBarHidden(tab.tabId, false);
  }
  const bytes = await (await fetch(dataUrl)).arrayBuffer();
  const links = settings.links ? await collectLinks(tab.tabId) : [];
  await restorePage(tab.tabId); // restore fixed chrome + scroll so the user keeps navigating normally
  const seq = await snapshotCount();
  await addSnapshot({
    seq,
    bytes,
    scrollTop: ctx.scrollTop,
    viewportWidthCss: ctx.fullViewportWidth,
    viewportHeightCss: ctx.fullViewportHeight,
    rect: { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: ctx.rectHeight || ctx.fullViewportHeight },
    clientHeight: ctx.clientHeight,
    links,
  });
  const count = seq + 1;
  await showSnapshotBar(tab.tabId, count);
  return { ok: true, filename: '', count };
}

// WC-M11: arm "mark a section" mode. The page highlights blocks on hover; a click sends REGION_MARKED.
async function snapshotMark(): Promise<{ ok: boolean }> {
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false };
  await injectController(tabRes.tab.tabId).catch(() => undefined);
  await startMark(tabRes.tab.tabId);
  await setMarkArmed(tabRes.tab.tabId, true); // toolbar Mark -> "Cancel mark"
  return { ok: true };
}

// Capture the just-marked block as ONE self-contained region image (scroll-tiled if taller than the
// viewport, using EXACT tool-set scroll positions — no overlap matching), and store it as a region
// snapshot. Assembly then concatenates regions with no dedup, so nothing is duplicated or lost.
async function regionMarked(): Promise<StartCaptureResult & { count?: number }> {
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false, error: tabRes.error };
  const tab = tabRes.tab;
  const settings = await loadSettings();
  // Do NOT re-inject the controller here — that would re-run the content script and wipe the just-marked
  // block. The controller is already live (snapshotMark injected it before arming mark mode).
  // Prepare BEFORE measuring, honoring the user's settings: declutter (strip cookie/chat/nav clutter) and
  // bar-like fixed-chrome suppression (an "EXIT COURSE"/messaging bar overlapping the block), so a marked
  // region is as clean as a full-page capture. Measuring after these reflow keeps the tiling accurate.
  const format = settings.imageFormat;
  const shotOpts: chrome.tabs.CaptureVisibleTabOptions =
    format === 'jpeg' ? { format: 'jpeg', quality: Math.round(settings.jpegQuality * 100) } : { format: 'png' };
  await preparePage(tab.tabId, { suppressAnimations: settings.suppressAnimations, suppressRepeatedFixedElements: settings.suppressRepeatedFixedElements, declutter: settings.declutter, expandCollapsible: false });
  if (settings.suppressRepeatedFixedElements) await setFixedHidden(tab.tabId, true, true);
  // Content that scrolls UNDER a viewport-top-pinned header (e.g. GitHub's file bar, which the suppressor can't
  // hide) is LOST at each region seam of a tall/whole-page mark unless the tiles overlap by that header's height
  // — the same scroll-offset the full-page path applies (measured AFTER hiding, so a hidden header reads 0). The
  // measurement is mechanism-agnostic and fail-safe 0 (single-screen / nothing pinned); regionInfo widens the
  // region overlap by it (capped at half a tile), leaving frozen-header-free pages unchanged.
  let regionFrozenHeaderCss = 0;
  try { regionFrozenHeaderCss = await measureTopFrozen(tab.tabId); } catch { regionFrozenHeaderCss = 0; }
  const info = await regionInfo(tab.tabId, regionFrozenHeaderCss);
  if (!info || info.widthCss < 1 || info.heightCss < 1) {
    await restorePage(tab.tabId);
    await showSnapshotBar(tab.tabId, await snapshotCount());
    return { ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not read the marked section.', { recoverable: true }) };
  }
  // G2: collect links inside the marked block (post-declutter, block-relative content coords) so the
  // stacked/atlas assembly can lay clickable annotations. Best-effort; gated on the user's links setting.
  const regionLinks = settings.links ? await collectRegionLinks(tab.tabId) : [];
  // WC-M13 P2b: a self-scrolling marked PANE is captured via the SHARED full-page engine (warmup +
  // overlap-matched tiling + completeness floor), cropped to the pane — so it inherits the tested robustness
  // the mark's own exact-position tiling lacked (lazy-warmup, reflow-safe stitch, no cutoff). Non-self-scroll
  // marks (a section inside the document) keep the exact-position region tiling further below.
  if (await useMarkedBlockAsScroller(tab.tabId)) {
    await setScrollLock(tab.tabId, true);
    await setSnapshotBarHidden(tab.tabId, true); // never bake our own toolbar into the region
    let img: Awaited<ReturnType<typeof captureScrollerImage>>;
    try {
      img = await captureScrollerImage(tab, settings, () => captureCancelled);
    } finally {
      await clearForcedScroller(tab.tabId);
      await setScrollLock(tab.tabId, false);
      await setSnapshotBarHidden(tab.tabId, false);
      await restorePage(tab.tabId);
    }
    if ('error' in img) {
      await showSnapshotBar(tab.tabId, await snapshotCount());
      return { ok: false, error: makeError('SCREENSHOT_FAILED', 'The marked section captured nothing.', { recoverable: true, technicalMessage: img.error }) };
    }
    const seqE = await snapshotCount();
    await addSnapshot({
      seq: seqE,
      bytes: img.bytes.buffer as ArrayBuffer,
      scrollTop: 0,
      viewportWidthCss: info.widthCss,
      viewportHeightCss: info.heightCss,
      rect: { top: 0, left: 0, width: info.widthCss, height: info.heightCss },
      clientHeight: info.heightCss,
      links: regionLinks,
      kind: 'region',
      regionWidthPx: img.wPx,
      regionHeightPx: img.hPx,
      anchorKeys: info.anchorKeys ?? [],
      precedingKey: info.precedingKey || '',
      regionContentTopCss: info.blockContentTopCss,
      regionContentLeftCss: info.blockContentLeftCss,
      isDefaultTab: info.isDefaultTab === true,
    });
    const countE = seqE + 1;
    await showSnapshotBar(tab.tabId, countE);
    await setMarkArmed(tab.tabId, false);
    return { ok: true, filename: '', count: countE };
  }
  // MEASURE the real screenshot scale from the first captured tile (bmp width / top viewport css) —
  // captureVisibleTab's device-pixel-ratio differs across platforms/headless, and trusting
  // window.devicePixelRatio corrupts the crop math (garbled / mostly-blank regions). Mirrors the
  // full-page renderer, which measures scale the same way.
  let scale = info.devicePixelRatio || 1;
  const tiles: Uint8Array[] = [];
  const destTops: number[] = [];
  let crop0: { left: number; top: number; width: number; height: number } | null = null;
  let lastCaptureAt = 0;
  await setScrollLock(tab.tabId, true); // block user scroll so it can't disturb the tool's tiling scroll
  // Never bake our own floating toolbar into a marked region: the bar's inline `display:flex !important`
  // beats the stabilization stylesheet's `[data-webclip-ui]{display:none}`, so ONLY an explicit hide works.
  // A region that reaches the page bottom (where the bar sits) would otherwise capture the toolbar itself.
  await setSnapshotBarHidden(tab.tabId, true);
  try {
    for (let i = 0; i < info.tileCount; i++) {
      const pos = await regionPositionTile(tab.tabId, i);
      if (!pos || pos.cropCss.height < 1) continue;
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await snapSleep(wait); // never exceed 2 captureVisibleTab/sec (a tall region tiles)
      // Re-hide fixed chrome (a progress/accent bar) BEFORE each shot — a framework (esp. a course player
      // inside a same-origin frame) re-creates it on scroll, so hiding once before the loop lets a fresh node
      // leak into later tiles and bake a bar at the tile seam. Covers the frame chain (setFixedHidden walks
      // it). Mirrors the full-page scrollAndTile per-tile re-hide — the reason full-page stays clean.
      if (settings.suppressRepeatedFixedElements) await setFixedHidden(tab.tabId, true, true);
      await snapSleep(SNAP_REPAINT_MS);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
      lastCaptureAt = Date.now();
      const tileBytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
      if (!crop0) {
        crop0 = { left: pos.cropCss.left, top: pos.cropCss.top, width: pos.cropCss.width, height: pos.cropCss.height };
        const bmp = await createImageBitmap(new Blob([tileBytes as unknown as BlobPart]));
        scale = info.fullViewportWidthCss > 0 ? bmp.width / info.fullViewportWidthCss : info.devicePixelRatio || 1;
        bmp.close();
      }
      tiles.push(tileBytes);
      destTops.push(pos.destTopCss);
    }
  } finally {
    await setScrollLock(tab.tabId, false);
    await setSnapshotBarHidden(tab.tabId, false); // re-show our toolbar once the region is captured
    await restorePage(tab.tabId);
  }
  if (!tiles.length || !crop0) {
    await showSnapshotBar(tab.tabId, await snapshotCount());
    return { ok: false, error: makeError('SCREENSHOT_FAILED', 'The marked section captured nothing.', { recoverable: true }) };
  }
  const wPx = Math.max(1, Math.round(info.widthCss * scale));
  const hPx = Math.max(1, Math.round(info.heightCss * scale));
  let bytes: ArrayBuffer;
  let outW = wPx;
  let outH = hPx;
  if (tiles.length > 1) {
    // MULTI-TILE region → stitch with the SHARED full-page engine (overlap-matched dedup + detectFrozenBand
    // bar-strip + EDGE trim), the same pipeline as Capture & Save / the atlas base — so a tall/whole-page mark
    // no longer leaves a seam or a frozen accent bar baked at each tile boundary (ARCH-WC-15). Each full-viewport
    // tile is cropped to the region box (crop0, constant per tile — the last tile's bottom-clamp is absorbed by
    // the overlap dedup, exactly like full-page's clamped last tile).
    const img = await renderFullPageImage(tiles, {
      cropTopsCss: computeCropTops(destTops, info.tileHeightCss),
      fullViewportWidthCss: info.fullViewportWidthCss,
      fullViewportHeightCss: info.fullViewportHeightCss,
      contentRectCss: { top: crop0.top, left: crop0.left, width: crop0.width, height: info.tileHeightCss },
      format,
      jpegQuality: settings.jpegQuality,
    });
    outW = img.wPx;
    outH = img.hPx;
    bytes = img.bytes.buffer as ArrayBuffer;
    // The stitch spans the whole tiled range; the last tile can run a little past the region bottom → crop to it.
    if (img.hPx > hPx + 1) {
      const src = await createImageBitmap(new Blob([img.bytes as unknown as BlobPart]));
      const cv = new OffscreenCanvas(img.wPx, hPx);
      const cx = cv.getContext('2d');
      if (cx) {
        cx.drawImage(src, 0, 0, img.wPx, hPx, 0, 0, img.wPx, hPx);
        const b = await cv.convertToBlob(format === 'jpeg' ? { type: 'image/jpeg', quality: settings.jpegQuality } : { type: 'image/png' });
        bytes = await b.arrayBuffer();
        outW = img.wPx;
        outH = hPx;
      }
      src.close();
    }
  } else {
    // SINGLE-TILE region (fits one viewport) → the fast exact crop, unchanged.
    const bmp = await createImageBitmap(new Blob([tiles[0] as unknown as BlobPart]));
    const cv = new OffscreenCanvas(wPx, hPx);
    const cx = cv.getContext('2d');
    if (!cx) { bmp.close(); await showSnapshotBar(tab.tabId, await snapshotCount()); return { ok: false, error: makeError('SCREENSHOT_FAILED', 'Canvas unavailable.', { recoverable: true }) }; }
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, wPx, hPx);
    const sx = Math.round(crop0.left * scale);
    const sy = Math.round(crop0.top * scale);
    const sw = Math.min(wPx, Math.round(crop0.width * scale));
    const sh = Math.round(crop0.height * scale);
    cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    bmp.close();
    const b = await cv.convertToBlob(format === 'jpeg' ? { type: 'image/jpeg', quality: settings.jpegQuality } : { type: 'image/png' });
    bytes = await b.arrayBuffer();
  }
  const seq = await snapshotCount();
  await addSnapshot({
    seq,
    bytes,
    scrollTop: 0,
    viewportWidthCss: info.widthCss,
    viewportHeightCss: info.heightCss,
    rect: { top: 0, left: 0, width: info.widthCss, height: info.heightCss },
    clientHeight: info.heightCss,
    links: regionLinks,
    kind: 'region',
    regionWidthPx: outW,
    regionHeightPx: outH,
    anchorKeys: info.anchorKeys ?? [],
    precedingKey: info.precedingKey || '',
    regionContentTopCss: info.blockContentTopCss, // where the mark was captured — place by AREA if no header match
    regionContentLeftCss: info.blockContentLeftCss, // its LEFT — aligns the pixel-relocate column search in the base
    isDefaultTab: info.isDefaultTab === true, // a re-mark of a tab widget's default panel → patch in place
  });
  const count = seq + 1;
  await showSnapshotBar(tab.tabId, count);
  await setMarkArmed(tab.tabId, false); // capture done -> button back to "Mark" for the next section
  return { ok: true, filename: '', count };
}

// WC-M11: drop the last captured piece (Undo) — useful after a wrong Mark, so effort isn't lost.
async function snapshotUndo(): Promise<{ ok: boolean; count: number }> {
  const count = await deleteLastSnapshot();
  const tabRes = await resolveActiveTab();
  if (tabRes.ok) {
    await showSnapshotBar(tabRes.tab.tabId, count);
  }
  return { ok: true, count };
}

// Crop a viewport snapshot to its pane rect → a standalone piece image (for a mixed Mark+Snap session).
async function cropShotToRect(s: SnapshotRecord, format: ImageFormat, jpegQuality: number): Promise<{ bytes: Uint8Array; wPx: number; hPx: number } | null> {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(s.bytes) as unknown as BlobPart]));
  const dpr = s.viewportWidthCss > 0 ? bmp.width / s.viewportWidthCss : 1;
  const sx = Math.max(0, Math.round(s.rect.left * dpr));
  const sy = Math.max(0, Math.round(s.rect.top * dpr));
  const sw = Math.max(1, Math.min(bmp.width - sx, Math.round((s.rect.width || s.viewportWidthCss) * dpr)));
  const sh = Math.max(1, Math.min(bmp.height - sy, Math.round((s.rect.height || s.viewportHeightCss) * dpr)));
  const cv = new OffscreenCanvas(sw, sh);
  const ctx = cv.getContext('2d');
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();
  const blob = await cv.convertToBlob(format === 'jpeg' ? { type: 'image/jpeg', quality: jpegQuality } : { type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), wPx: sw, hPx: sh };
}

// The atlas base force-expands ALL sections, so a marked accordion/section usually already lives in the base
// — but at a DIFFERENT content-Y than the mark measured (the base's all-expanded layout ≠ the mark's layout).
// Placing by content-Y then DUPLICATES it (and disorders tabs). Find where the mark's content ACTUALLY is in
// the base by pixel-matching, so the caller can REPLACE the base copy in place instead of appending a copy.
//
// Two steps: (1) slide the mark's distinctive TOP BAND (header / tab bar) down the base column at the mark's x
// to find its true row (drift-immune); (2) VERIFY the WHOLE mark there. A re-captured accordion/section
// matches wholly → return its base-image Y → caller REPLACES (no duplicate). A DIFFERENT tab (only its shared
// bar is in the base, panel differs) fails the whole-mark verify → return null → caller keeps its own path
// (append/keep the base default). Fail-safe: any decode/geometry error → null.
const WHOLE_MATCH_THRESHOLD = 0.8; // fraction of downsampled pixels within tolerance for "same as the base here"
// Returns where the mark's TOP BAND (header / tab bar) matches in the base — `bandY` in base image px — plus
// `whole` = whether the ENTIRE mark matches there. `bandY` locates a widget in the base even for a tab whose
// PANEL differs (tabs share the bar), so the caller can anchor every tab of one widget to the same base row.
async function findMarkInBase(baseBmp: ImageBitmap, scaleY: number, s: SnapshotRecord, baseLeftCss = 0): Promise<{ bandY: number; whole: boolean; score: number } | null> {
  if (!s.bytes || !s.regionWidthPx || !s.regionHeightPx) return null;
  let markBmp: ImageBitmap | null = null;
  try {
    markBmp = await createImageBitmap(new Blob([new Uint8Array(s.bytes) as unknown as BlobPart]));
    const markW = markBmp.width;
    const markH = markBmp.height;
    // Search the base COLUMN at the mark's true LEFT in content coords (an indented widget lives at x>0 in the
    // base; searching at x=0 aligns the wrong column and yields garbage matches). Fall back to rect.left.
    // The base image is cropped to the content column, so viewport x=baseLeftCss maps to base-image x=0. Subtract
    // it from the mark's viewport-relative left before scaling, or the search column is shifted right (by
    // baseLeftCss*scaleY) and the mark mis-matches a wrong column — the atlas tab-placement regression.
    const leftCss = (s.regionContentLeftCss ?? s.rect?.left ?? 0) - baseLeftCss;
    const bx = Math.max(0, Math.min(baseBmp.width - markW, Math.round(leftCss * scaleY)));
    if (markH < 8 || markW < 8 || markW > baseBmp.width + 8 || markH > baseBmp.height) return null;
    const dsW = Math.min(64, markW);
    // (1) Base COLUMN STRIP at the mark's x, downsampled horizontally to dsW, at full height (one draw).
    const stripCtx = new OffscreenCanvas(dsW, baseBmp.height).getContext('2d');
    if (!stripCtx) return null;
    stripCtx.drawImage(baseBmp, bx, 0, markW, baseBmp.height, 0, 0, dsW, baseBmp.height);
    const strip = stripCtx.getImageData(0, 0, dsW, baseBmp.height).data;
    // The mark's TOP BAND (its header / tab bar), same horizontal downsample, unscaled vertically.
    const bandH = Math.min(96, Math.max(8, Math.round(markH * 0.3)));
    const bandCtx = new OffscreenCanvas(dsW, bandH).getContext('2d');
    if (!bandCtx) return null;
    bandCtx.drawImage(markBmp, 0, 0, markW, bandH, 0, 0, dsW, bandH);
    const band = bandCtx.getImageData(0, 0, dsW, bandH).data;
    const lum = (a: Uint8ClampedArray, o: number): number => 0.299 * a[o] + 0.587 * a[o + 1] + 0.114 * a[o + 2];
    let bestY = -1;
    let bestD = Infinity;
    for (let y = 0; y + bandH <= baseBmp.height; y += 3) {
      let d = 0;
      let n = 0;
      for (let r = 0; r < bandH; r += 2) {
        const sr = (y + r) * dsW;
        const br = r * dsW;
        for (let x = 0; x < dsW; x++) {
          d += Math.abs(lum(strip, (sr + x) * 4) - lum(band, (br + x) * 4));
          n++;
        }
      }
      d /= n || 1;
      if (d < bestD) {
        bestD = d;
        bestY = y;
      }
    }
    if (bestY < 0 || bestD > 50 || bestY + markH > baseBmp.height + 4) return null; // no plausible band match
    const vH = Math.min(200, markH);
    const rv = new OffscreenCanvas(dsW, vH).getContext('2d');
    const bv = new OffscreenCanvas(dsW, vH).getContext('2d');
    if (!rv || !bv) return null;
    rv.drawImage(markBmp, 0, 0, markW, markH, 0, 0, dsW, vH);
    bv.drawImage(baseBmp, bx, bestY, markW, markH, 0, 0, dsW, vH);
    const rd = rv.getImageData(0, 0, dsW, vH).data;
    const bd = bv.getImageData(0, 0, dsW, vH).data;
    let same = 0;
    for (let i = 0; i < rd.length; i += 4) if (Math.abs(rd[i] - bd[i]) + Math.abs(rd[i + 1] - bd[i + 1]) + Math.abs(rd[i + 2] - bd[i + 2]) <= 60) same++;
    const score = same / (dsW * vH);
    return { bandY: bestY, whole: score >= WHOLE_MATCH_THRESHOLD, score };
  } catch {
    return null;
  } finally {
    markBmp?.close();
  }
}

// How many base rows below `startYpx` (device px) are the replaced panel's own TRAILING TAIL — the widget box /
// padding / bottom border the base rendered just below the panel content the mark's region cropped — so the
// caller can grow the replace over exactly that tail (and no further) instead of leaving a strip of the old
// panel. The box reads differently from the page background even when it carries side borders (so its rows
// aren't uniform); the tail ends at the first SUSTAINED run of UNIFORM rows whose colour differs from the box's
// bottom (the page-background margin — grey vs the box's white). Internal borders/lines (brief, non-uniform, or
// same colour) are stepped over, not stopped at. Bounded by capPx (a fraction of the mark's height); 0 if no
// clean end is found — so this only ever trims the small render-height difference, never a whole section.
async function trailingPanelTailPx(baseBmp: ImageBitmap, xPx: number, wPx: number, startYpx: number, capPx: number): Promise<number> {
  try {
    const y0 = Math.round(startYpx);
    if (y0 < 1 || y0 >= baseBmp.height) return 0;
    const x0 = Math.max(0, Math.min(baseBmp.width - 4, Math.round(xPx)));
    const w = Math.max(4, Math.min(baseBmp.width - x0, Math.round(wPx)));
    const h = Math.max(0, Math.min(baseBmp.height - (y0 - 1), Math.round(capPx) + 1));
    if (h < 6) return 0;
    const dw = Math.min(48, w);
    const cx = new OffscreenCanvas(dw, h).getContext('2d');
    if (!cx) return 0;
    cx.imageSmoothingEnabled = false;
    cx.drawImage(baseBmp, x0, y0 - 1, w, h, 0, 0, dw, h); // row 0 = the panel's rendered bottom (what the mark captured)
    const d = cx.getImageData(0, 0, dw, h).data;
    const stat = (y: number): { r: number; g: number; b: number } => {
      let r = 0, g = 0, b = 0;
      for (let x = 0; x < dw; x++) { const o = (y * dw + x) * 4; r += d[o]; g += d[o + 1]; b += d[o + 2]; }
      return { r: r / dw, g: g / dw, b: b / dw };
    };
    // PIXEL DIFF, background- and page-agnostic (operator 2026-09-07): the replaced section ends where the base
    // stops looking like the PANEL and a NEW element begins. `ref` is the panel's rendered bottom row (what the
    // mark captured). Extend over rows that CONTINUE it (the widget's own trailing padding/border, or an empty
    // gap of the same tone — small diff), and STOP at the first SUSTAINED band that clearly DIFFERS from it (a
    // distinct next element — a "Continue" button, a marker, the next section). No page-background colour is
    // assumed; the only reference is the captured pixels themselves. Earlier this keyed off a "page-background"
    // heuristic and, when the mark ended right at a margin, stepped over the next element and ate it (the lost
    // Continue button). Returns the offset to just before that new element; 0 if none within the cap (fail-safe).
    const DIFF = 60; // sum |Δrgb| vs the panel bottom; a real new element clears this, a same-tone gap/border does not
    const ref = stat(0);
    let diffStart = -1, run = 0;
    for (let y = 1; y < h; y++) {
      const c = stat(y);
      const differs = Math.abs(c.r - ref.r) + Math.abs(c.g - ref.g) + Math.abs(c.b - ref.b) > DIFF;
      if (differs) {
        if (diffStart < 0) diffStart = y;
        if (++run >= 4) return Math.max(0, diffStart - 1); // a new element starts here → end the section just above it
      } else {
        diffStart = -1; run = 0;
      }
    }
    return 0; // no distinct next element within the cap → don't guess a section end (fail-safe)
  } catch {
    return 0;
  }
}

async function snapshotFinish(): Promise<StartCaptureResult> {
  const snaps = await getSnapshots();
  const tabRes = await resolveActiveTab();
  const tab = tabRes.ok ? tabRes.tab : undefined;
  const sess = await getSessionState(); // read the popup's per-capture paper/layout BEFORE clearing (G1)
  await clearSessionState();
  if (tab) {
    // removeSnapshotBar dismisses the toolbar AND clears any stranded mark overlay DOM in one fast top-frame
    // script — so Done always responds even on heavy pages (awaiting a second executeScript here stalled it).
    await removeSnapshotBar(tab.tabId);
    await removeSessionKeys(tab.tabId);
    // Tear down the mark event listeners too (not just the DOM), but NON-BLOCKING — a stalled executeScript
    // must never wedge Done. Fire-and-forget; the toolbar's own Done handler also tears down in-page.
    void cancelMark(tab.tabId).catch(() => undefined);
  }
  if (!snaps.length) {
    await clearSnapshots();
    return { ok: false, error: makeError('CANCELLED', 'No snapshots to assemble.', { recoverable: true }) };
  }
  const settings = await loadSettings();
  // G1: honour the popup's per-capture Paper/Layout for the mark/atlas ASSEMBLY (like mode 1), overriding the
  // saved options only when the popup passed a value at session start.
  if (sess?.paperSize) settings.paperSize = sess.paperSize;
  if (sess?.orientation) settings.orientation = sess.orientation;
  const first = snaps[0];
  const tileBytes = snaps.map((s) => new Uint8Array(s.bytes));
  const scrollTops = snaps.map((s) => s.scrollTop);
  // Backstop against a degenerate rect (e.g. pane resolution failed → width 0): fall back to the full
  // viewport so we render a usable capture instead of exploding into thousands of empty pages.
  const safeW = first.rect.width > 4 ? first.rect.width : first.viewportWidthCss;
  const effVpH = Math.max(1, Math.min(first.clientHeight || first.viewportHeightCss, first.rect.height || first.viewportHeightCss));
  const cropTopsCss = computeCropTops(scrollTops, effVpH);
  // Combine all snapshots' links (content-absolute coords) and dedupe overlaps by href + position.
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const s of snaps) {
    for (const l of s.links ?? []) {
      const key = `${l.href}@${Math.round(l.xCss)},${Math.round(l.yCss)}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push(l);
      }
    }
  }
  const now = new Date();
  // Atlas placement summary, filled by the atlas branch below and emitted in the snapshots-debug metadata
  // AFTER assembly (so the saved debug shows exactly which base rows each mark replaced/inserted).
  let atlasDbg: Record<string, unknown> | null = null;
  const baseRec = snaps.find((s) => s.kind === 'base');
  const hasPiece = snaps.some((s) => s.kind === 'region');
  let rendered;
  let droppedMsg: string | undefined;
  if (baseRec && baseRec.regionWidthPx && baseRec.scaleY !== undefined) {
    // WC-M12 Phase 1b: SPLICE each mark/snap into the base atlas at its confident anchor. If a piece can't
    // be placed with confidence (no unique header match), DROP it and report — never guess (would corrupt
    // the page). Mark-only PDFs are the separate non-atlas run.
    const anchors = baseRec.anchors ?? [];
    const tabPanels = baseRec.tabPanels ?? []; // default tab-panel extents (content-Y) → exact tab splicing
    const scaleY = baseRec.scaleY;
    const stackParams = { paperSize: settings.paperSize, orientation: settings.orientation, format: settings.imageFormat, jpegQuality: settings.jpegQuality, title: tab?.title, url: tab?.url, stamp: settings.stamp, capturedAt: now.toLocaleString() };
    const injections: { bytes: Uint8Array; atYpx: number; replaceBaseHpx: number; links?: LinkPx[] }[] = [];
    const dropped: string[] = [];
    // Non-widget area marks that share one block must splice at the SAME point (just past that block) so
    // overlapping marks APPEND in timeline order instead of stacking on top of each other. The first mark at
    // a given block top fixes that point (top + captured height); later marks at the same top reuse it.
    // (Tab widgets take the exact base-recorded path above; this is the fallback for lone sections.)
    const areaInsertBottomCss = new Map<number, number>();
    // Decoded once, on demand, for the pixel-relocate search (findMarkInBase). Closed after the loop.
    let baseMatchBmp: ImageBitmap | null = null;
    const decodeBase = async (): Promise<ImageBitmap> => (baseMatchBmp ??= await createImageBitmap(new Blob([new Uint8Array(baseRec.bytes) as unknown as BlobPart])));
    // PASS 1 — resolve each mark's base-Y by the CHEAP, deterministic paths (unique header match, direct-sibling
    // header, or a recorded default tab panel). A mark that needs the pixel-relocate fallback is DEFERRED to
    // PASS 2, so ALL tabs of one widget are grouped and ordered together. (Placing a widget's default tab by its
    // BASE position while its other tabs go by their own LIVE content-Y misorders them: the base is force-
    // expanded but the marks are captured collapsed, so those two coordinate systems diverge.)
    const place = new Map<SnapshotRecord, { atCss: number; replaceHcss: number }>();
    const deferred: SnapshotRecord[] = [];
    for (const s of snaps) {
      if (s.kind === 'base') continue;
      if (s.kind !== 'region') { place.set(s, { atCss: s.scrollTop, replaceHcss: 0 }); continue; } // Snap: by scroll pos
      let atCss: number | null = null;
      let replaceHcss = 0; // base rows the piece overwrites (so the base's version of the section is swapped)
      // Unique-match a header key against the base (confidence gate: 0 or >1 → drop, never guess).
      const uniq = (k: string): { yCss: number; hCss: number } | null => {
        const m = anchors.filter((a) => a.key === k);
        return m.length === 1 ? m[0] : null;
      };
      const nextAnchorY = (afterY: number): number => anchors.reduce((min, a) => (a.yCss > afterY + 1 && a.yCss < min ? a.yCss : min), Infinity);
      const cap = (s.viewportHeightCss || 0) * 2 || Infinity; // never overwrite far more base than the mark itself
      const inside = s.anchorKeys ?? [];
      // PREFERRED: a confident, unique header match → replace that exact collapsed section span.
      if (inside.length) {
        // The mark carries its own header(s): DETECT them in the base and REPLACE that whole span with the mark
        // (first header → the section after the last header). Handles ↑/↓ multi-section marks.
        const first = uniq(inside[0]);
        const last = uniq(inside[inside.length - 1]);
        if (first && last) {
          atCss = first.yCss;
          const endY = nextAnchorY(last.yCss);
          const spanCss = (endY === Infinity ? last.yCss + last.hCss : endY) - first.yCss;
          replaceHcss = Math.max(0, Math.min(spanCss, cap));
        }
      } else if (s.precedingKey) {
        // The mark has no header of its own but its accordion's own header is a DIRECT sibling just above it
        // (precedingKey is only set for a direct-sibling header) — replace the collapsed section right under it.
        const h = uniq(s.precedingKey);
        if (h) {
          atCss = h.yCss + h.hCss;
          const endY = nextAnchorY(h.yCss);
          const spanCss = (endY === Infinity ? atCss : endY) - atCss;
          replaceHcss = Math.max(0, Math.min(spanCss, cap));
        }
      }
      // FALLBACK: no confident header match. A mark in a TAB WIDGET whose default panel the base RECORDED (a
      // structurally-recognized widget) splices at that recorded panel; anything else is DEFERRED to PASS 2's
      // pixel-relocate so widget tabs stay grouped.
      if (atCss === null && s.regionContentTopCss !== undefined) {
        const top = s.regionContentTopCss;
        // Nearest recorded default tab-panel whose slot the mark falls in (its top ≈ the mark's top).
        const tp = tabPanels
          .map((p) => ({ p, d: Math.abs(p.topCss - top) }))
          .filter(({ p, d }) => d < 80 || (top >= p.topCss - 8 && top <= p.bottomCss))
          .sort((a, b) => a.d - b.d)[0]?.p;
        if (tp && s.isDefaultTab) {
          // Re-mark of the DEFAULT tab → overwrite exactly [topCss, bottomCss] with the fresh capture (patch in
          // place, no duplicate).
          atCss = tp.topCss;
          replaceHcss = Math.max(0, tp.bottomCss - tp.topCss);
        } else if (tp) {
          // Another tab of the same recognized widget → inject right AFTER the default view ends.
          atCss = tp.bottomCss;
          replaceHcss = 0;
        } else {
          deferred.push(s); // PASS 2: pixel-relocate + widget grouping
          continue;
        }
      }
      if (atCss !== null) place.set(s, { atCss, replaceHcss });
      else dropped.push('an unlabeled section'); // truly no position (an old capture w/o area)
    }
    // PASS 2 — GROUP the deferred marks by their CAPTURE LOCATION (content-Y where they were marked — every tab
    // of one widget is marked at the same spot, since switching tabs doesn't move the widget). Pixel-relocate
    // each in the (force-expanded) base; whichever mark WHOLE-matches the base is the tab the base shows there —
    // it fixes the widget's true BASE position and the base panel's extent. Every tab of the widget then anchors
    // to that SAME base position and stacks in capture (tab) order; the base's shown panel is REPLACED once (so
    // it isn't duplicated) while the rest INSERT after it. Grouping by location, NOT by each mark's own band
    // match, is what keeps the tabs together: a non-default tab's PANEL differs from the base, so its band match
    // is unreliable (it can match a stray row elsewhere) — but its capture location is identical to its siblings'.
    const groups = new Map<number, { anchorCss: number; defaultHcss: number; leftPx: number; widthPx: number; hasDefault: boolean; placed: boolean; bestScore: number }>();
    const locKey = (s: SnapshotRecord): number => Math.round((s.regionContentTopCss ?? 0) / 8); // shared by a widget's tabs
    for (const s of deferred) {
      const r = await findMarkInBase(await decodeBase(), scaleY, s, baseRec.contentLeftCss ?? 0);
      const key = locKey(s);
      const g = groups.get(key) ?? { anchorCss: NaN, defaultHcss: 0, leftPx: 0, widthPx: 0, hasDefault: false, placed: false, bestScore: -1 };
      if (r?.whole) { // this mark matches what the base shows here → it can pin the widget's base position + panel extent
        g.hasDefault = true;
        // The base shows ONE default panel. Every tab of a widget shares the same tab bar and (text-on-white)
        // layout, so they ALL "whole"-match at this location — taking the MAX height (old bug) picks the TALLEST
        // tab and over-replaces, eating the section BELOW the widget (the "Continue" button, capture 180618). The
        // mark whose CONTENT matches the base BEST (highest score) IS the shown default; pin the anchor + panel
        // EXTENT to THAT one. leftPx subtracts the base content-left (same convention as findMarkInBase's column).
        if (r.score > g.bestScore) {
          g.bestScore = r.score;
          g.anchorCss = r.bandY / scaleY;
          g.leftPx = Math.max(0, (s.regionContentLeftCss ?? 0) - (baseRec.contentLeftCss ?? 0)) * scaleY;
          g.widthPx = s.regionWidthPx || 0;
          g.defaultHcss = (s.regionHeightPx || 0) / scaleY;
        }
      }
      groups.set(key, g);
    }
    // The base's shown panel can render a bit TALLER than the re-captured default mark (the widget's own trailing
    // box / padding / bottom border, just below the panel content the mark's region cropped), leaving a strip of
    // the old panel below the injected tabs. Grow the replace over ONLY that trailing tail — bounded to a fraction
    // of the MARK's own measured height (use-case-agnostic, not a blind whole-section removal) and stopping at the
    // first page-background gap. Fail-safe: 0 when no clean gap is found, so it can't eat real content.
    for (const g of groups.values()) {
      if (!g.hasDefault || !(g.widthPx > 0) || !Number.isFinite(g.anchorCss)) continue;
      const capPx = Math.round(g.defaultHcss * 0.5 * scaleY); // at most half the mark's height — a trailing tail, never a section
      const ext = await trailingPanelTailPx(await decodeBase(), g.leftPx, g.widthPx, (g.anchorCss + g.defaultHcss) * scaleY, capPx);
      if (ext > 0) g.defaultHcss += ext / scaleY;
    }
    (baseMatchBmp as ImageBitmap | null)?.close(); // assigned inside decodeBase's closure (TS can't narrow it)
    for (const s of deferred) {
      const cap = (s.viewportHeightCss || 0) * 2 || Infinity;
      const capturedHcss = s.regionHeightPx ? s.regionHeightPx / scaleY : 0;
      const g = groups.get(locKey(s));
      if (g?.hasDefault) {
        // A tab of a widget whose DEFAULT tab is among the marks: anchor the whole widget at the base position
        // and stack the tabs there in capture order. The first tab placed REPLACES the base's shown panel; the
        // rest INSERT right after it (the renderer stacks same-anchor marks in timeline order).
        place.set(s, { atCss: g.anchorCss, replaceHcss: g.placed ? 0 : Math.min(g.defaultHcss || capturedHcss, cap) });
        g.placed = true;
      } else {
        // Not in the base (new content the base never showed), or a widget whose default was NOT marked: keep
        // the base and INSERT by the captured LIVE area. Group a block's marks by their (stable) top so
        // overlapping marks share one insertion point, just past the block.
        const top = s.regionContentTopCss ?? 0;
        const topKey = Math.round(top / 4);
        let bottom = areaInsertBottomCss.get(topKey);
        if (bottom === undefined) { bottom = top + capturedHcss; areaInsertBottomCss.set(topKey, bottom); }
        place.set(s, { atCss: bottom, replaceHcss: 0 });
      }
    }
    // Build the injections in capture (timeline) order — the renderer breaks atYpx ties by this order.
    for (const s of snaps) {
      const p = place.get(s);
      if (!p) continue;
      let bytes: Uint8Array | null = null;
      let replacePx = p.replaceHcss * scaleY;
      let injLinks: LinkPx[] | undefined;
      if (s.kind === 'region' && s.regionWidthPx) {
        bytes = new Uint8Array(s.bytes);
        // G2: this mark's own links (block-relative CSS → its image px) ride the injection into the atlas.
        if (settings.links && s.links?.length) {
          const rScale = s.regionWidthPx / Math.max(1, s.viewportWidthCss);
          injLinks = s.links.map((l) => ({ top: l.yCss * rScale, left: l.xCss * rScale, w: l.wCss * rScale, h: l.hCss * rScale, url: l.href }));
        }
      } else {
        const c = await cropShotToRect(s, settings.imageFormat, settings.jpegQuality);
        if (c) {
          bytes = c.bytes;
          replacePx = c.hPx; // a Snap OVERWRITES the base region it covers (its own height), no duplication
        }
      }
      if (bytes) injections.push({ bytes, atYpx: p.atCss * scaleY, replaceBaseHpx: replacePx, links: injLinks });
    }
    // Atlas placement summary → recorded in the snapshots-debug metadata (below) so a bad splice can be
    // diagnosed from the SAVED file: which base rows each mark replaced/inserted, its whole-match anchor, and
    // whether trailing base content (e.g. a "Continue" button after a tab widget) was consumed by a replace.
    // Gated on debugTiles so production pays no extra decode.
    if (settings.debugTiles) {
      let baseHpx = 0;
      try { const bb = await createImageBitmap(new Blob([new Uint8Array(baseRec.bytes) as unknown as BlobPart])); baseHpx = bb.height; bb.close(); } catch { /* height best-effort */ }
      atlasDbg = {
        baseHpx,
        scaleY: +scaleY.toFixed(4),
        injections: injections.map((j) => ({ atYpx: Math.round(j.atYpx), replaceBaseHpx: Math.round(j.replaceBaseHpx) })),
        marks: snaps.filter((s) => s.kind === 'region').map((s) => { const p = place.get(s); return { topCss: Math.round(s.regionContentTopCss ?? -1), leftCss: Math.round(s.regionContentLeftCss ?? -1), wPx: s.regionWidthPx ?? 0, hPx: s.regionHeightPx ?? 0, isDefaultTab: s.isDefaultTab ?? null, anchorKeys: (s.anchorKeys ?? []).length, atCss: p ? Math.round(p.atCss) : null, replaceHcss: p ? Math.round(p.replaceHcss) : null }; }),
      };
    }
    // G2: base-page links (content-absolute CSS → base image px; scaleX≈scaleY at one DPR) laid over the
    // unmarked base; the renderer drops any that fall in a span an injection replaced.
    const baseLinks: LinkPx[] = settings.links
      ? (baseRec.links ?? []).map((l) => ({ top: l.yCss * scaleY, left: l.xCss * scaleY, w: l.wCss * scaleY, h: l.hCss * scaleY, url: l.href }))
      : [];
    rendered = await renderAtlasWithInjections({ bytes: new Uint8Array(baseRec.bytes), links: baseLinks }, injections, stackParams);
    if (dropped.length) droppedMsg = `Couldn't confidently place ${dropped.length} section${dropped.length === 1 ? '' : 's'} in the page (${dropped.join(', ')}), so ${dropped.length === 1 ? 'it was' : 'they were'} left out. Capture ${dropped.length === 1 ? 'it' : 'those'} on their own with a Mark-only run.`;
  } else if (hasPiece) {
    // WC-M11: marked regions with NO base → stack every piece (nothing lost or duplicated).
    const pieces: { bytes: Uint8Array; wPx: number; hPx: number; links?: LinkPx[] }[] = [];
    for (const s of snaps) {
      if (s.kind === 'region' && s.regionWidthPx && s.regionHeightPx) {
        // G2: map the region's block-relative CSS links into THIS piece's image px (css→px = regionWidthPx/
        // widthCss; viewportWidthCss stores the block width for a region). renderStackedImages adds the
        // per-piece centering offset. Gated on the links setting; empty otherwise.
        const scale = s.regionWidthPx / Math.max(1, s.viewportWidthCss);
        const links: LinkPx[] = settings.links
          ? (s.links ?? []).map((l) => ({ top: l.yCss * scale, left: l.xCss * scale, w: l.wCss * scale, h: l.hCss * scale, url: l.href }))
          : [];
        pieces.push({ bytes: new Uint8Array(s.bytes), wPx: s.regionWidthPx, hPx: s.regionHeightPx, links });
      } else {
        const cropped = await cropShotToRect(s, settings.imageFormat, settings.jpegQuality);
        if (cropped) pieces.push(cropped);
      }
    }
    rendered = await renderStackedImages(pieces, {
      paperSize: settings.paperSize,
      orientation: settings.orientation,
      format: settings.imageFormat,
      jpegQuality: settings.jpegQuality,
      title: tab?.title,
      url: tab?.url,
      stamp: settings.stamp,
      capturedAt: now.toLocaleString(),
    });
  } else {
    rendered = await renderFullPagePdf(tileBytes, {
      cropTopsCss,
      fullViewportWidthCss: first.viewportWidthCss,
      fullViewportHeightCss: first.viewportHeightCss,
      contentRectCss: { top: first.rect.top, left: first.rect.left, width: safeW, height: effVpH },
      paperSize: settings.paperSize,
      orientation: settings.orientation,
      format: settings.imageFormat,
      jpegQuality: settings.jpegQuality,
      title: tab?.title,
      url: tab?.url,
      stamp: settings.stamp,
      capturedAt: now.toLocaleString(),
      links,
      stitchMode: 'match', // dedupe overlap by pixels alone — the user's scroll gives no reliable estimate
    });
  }
  if (settings.debugTiles) {
    // Save the RAW snapshots (one per page) + the stitch metadata + the atlas placement, so a bad stitch can
    // be diagnosed from exactly what was captured and how it was spliced (mirrors full-page's tiles-debug).
    try {
      const dbg = await PDFDocument.create();
      dbg.setKeywords([
        `webclip-snapshots/1:${JSON.stringify({ scrollTops, effVpH, cropTopsCss, rects: snaps.map((s) => s.rect), clientHeights: snaps.map((s) => s.clientHeight), viewport: { w: first.viewportWidthCss, h: first.viewportHeightCss }, atlas: atlasDbg })}`,
      ]);
      for (const s of snaps) {
        const u = new Uint8Array(s.bytes);
        const img = settings.imageFormat === 'jpeg' ? await dbg.embedJpg(u) : await dbg.embedPng(u);
        const pg = dbg.addPage([img.width, img.height]);
        pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const dstamp = formatStamp(now);
      const dfn = buildFilename(settings.filenameTemplate, { domain: tab?.domain || 'snapshot', title: tab?.title || 'snapshot', date: dstamp.date, time: dstamp.time }).replace(/\.pdf$/, '.snapshots-debug.pdf');
      await downloadPdf(await dbg.save(), dfn, false);
    } catch {
      /* debug only — never block the real assembly */
    }
  }
  await clearSnapshots();
  const stamp = formatStamp(now);
  const filename = buildFilename(settings.filenameTemplate, {
    domain: tab?.domain || tab?.url || 'snapshot',
    title: tab?.title || 'snapshot',
    date: stamp.date,
    time: stamp.time,
  });
  await saveArtifacts(rendered.bytes, filename, { url: tab?.url || '', title: tab?.title || '', domain: tab?.domain || '' }, 'full-page', settings, {
    capturedAtUtc: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    captureId: crypto.randomUUID(),
  });
  const result = { ok: true as const, filename, pages: rendered.pageCount };
  const warns = [droppedMsg, rendered.downgraded ? 'Large capture saved as JPEG to keep the file size manageable.' : undefined].filter(Boolean);
  return warns.length ? { ...result, warning: warns.join(' ') } : result;
}

async function snapshotCancel(): Promise<{ ok: boolean }> {
  await clearSnapshots();
  await clearSessionState();
  const tabRes = await resolveActiveTab();
  if (tabRes.ok) {
    // removeSnapshotBar also clears any stranded mark overlay DOM (one fast script). The listener teardown is
    // fire-and-forget so Cancel can't stall on a heavy page.
    await removeSnapshotBar(tabRes.tab.tabId);
    await removeSessionKeys(tabRes.tab.tabId);
    void cancelMark(tabRes.tab.tabId).catch(() => undefined);
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) {
    sendResponse({ ok: false, error: makeError('UNKNOWN', 'Unrecognized message.') });
    return false;
  }

  switch (message.type) {
    case 'PING': {
      const res: PingResult = { ok: true, product: PRODUCT_NAME, version: VERSION };
      sendResponse(res);
      return false;
    }
    case 'GET_ACTIVE_TAB': {
      resolveActiveTab().then(sendResponse);
      return true; // async
    }
    case 'START_CAPTURE': {
      dispatchCapture(coerceSettings(message.settings)).then(sendResponse); // validate/clamp every field (T-2)
      return true; // async
    }
    case 'CANCEL_CAPTURE': {
      captureCancelled = true;
      sendResponse({ ok: true });
      return false;
    }
    case 'START_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) {
          await injectController(tabRes.tab.tabId);
          await startPick(tabRes.tab.tabId);
        }
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'PANE_PICKED': {
      // Selection only — do NOT capture. The user chooses when to capture (via the popup) so a picked
      // section is optional and cancelable. Confirm with a toast since the popup is closed while picking.
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await notifyInPage(tabRes.tab.tabId, 'WebClip: section selected. Open WebClip and press Capture — or clear it.');
      })().catch(() => undefined);
      return false;
    }
    case 'STOP_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await stopPick(tabRes.tab.tabId);
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'PICK_CANCELLED': {
      return false;
    }
    case 'CLEAR_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await clearPick(tabRes.tab.tabId);
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'HAS_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        sendResponse({ ok: true, picked: tabRes.ok ? await hasPick(tabRes.tab.tabId) : false });
      })().catch(() => sendResponse({ ok: true, picked: false }));
      return true; // async response
    }
    case 'SNAPSHOT_START': {
      snapshotStart(message.paperSize, message.orientation).then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'SNAPSHOT_START_ATLAS': {
      snapshotStartAtlas(message.paperSize, message.orientation).then(sendResponse).catch((e) => sendResponse({ ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not start composite capture.', { recoverable: true, technicalMessage: String(e) }) }));
      return true;
    }
    case 'SNAPSHOT_ADD': {
      snapshotAdd().then(sendResponse).catch((e) => sendResponse({ ok: false, error: makeError('SCREENSHOT_FAILED', 'Snapshot failed.', { recoverable: true, technicalMessage: String(e) }) }));
      return true;
    }
    case 'SNAPSHOT_MARK': {
      snapshotMark().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'REGION_MARKED': {
      regionMarked().then(sendResponse).catch((e) => sendResponse({ ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not capture the section.', { recoverable: true, technicalMessage: String(e) }) }));
      return true;
    }
    case 'MARK_CANCELLED': {
      // User pressed Esc during marking — restore the toolbar + reset the Mark button to idle.
      resolveActiveTab().then((r) => (r.ok ? snapshotCount().then((n) => showSnapshotBar(r.tab.tabId, n)).then(() => setMarkArmed(r.tab.tabId, false)) : undefined)).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'SNAPSHOT_MARK_CANCEL': {
      // Toolbar Mark button (toggled to Cancel) — leave mark mode and reset the button.
      resolveActiveTab().then((r) => (r.ok ? cancelMark(r.tab.tabId).then(() => setMarkArmed(r.tab.tabId, false)) : undefined)).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'SNAPSHOT_UNDO': {
      snapshotUndo().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    case 'SNAPSHOT_FINISH': {
      snapshotFinish().then(sendResponse).catch((e) => sendResponse({ ok: false, error: makeError('SCREENSHOT_FAILED', 'Could not assemble the snapshots.', { recoverable: true, technicalMessage: String(e) }) }));
      return true;
    }
    case 'SNAPSHOT_CANCEL': {
      snapshotCancel().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    default: {
      // Exhaustiveness: message is `never` here.
      sendResponse({ ok: false, error: makeError('UNKNOWN', 'Unhandled message type.') });
      return false;
    }
  }
});

// WC-M12 multi-lesson: when the SESSION's tab finishes navigating to a new page/lesson, re-inject the
// controller + toolbar + shortcuts so marking continues (marks compound across pages; Done assembles all).
// Works for same-origin navigation, where the tab keeps its activeTab grant — no host permission needed.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const sess = await getSessionState();
    if (!sess || !sess.active || sess.tabId !== tabId) return;
    try {
      await injectController(tabId);
      await showSnapshotBar(tabId, await snapshotCount());
      await installSessionKeys(tabId);
    } catch {
      // activeTab may be revoked on a cross-origin navigation — the user can re-open the popup to resume.
    }
  })();
});

// Keyboard command (§14): capture with the saved preferences (full-page or visible).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-full-page') {
    void loadSettings().then((s) => dispatchCapture(s));
  }
});

console.info(`[${PRODUCT_NAME}] service worker ready (v${VERSION}).`);
