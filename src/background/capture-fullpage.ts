// Full-page scroll-and-tile capture (WC-M4). Works for both document-scroll pages and pages
// whose content scrolls inside a panel (LinkedIn, Gmail, docs): the controller resolves the
// dominant scroller, we scroll IT and crop each screenshot to its box (§21). Restoration always
// runs in the finally path (§37); active-tab integrity is checked before every screenshot (§19.7).
import { PDFDocument } from 'pdf-lib';
import { MIN_CAPTURE_INTERVAL_MS, DEFAULT_TILE_OVERLAP_CSS } from '../shared/constants.js';
import { buildVerticalPositions } from '../shared/capture-plan.js';
import { computeCropTops } from '../shared/tiles.js';
import { renderFullPagePdf, renderFullPageImage, renderStackedImages, cropViewportBandCss } from '../renderer/pdf-renderer.js';
import { saveArtifacts } from './artifacts.js';
import { downloadPdf } from './downloads.js';
import { buildFilename, formatStamp } from '../shared/filename.js';
import { injectController, preparePage, scrollContext, scrollPageTo, setFixedHidden, restorePage, collectLinks, collectAnchors, collectTabPanels, modalBands, setScrollLock, measureTopFrozen } from './page-inject.js';
import { makeError } from '../shared/errors.js';
import type { CaptureErrorCode } from '../shared/errors.js';
import type { ActiveTabInfo, UserSettings, CaptureProgress, ScrollContext, PageLink } from '../shared/types.js';
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

/** Scroll the active scroller to the bottom so lazy content renders + true height is known (§19.3). */
export async function warmupScroller(tab: ActiveTabInfo, initial: ScrollContext, shouldCancel: () => boolean): Promise<ScrollContext> {
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

/**
 * Measure a FROZEN top header's height (CSS px) at capture time so the tiler can overlap by it and NOT lose
 * the content sitting behind it (operator: GitHub hides ~3 lines behind its file bar). DOM-based and
 * screenshot-free: scroll one viewport down (so a scroll-driven / sticky header is pinned), ask the page for the
 * height of the viewport-top-pinned chrome (`measureTopFrozen`), then scroll back. No extra captureVisibleTab
 * — an earlier pixel-probe version tripped the browser's 2-shots/second cap and aborted the whole capture.
 * Runs only for multi-tile pages; conservative (capped at 35% of the viewport). Errors → 0 (fail-safe).
 */
async function measureFrozenHeaderCss(tab: ActiveTabInfo, ctx: ScrollContext, effVpH: number, shouldCancel: () => boolean): Promise<number> {
  try {
    if (ctx.scrollHeight - ctx.clientHeight < effVpH) return 0; // single-screen content → no seams, no gap
    if (shouldCancel()) return 0;
    await assertActiveTab(tab);
    const h = await measureTopFrozen(tab.tabId); // scrolls the page itself to detect what stays pinned, then restores
    await scrollPageTo(tab.tabId, 0, 0); // ensure we start tiling from the top
    await sleep(40);
    return Math.max(0, Math.min(Math.round(h), Math.floor(effVpH * 0.35)));
  } catch {
    return 0; // fail-safe: no measurement → normal tiling
  }
}

/**
 * WC-M13 C4 — the shared scroll-&-tile engine. Scroll a resolved scroller top→bottom, capture a tile at each
 * planned position (re-hiding repeated fixed/sticky chrome per tile, reading the ACTUAL scroll at capture
 * time so the overlap crop matches the frame grabbed), and return the raw tiles + crop tops for the composer.
 * ONE implementation for the full-page capture AND the atlas base (and, from P2, the marked-region capture) —
 * so a completeness/stitch fix reaches every mode. `afterTile` runs after each capture (per-tile link
 * collection + progress). Throws {@link CaptureAbort} on cancel; callers that return an error object wrap it.
 */
async function scrollAndTile(
  tab: ActiveTabInfo,
  ctx: ScrollContext,
  effVpH: number,
  settings: UserSettings,
  shouldCancel: () => boolean,
  afterTile?: (index: number, total: number) => Promise<void> | void,
  extraOverlap = 0, // add to the tile overlap so content behind a frozen header is captured on the prior tile
): Promise<{ tileBytes: Uint8Array[]; actualYs: number[]; cropTopsCss: number[]; positions: number[]; tileCount: number }> {
  // Overlap = pinned-chrome height + a CONTENT margin. The correctness invariant for the frozen-header stitch
  // (renderer) is overlap ≥ chrome, so the exact-geometric crop removes the chrome AND leaves real content
  // shared between tiles. When a header is present we use a GENEROUS margin (≈0.12·viewport, min 48) so the
  // invariant holds even if the header was slightly under-measured or a tall element pins there — the thin
  // fixed-48 margin was what let untested documents lose a band at a seam. No header → the plain 48 (a normal
  // page's tiles overlap only for dedup/edge-trim; there is no chrome to clear).
  const chromeCss = Math.max(0, extraOverlap);
  const overlapCss = chromeCss > 0 ? chromeCss + Math.max(DEFAULT_TILE_OVERLAP_CSS, Math.round(effVpH * 0.12)) : DEFAULT_TILE_OVERLAP_CSS;
  const positions = buildVerticalPositions(ctx.scrollHeight, effVpH, overlapCss);
  const total = positions.length;
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
    if (wait > 0) await sleep(wait); // never exceed 2 captureVisibleTab/sec (§12, AC-008)
    // Re-hide overlays immediately before the screenshot — frameworks (React) can re-create them mid-capture,
    // so a one-time hide before the loop is not enough. Then wait a repaint so the shot grabs them gone.
    if (settings.suppressRepeatedFixedElements) {
      await setFixedHidden(tab.tabId, true);
      await sleep(REPAINT_MS);
    }
    await assertActiveTab(tab);
    // Read the scroll AT CAPTURE TIME, not right after scrolling: reflow/scroll-anchoring can nudge scrollTop
    // during the settle+hide+repaint waits, and the overlap crop must match the frame actually grabbed.
    actualYs.push((await getContext(tab)).scrollTop);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
    lastCaptureAt = Date.now();
    tileBytes.push(new Uint8Array(await (await fetch(dataUrl)).arrayBuffer()));
    if (afterTile) await afterTile(i, total);
  }
  const cropTopsCss = computeCropTops(actualYs, effVpH);
  return { tileBytes, actualYs, cropTopsCss, positions, tileCount: total };
}

