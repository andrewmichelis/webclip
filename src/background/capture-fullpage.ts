// Full-page scroll-and-tile capture. Works for both document-scroll pages and pages
// whose content scrolls inside a panel (LinkedIn, Gmail, docs): the controller resolves the
// dominant scroller, we scroll IT and crop each screenshot to its box. Restoration always
// runs in the finally path; active-tab integrity is checked before every screenshot.
import { PDFDocument } from 'pdf-lib';
import { MIN_CAPTURE_INTERVAL_MS, DEFAULT_TILE_OVERLAP_CSS } from '../shared/constants.js';
import { buildVerticalPositions } from '../shared/capture-plan.js';
import { computeCropTops } from '../shared/tiles.js';
import { renderFullPagePdf } from '../renderer/pdf-renderer.js';
import { saveArtifacts } from './artifacts.js';
import { downloadPdf } from './downloads.js';
import { buildFilename, formatStamp } from '../shared/filename.js';
import { injectController, preparePage, scrollContext, scrollPageTo, setFixedHidden, restorePage, collectLinks } from './page-inject.js';
import { makeError } from '../shared/errors.js';
import type { CaptureErrorCode } from '../shared/errors.js';
import type { ActiveTabInfo, UserSettings, CaptureProgress, ScrollContext } from '../shared/types.js';
import type { StartCaptureResult } from '../shared/messages.js';

const SETTLE_MS = 120;
const REPAINT_MS = 100; // let the browser repaint hidden overlays before the screenshot
const WARMUP_SETTLE_MS = 150;
const WARMUP_MAX_STEPS = 60;

class CaptureAbort extends Error {
  constructor(public readonly code: CaptureErrorCode, message: string) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Troubleshooting: save the raw tiles (one per page, uncropped) + the crop metadata (in Keywords)
 *  as a single PDF, so a stitching problem can be reproduced offline from exactly what was captured. */
async function saveTilesDebug(
  tileBytes: Uint8Array[],
  meta: Record<string, unknown>,
  filename: string,
  format: 'png' | 'jpeg',
): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setKeywords([`webclip-tiles/1:${JSON.stringify(meta)}`]);
  for (const bytes of tileBytes) {
    const img = format === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  await downloadPdf(await doc.save(), filename, false);
}

function emitProgress(p: CaptureProgress): void {
  chrome.runtime.sendMessage({ type: 'JOB_PROGRESS', payload: p }).catch(() => undefined);
}

async function assertActiveTab(tab: ActiveTabInfo): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active || active.id !== tab.tabId) {
    throw new CaptureAbort('ACTIVE_TAB_CHANGED', 'You switched tabs during capture, so it was stopped.');
  }
  if (active.url && tab.url && active.url !== tab.url) {
    throw new CaptureAbort('PAGE_NAVIGATED', 'The page changed while capturing, so it was stopped.');
  }
}

async function getContext(tab: ActiveTabInfo): Promise<ScrollContext> {
  const ctx = await scrollContext(tab.tabId);
  if (!ctx) throw new Error('page controller unavailable (scrollContext)');
  return ctx;
}

/** Effective capturable viewport of the active scroller (CSS px). */
function effViewport(ctx: ScrollContext): number {
  return Math.max(1, Math.min(ctx.clientHeight, ctx.rectHeight || ctx.clientHeight));
}

/** Scroll the active scroller to the bottom so lazy content renders + true height is known. */
async function warmupScroller(tab: ActiveTabInfo, initial: ScrollContext, shouldCancel: () => boolean): Promise<ScrollContext> {
  const step = Math.max(200, Math.floor(effViewport(initial) * 0.9));
  let last = initial;
  let y = 0;
  for (let n = 0; n < WARMUP_MAX_STEPS; n++) {
    const bottom = last.scrollHeight - last.clientHeight;
    if (y >= bottom) break;
    y = Math.min(y + step, bottom);
    if (shouldCancel()) throw new CaptureAbort('CANCELLED', 'Capture cancelled.');
    await assertActiveTab(tab);
    await scrollPageTo(tab.tabId, 0, y);
    await sleep(WARMUP_SETTLE_MS);
    last = await getContext(tab);
  }
  await scrollPageTo(tab.tabId, 0, 0);
  await sleep(80);
  return getContext(tab);
}

export async function captureFullPage(
  tab: ActiveTabInfo,
  settings: UserSettings,
  shouldCancel: () => boolean = () => false,
): Promise<StartCaptureResult> {
  let prepared = false;
  let total = 1;
  try {
    emitProgress({ phase: 'preparing', completed: 0, total, percent: 0 });
    await injectController(tab.tabId);
    await preparePage(tab.tabId, {
      suppressAnimations: settings.suppressAnimations,
      suppressRepeatedFixedElements: settings.suppressRepeatedFixedElements,
      declutter: settings.declutter,
    });
    prepared = true;
    // Hide fixed/sticky overlays (nav, chat/messaging widgets, floating promos) BEFORE measuring,
    // so they don't repeat down the capture and the measured height reflects their removal.
    if (settings.suppressRepeatedFixedElements) {
      await setFixedHidden(tab.tabId, true);
    }

    let ctx = await getContext(tab);
    if (settings.warmupLazyContent) {
      ctx = await warmupScroller(tab, ctx, shouldCancel);
    }
    const effVpH = effViewport(ctx);
    // Collect page links now (panel at the top of its content, layout settled) for PDF link annotations.
    const links = settings.links ? await collectLinks(tab.tabId) : [];
    const positions = buildVerticalPositions(ctx.scrollHeight, effVpH, DEFAULT_TILE_OVERLAP_CSS);
    total = positions.length;

    const format = settings.imageFormat;
    const shotOpts: chrome.tabs.CaptureVisibleTabOptions =
      format === 'jpeg' ? { format: 'jpeg', quality: Math.round(settings.jpegQuality * 100) } : { format: 'png' };

    const tileBytes: Uint8Array[] = [];
    const actualYs: number[] = [];
    let lastCaptureAt = 0;
    for (let i = 0; i < total; i++) {
      if (shouldCancel()) throw new CaptureAbort('CANCELLED', 'Capture cancelled.');
      await assertActiveTab(tab);
      await scrollPageTo(tab.tabId, 0, positions[i]);
      await sleep(SETTLE_MS);
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait); // never exceed 2 captureVisibleTab/sec
      // Re-hide overlays immediately before the screenshot — frameworks (React) can re-render or
      // re-create them mid-capture, so a one-time hide before the loop is not enough. Then wait a
      // repaint so captureVisibleTab grabs the frame WITH the overlay already gone.
      if (settings.suppressRepeatedFixedElements) {
        await setFixedHidden(tab.tabId, true);
        await sleep(REPAINT_MS);
      }
      await assertActiveTab(tab);
      // Read the scroll position AT CAPTURE TIME, not right after scrolling: reflow / scroll-anchoring
      // can nudge scrollTop during the settle+hide+repaint waits, and the overlap crop must match the
      // frame we actually grab — otherwise a thin band is sliced out of a line/table at the seam.
      actualYs.push((await getContext(tab)).scrollTop);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
      lastCaptureAt = Date.now();
      tileBytes.push(new Uint8Array(await (await fetch(dataUrl)).arrayBuffer()));
      emitProgress({ phase: 'capturing', completed: i + 1, total, percent: Math.round(((i + 1) / total) * 90) });
    }

    // Page-mutation warning.
    const finalCtx = await getContext(tab);
    const grew = finalCtx.scrollHeight - ctx.scrollHeight;
    const threshold = Math.max(200, ctx.scrollHeight * 0.02);
    const grewWarn = grew > threshold;

    if (shouldCancel()) throw new CaptureAbort('CANCELLED', 'Capture cancelled.');
    emitProgress({ phase: 'rendering', completed: total, total, percent: 92 });
    const cropTopsCss = computeCropTops(actualYs, effVpH);
    const rendered = await renderFullPagePdf(tileBytes, {
      cropTopsCss,
      fullViewportWidthCss: ctx.fullViewportWidth,
      fullViewportHeightCss: ctx.fullViewportHeight,
      contentRectCss: { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: effVpH },
      paperSize: settings.paperSize, // AUTO -> one continuous page; A4/LETTER -> paginated with content-aware breaks
      orientation: settings.orientation,
      format,
      jpegQuality: settings.jpegQuality,
      title: tab.title,
      url: tab.url,
      stamp: settings.stamp,
      capturedAt: new Date().toLocaleString(),
      links,
    });

    emitProgress({ phase: 'downloading', completed: total, total, percent: 98 });
    const now = new Date();
    const stamp = formatStamp(now);
    const filename = buildFilename(settings.filenameTemplate, {
      domain: tab.domain || tab.url,
      title: tab.title,
      date: stamp.date,
      time: stamp.time,
    });
    await saveArtifacts(rendered.bytes, filename, { url: tab.url, title: tab.title, domain: tab.domain }, 'full-page', settings, {
      capturedAtUtc: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      captureId: crypto.randomUUID(),
    });
    if (settings.debugTiles) {
      await saveTilesDebug(
        tileBytes,
        { actualYs, positions, effVpH, cropTopsCss, fullViewportWidthCss: ctx.fullViewportWidth, fullViewportHeightCss: ctx.fullViewportHeight, contentRectCss: { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: effVpH }, format },
        filename.replace(/\.pdf$/, '.tiles-debug.pdf'),
        format,
      );
    }
    const warnings: string[] = [];
    if (grewWarn) warnings.push('The page kept loading while capturing; the PDF covers what was captured.');
    if (rendered.downgraded) warnings.push('Large capture saved as JPEG to keep the file size manageable.');
    const warning = warnings.length ? warnings.join(' ') : undefined;
    const base = { ok: true as const, filename, pages: rendered.pageCount };
    return warning ? { ...base, warning } : base;
  } catch (e) {
    if (e instanceof CaptureAbort) return { ok: false, error: makeError(e.code, e.message, { recoverable: true }) };
    return {
      ok: false,
      error: makeError('SCREENSHOT_FAILED', 'Full-page capture failed. Please try again.', {
        recoverable: true,
        technicalMessage: e instanceof Error ? e.message : String(e),
      }),
    };
  } finally {
    if (prepared) {
      emitProgress({ phase: 'restoring', completed: total, total, percent: 100 });
      await restorePage(tab.tabId);
    }
  }
}