/**
 * WC-M13 P2b — capture the CURRENTLY-ACTIVE scroller as one stitched image via the shared engine
 * (warmup → scroll-&-tile → overlap-matched compose). The caller sets the active scroller first (e.g. a
 * self-scrolling marked pane via `useMarkedBlockAsScroller`); this then warms it up, tiles it, and returns
 * the image cropped to that scroller's box — so a marked pane inherits the full-page path's completeness,
 * overlap-matching and lazy-warmup instead of the mark's weaker exact-position tiling. Assumes prepare +
 * scroll-lock are already in force (the mark path owns those); restores nothing itself.
 */
export async function captureScrollerImage(
  tab: ActiveTabInfo,
  settings: UserSettings,
  shouldCancel: () => boolean = () => false,
): Promise<import('../renderer/pdf-renderer.js').FullPageImage | { error: string }> {
  try {
    let ctx = await getContext(tab);
    if (settings.warmupLazyContent) ctx = await warmupScroller(tab, ctx, shouldCancel);
    const effVpH = effViewport(ctx);
    const { tileBytes, cropTopsCss } = await scrollAndTile(tab, ctx, effVpH, settings, shouldCancel);
    return await renderFullPageImage(tileBytes, {
      cropTopsCss,
      fullViewportWidthCss: ctx.fullViewportWidth,
      fullViewportHeightCss: ctx.fullViewportHeight,
      contentRectCss: { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: effVpH },
      format: settings.imageFormat,
      jpegQuality: settings.jpegQuality,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** WC-M12: capture the full page as ONE base-atlas image (+ geometry) for the composite capture mode.
 *  Same tiling as captureFullPage, but composites to an image and returns it instead of saving a PDF. */
export async function captureFullPageBase(
  tab: ActiveTabInfo,
  settings: UserSettings,
  shouldCancel: () => boolean = () => false,
): Promise<{ bytes: Uint8Array; wPx: number; hPx: number; scaleY: number; contentTopCss: number; contentLeftCss: number; anchors: import('../shared/types.js').Anchor[]; tabPanels: import('../shared/types.js').TabPanelExtent[]; links: PageLink[] } | { error: string }> {
  let prepared = false;
  try {
    await injectController(tab.tabId);
    await preparePage(tab.tabId, {
      suppressAnimations: settings.suppressAnimations,
      suppressRepeatedFixedElements: settings.suppressRepeatedFixedElements,
      declutter: settings.declutter,
      expandCollapsible: true,
    });
    prepared = true;
    await setScrollLock(tab.tabId, true); // user scroll can't disturb the tool's tiling during the base capture
    if (settings.suppressRepeatedFixedElements) await setFixedHidden(tab.tabId, true);
    let ctx = await getContext(tab);
    if (settings.warmupLazyContent) ctx = await warmupScroller(tab, ctx, shouldCancel);
    // Section-header anchors (content-Y) for later in-place splicing of marked/snapped sections.
    const anchors = await collectAnchors(tab.tabId);
    // Default tab-panel extents (content-Y): where each widget's default view ends, so other-tab marks
    // inject exactly after it (and a re-marked default patches in place). Measured now, while defaults show.
    const tabPanels = await collectTabPanels(tab.tabId);
    // G2: base-page links (content-absolute coords) so the atlas can lay clickable annotations over the
    // unmarked base. Collected post-warmup at the top; best-effort for virtualized content (like mode 1).
    const links = settings.links ? await collectLinks(tab.tabId) : [];
    const effVpH = effViewport(ctx);
    const format = settings.imageFormat;
    // Same frozen-header scroll-offset as captureFullPage: content behind a viewport-top-pinned header (e.g.
    // GitHub's file bar, which the suppressor can't hide) scrolls UNDER it and is otherwise LOST at each seam of
    // the automated base. Overlap the tiles by the header height so the prior tile carries those rows and the
    // stitch strips the repeat. Fail-safe 0 when nothing is frozen (identical to the old behaviour).
    const frozenHeaderCss = await measureFrozenHeaderCss(tab, ctx, effVpH, shouldCancel);
    // C4 shared engine — same scroll-&-tile as the full-page capture (no per-tile link/progress for the base
    // image). A cancel throws CaptureAbort here and is caught by this function's try/catch → { error }.
    const { tileBytes, cropTopsCss } = await scrollAndTile(tab, ctx, effVpH, settings, shouldCancel, undefined, frozenHeaderCss);
    const img = await renderFullPageImage(tileBytes, {
      cropTopsCss,
      fullViewportWidthCss: ctx.fullViewportWidth,
      fullViewportHeightCss: ctx.fullViewportHeight,
      contentRectCss: { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: effVpH },
      format,
      jpegQuality: settings.jpegQuality,
    });
    return { bytes: img.bytes, wPx: img.wPx, hPx: img.hPx, scaleY: img.scaleY, contentTopCss: ctx.rectTop, contentLeftCss: ctx.rectLeft, anchors, tabPanels, links };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (prepared) {
      await setScrollLock(tab.tabId, false);
      await restorePage(tab.tabId);
    }
  }
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
      expandCollapsible: true, // always best-effort open <details>/[hidden]/safe accordions (no user toggle;
      // reveals hidden content on a full capture, and is a harmless no-op on exclusive JS accordions)
    });
    prepared = true;
    await setScrollLock(tab.tabId, true); // lock user scroll so it can't disturb the tool's tiling capture
    // Hide fixed/sticky overlays (nav, chat/messaging widgets, floating promos) BEFORE measuring,
    // so they don't repeat down the capture and the measured height reflects their removal (§20).
    if (settings.suppressRepeatedFixedElements) {
      await setFixedHidden(tab.tabId, true);
    }

    let ctx = await getContext(tab);
    if (settings.warmupLazyContent) {
      ctx = await warmupScroller(tab, ctx, shouldCancel);
    }
    const effVpH = effViewport(ctx);
    // Collect page links progressively as we scroll through the capture (below), merged + deduped. A
    // ONE-SHOT collection at the top misses VIRTUALIZED content (long chat threads, feeds) that only
    // mounts its <a> links into the DOM while near the viewport — so those links weren't clickable.
    const linkMap = new Map<string, PageLink>();
    const mergeLinks = (arr: PageLink[]): void => {
      for (const l of arr) linkMap.set(`${l.href}@${Math.round(l.yCss)}`, l); // scroll-invariant content-Y key → dedupe
    };
    if (settings.links) mergeLinks(await collectLinks(tab.tabId)); // links visible at the top
    const format = settings.imageFormat;
    // Measure a frozen top header so the tiler overlaps by it and doesn't lose the content behind it (the
    // stitch then strips the header to one copy). Fail-safe: 0 (normal tiling) when there's no frozen header.
    const frozenHeaderCss = await measureFrozenHeaderCss(tab, ctx, effVpH, shouldCancel);
    // C4 shared engine: scroll-&-tile the resolved scroller; per tile, re-collect virtualized links + report.
    const { tileBytes, actualYs, cropTopsCss, positions, tileCount } = await scrollAndTile(tab, ctx, effVpH, settings, shouldCancel, async (i, t) => {
      // Virtualized content mounts its links as it enters the viewport, so links missed at the top are
      // picked up here (deduped by content-Y in mergeLinks).
      if (settings.links) mergeLinks(await collectLinks(tab.tabId));
      emitProgress({ phase: 'capturing', completed: i + 1, total: t, percent: Math.round(((i + 1) / t) * 90) });
    }, frozenHeaderCss);
    total = tileCount;

    // Page-mutation warning (§19.8).
    const finalCtx = await getContext(tab);
    const grew = finalCtx.scrollHeight - ctx.scrollHeight;
    const threshold = Math.max(200, ctx.scrollHeight * 0.02);
    const grewWarn = grew > threshold;

    if (shouldCancel()) throw new CaptureAbort('CANCELLED', 'Capture cancelled.');
    emitProgress({ phase: 'rendering', completed: total, total, percent: 92 });
    const links = [...linkMap.values()];
    const contentRectCss = { top: ctx.rectTop, left: ctx.rectLeft, width: ctx.rectWidth, height: effVpH };
    // When the scroller is an open modal's inner pane, the modal's fixed HEADER (title/progress) and FOOTER
    // (action buttons) sit OUTSIDE that pane. Stack them around the tiled body so the dialog reads whole:
    // body via the same stitch, header/footer lifted once from a tile (they're identical in every tile).
    // G2: the body's links (collected relative to the pane's content top) ride the body piece as clickable
    // annotations; renderStackedImages offsets them past the header. Header/footer band links are not carried.
    const bands = await modalBands(tab.tabId);
    let rendered;
    if (bands && (bands.header || bands.footer)) {
      const body = await renderFullPageImage(tileBytes, {
        cropTopsCss,
        fullViewportWidthCss: ctx.fullViewportWidth,
        fullViewportHeightCss: ctx.fullViewportHeight,
        contentRectCss,
        format,
        jpegQuality: settings.jpegQuality,
      });
      // Map pane-content links → body image px (scaleX≈scaleY at one DPR). Fail-safe: bad geometry yields
      // no links, never a broken piece.
      const bodyLinks = settings.links
        ? links.map((l) => ({ top: l.yCss * body.scaleY, left: l.xCss * body.scaleY, w: l.wCss * body.scaleY, h: l.hCss * body.scaleY, url: l.href }))
        : [];
      const pieces: { bytes: Uint8Array; wPx: number; hPx: number; links?: typeof bodyLinks }[] = [];
      if (bands.header) pieces.push(await cropViewportBandCss(tileBytes[0], bands.header, ctx.fullViewportWidth, ctx.fullViewportHeight, format, settings.jpegQuality));
      pieces.push({ bytes: body.bytes, wPx: body.wPx, hPx: body.hPx, links: bodyLinks });
      if (bands.footer) pieces.push(await cropViewportBandCss(tileBytes[tileBytes.length - 1], bands.footer, ctx.fullViewportWidth, ctx.fullViewportHeight, format, settings.jpegQuality));
      rendered = await renderStackedImages(pieces, {
        paperSize: settings.paperSize,
        orientation: settings.orientation,
        format,
        jpegQuality: settings.jpegQuality,
        title: tab.title,
        url: tab.url,
        stamp: settings.stamp,
        capturedAt: new Date().toLocaleString(),
      });
    } else {
      rendered = await renderFullPagePdf(tileBytes, {
        cropTopsCss,
        fullViewportWidthCss: ctx.fullViewportWidth,
        fullViewportHeightCss: ctx.fullViewportHeight,
        contentRectCss,
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
    }

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
    if (ctx.frameContentUncaptured)
      warnings.push(
        "This page shows its content inside an embedded frame WebClip can't scroll into, so this saved the visible area. Scroll within the frame and use ‘Pick a section’, or switch to visible-area capture, to grab more.",
      );
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
      await setScrollLock(tab.tabId, false);
      await restorePage(tab.tabId);
    }
  }
}
