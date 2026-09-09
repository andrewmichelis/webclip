// PDF renderer: turns captured screenshot tiles into a PDF — a single visible-area page, one
// continuous full-page (AUTO), or content-aware A4/Letter pagination — with overlap-matched
// tile stitching, frozen-header handling, atlas splicing, and clickable link annotations.
// pdf-lib is pure JS (no DOM/canvas), so this runs in the MV3 service worker and in tests.
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { PRODUCT_NAME, VERSION } from '../shared/constants.js';
import { contentSlices, findBreakRow, needsJpegFallback, refineOverlap, matchOverlap } from '../shared/tiles.js';
import { encodeBreakProfile } from '../shared/resplit-plan.js';
import { embedStampFonts, drawHeader, drawFooter, HEADER_BAND_PT, FOOTER_BAND_PT, type StampData, type StampFonts } from './stamp.js';
import type { PaperSize, Orientation, ImageFormat, PageLink } from '../shared/types.js';
import type { PDFPage } from 'pdf-lib';

const PX_TO_PT = 72 / 96; // CSS px (96 dpi) -> PDF points (72 dpi)
const PAGE_PT: Record<'A4' | 'LETTER', [number, number]> = {
  A4: [595.28, 841.89],
  LETTER: [612, 792],
};
const MARGIN_PT = 18;

export interface RenderImage {
  bytes: Uint8Array;
  format: ImageFormat;
}
export interface RenderOptions {
  paperSize: PaperSize;
  orientation: Orientation;
  title?: string;
  url?: string;
  stamp?: boolean; // draw the header/footer stamp on the single visible-area page
  capturedAt?: string;
}

/** Render a single screenshot into one PDF page. Returns the serialized PDF bytes. */
export async function renderImageToPdfBytes(image: RenderImage, opts: RenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer(`${PRODUCT_NAME} ${VERSION}`);
  doc.setCreator(PRODUCT_NAME);
  if (opts.title) doc.setTitle(opts.title);
  if (opts.url) doc.setSubject(opts.url);

  const img = image.format === 'jpeg' ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes);
  const imgWpt = img.width * PX_TO_PT;
  const imgHpt = img.height * PX_TO_PT;
  const sc = await prepareStamp(doc, opts);

  if (opts.paperSize === 'AUTO') {
    // One page exactly matching the capture aspect ratio (+ header/footer bands when stamping).
    const page = doc.addPage([imgWpt, imgHpt + sc.bandTop + sc.bandBottom]);
    page.drawImage(img, { x: 0, y: sc.bandBottom, width: imgWpt, height: imgHpt });
    drawStampPages(doc, sc, true, imgWpt, imgHpt + sc.bandTop + sc.bandBottom, imgHpt);
  } else {
    let [pw, ph] = PAGE_PT[opts.paperSize];
    const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && img.width > img.height);
    if (landscape) [pw, ph] = [ph, pw];
    const page = doc.addPage([pw, ph]);
    const availW = pw - 2 * MARGIN_PT;
    const availH = ph - 2 * MARGIN_PT;
    const scale = Math.min(availW / imgWpt, availH / imgHpt);
    const w = imgWpt * scale;
    const h = imgHpt * scale;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    drawStampPages(doc, sc, false, pw - 2 * MARGIN_PT, ph, 0);
  }

  return doc.save();
}

// ---- Full-page (WC-M4): continuous fit-to-width pagination across pages (§28) ----

export interface PageGeometry {
  pageWpt: number;
  pageHpt: number;
  contentWidthPt: number;
  contentHeightPt: number;
  scalePtPerPx: number;
  pageContentHeightPx: number; // how many source px fit on one page's content area
}

/** Pure page geometry for fit-to-width flow. Unit-tested. Full-page defaults to portrait. */
export function pageContentGeometry(paperSize: 'A4' | 'LETTER', orientation: Orientation, contentWidthPx: number): PageGeometry {
  const [pw0, ph0] = PAGE_PT[paperSize];
  const landscape = orientation === 'landscape';
  const pageWpt = landscape ? ph0 : pw0;
  const pageHpt = landscape ? pw0 : ph0;
  const contentWidthPt = pageWpt - 2 * MARGIN_PT;
  const contentHeightPt = pageHpt - 2 * MARGIN_PT;
  const scalePtPerPx = contentWidthPx > 0 ? contentWidthPt / contentWidthPx : 1;
  const pageContentHeightPx = Math.max(1, Math.floor(contentHeightPt / scalePtPerPx));
  return { pageWpt, pageHpt, contentWidthPt, contentHeightPt, scalePtPerPx, pageContentHeightPx };
}

export interface FullPageResult {
  bytes: Uint8Array;
  pageCount: number;
  downgraded?: boolean; // PNG was auto-switched to JPEG because the capture was very large (§46.3)
}

export interface FullPageRenderParams {
  cropTopsCss: number[]; // overlap-crop per tile (based on the effective scroll viewport), CSS px
  fullViewportWidthCss: number; // window.innerWidth (to derive screenshot scale)
  fullViewportHeightCss: number; // window.innerHeight
  contentRectCss: { top: number; left: number; width: number; height: number }; // panel box to keep from each screenshot
  paperSize: PaperSize; // AUTO -> one continuous page (screen); A4/LETTER -> printable, paginated with content-aware breaks
  orientation: Orientation;
  format: ImageFormat;
  jpegQuality: number;
  title?: string;
  url?: string;
  stamp?: boolean; // draw a header (title) on page 1 + a footer (URL · capture time · page) on every page
  capturedAt?: string; // human-readable capture time for the footer
  links?: PageLink[]; // meaningful page links -> clickable PDF link annotations (positions in panel CSS px)
  // How to determine the overlap crop between adjacent tiles: 'scroll' refines the scroll-based estimate
  // (full-page capture); 'match' finds the overlap by pixels ALONE (manual snapshot mode, WC-M10, where
  // the user's scrolling gives no reliable estimate). Default 'scroll'.
  stitchMode?: 'scroll' | 'match';
}

/** How far up (as a fraction of a page) a content-aware break may pull the split to land on
 *  whitespace — the cap on trailing empty space, raised to 25% to keep tall bubbles/tables intact. */
const BREAK_LOOKBACK_FRACTION = 0.25;
/** Extra breathing room at the top of every printable page, beyond the base margin. */
const TOP_EXTRA_PT = 14;
/** Max non-background fraction for a row to count as a true whitespace gap (≤1% of the width is ink). */
const BLANK_FRACTION = 0.01;
/** AUTO one-page rendering composites in vertical strips so a very tall capture is not blocked by the
 *  browser's single-canvas limit (~32767px) — the strips still stack onto ONE PDF page. */
const ONE_TALL_STRIP_MAX_PX = 16000;
const ONE_TALL_STRIP_MAX_AREA = 24_000_000; // bound each strip's pixel area (memory + encode cost)

/** Per-channel tolerance for calling a pixel "background". Wide enough for JPEG noise, tight enough
 *  to exclude coloured chat bubbles / table fills / cards from counting as whitespace. */
const BG_COLOR_TOL = 12;
type RGB = [number, number, number];

/** Dominant (background) colour of a region by mode over a coarse grid — robust to light/dark pages. */
// `qMask` is the per-channel quantization mask: the default 0xf8 buckets by /8. A COARSER mask (e.g. 0xe0,
// /32) merges near-identical shades — needed by the frozen-band detector, where a light page background is
// spread across several off-white shades (245/247/250…) and would otherwise be out-voted, bucket by bucket,
// by a single large solid-colour content block (a dark hero/CTA) that the true background is not.
export function detectBackground(data: Uint8ClampedArray, width: number, height: number, qMask = 0xf8): RGB {
  const buckets = new Map<number, number>();
  const sx = Math.max(1, Math.floor(width / 64));
  const sy = Math.max(1, Math.floor(height / 64));
  let bestKey = 0xf8f8f8;
  let bestCount = -1;
  for (let y = 0; y < height; y += sy) {
    for (let x = 0; x < width; x += sx) {
      const o = (y * width + x) * 4;
      const key = ((data[o] & qMask) << 16) | ((data[o + 1] & qMask) << 8) | (data[o + 2] & qMask); // quantize by qMask
      const c = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, c);
      if (c > bestCount) {
        bestCount = c;
        bestKey = key;
      }
    }
  }
  return [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}

/**
 * The PAGE background for the frozen-band detector — the ONE estimate that has repeatedly mis-fired. The default
 * detectBackground (/8 quantization) picks the single most common colour bucket, but a light page background
 * spread across several near-white shades (245 / 247 / 250 …) splits into several buckets, EACH smaller than one
 * solid dark content block (a hero / CTA). The dark block then wins the "background" vote, the light band reads as
 * "ink", and a shared blank edge is mis-detected as a FROZEN FOOTER whose skipBottom collapses the seam overlap —
 * the Wind River dark-hero capture that doubled content at every fold. Fix: quantize COARSELY (/32) so those
 * near-white shades MERGE into one light majority bucket that out-votes the dark block, then CENTRE the bucket on
 * its real shade (0xe0 floors 245→224; centred 224+15 = 239 ≈ the real off-white) so the background's own pixels
 * are not themselves counted as ink. Pure; unit-tested (see pdf-renderer.test.ts). Changing the mask back to /8
 * reintroduces the false footer — the test guards exactly that.
 */
export function frozenBandBackground(data: Uint8ClampedArray, width: number, height: number): RGB {
  const Q = 0xe0; // /32 — merge near-identical shades into one bucket
  const half = (~Q & 0xff) >> 1; // coarse-bucket half-width → centre on the real shade
  const bg = detectBackground(data, width, height, Q);
  return [Math.min(255, bg[0] + half), Math.min(255, bg[1] + half), Math.min(255, bg[2] + half)];
}

/** Fraction of a row's sampled pixels that differ from the background beyond tolerance (0 = pure
 *  background). A row inside a coloured bubble/table scores high (its fill ≠ page background), so it is
 *  NOT a valid break — only true inter-element gaps (page background across the width) score ≈0. */
function rowNonBgFraction(data: Uint8ClampedArray, rowOff: number, width: number, step: number, bg: RGB): number {
  let non = 0;
  let n = 0;
  for (let x = 0; x < width; x += step) {
    const o = rowOff + x * 4;
    if (Math.abs(data[o] - bg[0]) > BG_COLOR_TOL || Math.abs(data[o + 1] - bg[1]) > BG_COLOR_TOL || Math.abs(data[o + 2] - bg[2]) > BG_COLOR_TOL) non++;
    n++;
  }
  return n > 0 ? non / n : 0;
}

/**
 * Per-row "ink" = non-background fraction, for rows [fromY, regionHeight). Rows above `fromY` are
 * Infinity so findBreakRow never breaks there. The whole region is read (to detect the background
 * reliably), then each window row is scored. `blankThreshold` is a FRACTION (see BLANK_FRACTION).
 */
function computeRowInk(ctx: OffscreenCanvasRenderingContext2D, width: number, regionHeight: number, fromY: number): number[] {
  const ink = new Array<number>(regionHeight).fill(Infinity);
  if (regionHeight <= 0) return ink;
  const { data } = ctx.getImageData(0, 0, width, regionHeight);
  const bg = detectBackground(data, width, regionHeight);
  const step = width > 1400 ? 2 : 1;
  for (let y = Math.max(0, fromY); y < regionHeight; y++) ink[y] = rowNonBgFraction(data, y * width * 4, width, step, bg);
  return ink;
}

/**
 * Extract whitespace runs (true gaps between elements — rows that are the page background across their
 * width) from a composited canvas, scanning in bounded strips to keep memory sane on long pages.
 * Returned as [startPx, lengthPx] pairs — a compact profile stored in the AUTO PDF so a later re-split
 * lands on the SAME gaps (resplit-plan.ts). Coarsened if a page is extremely gappy, to bound size.
 */
function computeBlankGaps(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, blankThreshold: number): [number, number][] {
  const STRIP = 4096;
  const step = width > 1400 ? 2 : 1;
  let gaps: [number, number][] = [];
  let runStart = -1;
  let bg: RGB | null = null;
  for (let y0 = 0; y0 < height; y0 += STRIP) {
    const h = Math.min(STRIP, height - y0);
    const { data } = ctx.getImageData(0, y0, width, h);
    if (!bg) bg = detectBackground(data, width, h); // detect once (first strip) and reuse for consistency
    for (let r = 0; r < h; r++) {
      const blank = rowNonBgFraction(data, r * width * 4, width, step, bg) <= blankThreshold;
      const y = y0 + r;
      if (blank && runStart < 0) runStart = y;
      if (!blank && runStart >= 0) {
        gaps.push([runStart, y - runStart]);
        runStart = -1;
      }
    }
  }
  if (runStart >= 0) gaps.push([runStart, height - runStart]);
  // Keep the profile small: if a page has thousands of line gaps, keep only the meatier ones.
  if (gaps.length > 4000) gaps = gaps.filter(([, len]) => len >= 3);
  return gaps;
}

/**
 * Refine each tile's overlap crop by matching the previous tile's BOTTOM band against this tile's top,
 * rather than trusting the scroll-position estimate alone. Scroll drift and mid-capture reflow
 * (virtualized feeds, e.g. long chat threads or infinite-scroll timelines) make the scroll-based
 * overlap off by a line or two, which shows up
 * as a sliced or colliding line at the seam. We slide a small template over a search window and pick
 * the offset that best matches (with a gentle bias toward the estimate so blank overlaps stay put).
 * Decodes each tile once WITHOUT touching the main decode cache, so bounded memory is preserved.
 */
async function alignCropTops(
  tileBytes: Uint8Array[],
  estCropPx: number[],
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  mode: 'scroll' | 'match' = 'scroll',
  skipTop = 0, // frozen-header rows at each tile's top — the scroll matcher matches the content BELOW them
  skipBottom = 0, // frozen-footer rows at each tile's bottom — matched content is ABOVE them
): Promise<number[]> {
  const refined = estCropPx.slice();
  if (tileBytes.length < 2) return refined;
  // Panel-cropped RGBA of a tile — decoded fresh and freed here (main decode cache untouched → bounded memory).
  const panelData = async (i: number): Promise<Uint8ClampedArray> => {
    const bmp = await createImageBitmap(new Blob([tileBytes[i] as unknown as BlobPart]));
    const cv = new OffscreenCanvas(rw, rh);
    const cx = cv.getContext('2d');
    if (!cx) throw new Error('2d canvas context unavailable');
    cx.drawImage(bmp, rx, ry, rw, rh, 0, 0, rw, rh);
    bmp.close();
    return cx.getImageData(0, 0, rw, rh).data;
  };
  let prev = await panelData(0);
  for (let i = 1; i < tileBytes.length; i++) {
    const cur = await panelData(i);
    refined[i] = mode === 'match' ? matchOverlap(prev, cur, rw, rh, estCropPx[i]) : refineOverlap(prev, cur, rw, rh, estCropPx[i], 150, skipTop, skipBottom);
    prev = cur;
  }
  return refined;
}

/**
 * Detect a FROZEN band — a header/footer bar pinned to the viewport edge that renders IDENTICALLY across the
 * tiles where it's frozen (a `position:fixed` or JS-scroll-driven bar the DOM suppressor can't catch at
 * scroll 0), so it repeats down the stitch. The operator's key insight: compare the tiles where the bar is in
 * its FROZEN state, NOT the edge tile that shows the real, different content:
 *   • header (edge='top') — the frozen bar is the SCROLLED-state header, identical in tiles 1..N-1; tile 0
 *     (top of page) shows the natural, taller header and is KEPT. Strip the band from tiles 1..N-1.
 *   • footer (edge='bottom') — the frozen bar is identical in tiles 0..N-2; the LAST tile shows the real page
 *     end and is KEPT. Strip the band from tiles 0..N-2.
 * A row is part of the band only if it carries INK whose pixels are IDENTICAL across the compared tiles —
 * matching on the ink (not the whole row) separates a real frozen bar (its text/toolbar repeats exactly) from
 * a similar background (no ink) and from content (ink differs), and tolerates a small varying corner (GitHub
 * swaps a search box for "↑ Top" once scrolled). Returns the band depth in panel device-px, 0 if not
 * confidently frozen (fail-safe → normal stitch). Errors → 0.
 */
async function detectFrozenBand(tileBytes: Uint8Array[], rx: number, ry: number, rw: number, rh: number, edge: 'top' | 'bottom'): Promise<number> {
  try {
    const N = tileBytes.length;
    if (N < 3 || rw < 8 || rh < 24) return 0;
    const maxBand = Math.min(Math.floor(rh * 0.4), rh - 1);
    if (maxBand < 12) return 0;
    // Compare only the tiles where the bar is frozen, excluding the edge tile that legitimately differs.
    const from = edge === 'top' ? 1 : 0;
    const to = edge === 'top' ? N - 1 : N - 2; // inclusive
    if (to - from + 1 < 2) return 0;
    const span = to - from;
    const k = Math.min(5, span + 1);
    const pick = new Set<number>();
    for (let j = 0; j < k; j++) pick.add(from + Math.round((j * span) / (k - 1)));
    const idxs = [...pick];
    const readBand = async (i: number): Promise<Uint8ClampedArray> => {
      const bmp = await createImageBitmap(new Blob([tileBytes[i] as unknown as BlobPart]));
      const cv = new OffscreenCanvas(rw, maxBand);
      const cx = cv.getContext('2d');
      if (!cx) throw new Error('2d canvas context unavailable');
      const sy = edge === 'top' ? ry : ry + rh - maxBand; // top rows, or the bottom-most rows of the panel
      cx.drawImage(bmp, rx, sy, rw, maxBand, 0, 0, rw, maxBand);
      bmp.close();
      return cx.getImageData(0, 0, rw, maxBand).data;
    };
    const bands = await Promise.all(idxs.map(readBand));
    const ref = bands[0];
    // Background must be the PAGE background, not the dominant colour of this read band. The band is only the
    // edge-most 40% of the panel, so a large content block near the edge (e.g. a full-width dark CTA/hero above
    // the page-end blank) would be picked as "background" — then the real light background reads as ink and a
    // shared blank tail masquerades as a frozen bar (false footer that collapses the seam overlap). Sample the
    // reference tile's FULL content region (downsampled, smoothing off) so the majority colour is the true page
    // background — via frozenBandBackground, which merges near-white shades so a single dark block can't win.
    // Fall back to the band-local estimate if the extra read fails.
    let bg = frozenBandBackground(ref, rw, maxBand);
    try {
      const rbmp = await createImageBitmap(new Blob([tileBytes[idxs[0]] as unknown as BlobPart]));
      const bw = Math.min(rw, 256), bh = Math.min(rh, 256);
      const bc = new OffscreenCanvas(bw, bh);
      const bx = bc.getContext('2d');
      if (bx) {
        bx.imageSmoothingEnabled = false;
        bx.drawImage(rbmp, rx, ry, rw, rh, 0, 0, bw, bh);
        bg = frozenBandBackground(bx.getImageData(0, 0, bw, bh).data, bw, bh);
      }
      rbmp.close();
    } catch { /* keep the band-local background */ }
    const isInk = (buf: Uint8ClampedArray, o: number): boolean => Math.abs(buf[o] - bg[0]) + Math.abs(buf[o + 1] - bg[1]) + Math.abs(buf[o + 2] - bg[2]) > 50;
    // Classify a row of the read band by its INK: 'blank' = negligible ink (a thin line / antialiasing — must
    // NOT stop the scan); 'frozen' = enough ink and it's IDENTICAL across the compared tiles (header/footer
    // chrome); 'content' = enough ink and it DIFFERS (the real page content, where the scan stops). Matching
    // on the ink separates a repeated bar from a similar background and tolerates a small varying corner.
    const classify = (y: number): 'blank' | 'frozen' | 'content' => {
      let inkCols = 0, matchInk = 0;
      for (let x = 0; x < rw; x += 3) {
        const o = (y * rw + x) * 4;
        if (!isInk(ref, o)) continue;
        inkCols++;
        let all = true;
        for (let j = 1; j < bands.length; j++) {
          const b = bands[j];
          if (Math.abs(ref[o] - b[o]) + Math.abs(ref[o + 1] - b[o + 1]) + Math.abs(ref[o + 2] - b[o + 2]) >= 40) { all = false; break; }
        }
        if (all) matchInk++;
      }
      if (inkCols < 4) return 'blank'; // negligible ink → tolerate, never treat as content
      return matchInk / inkCols >= 0.7 ? 'frozen' : 'content';
    };
    // Precompute row classes measured INWARD from the edge (top→down, bottom→up), then take the band as
    // everything above the FIRST content row — frozen rows plus the blank gaps between them (e.g. GitHub's
    // gap between its breadcrumb row and its Code/Blame toolbar row). depth = last frozen row's inward index.
    const cls: Array<'blank' | 'frozen' | 'content'> = [];
    for (let d = 0; d < maxBand; d++) cls.push(classify(edge === 'top' ? d : maxBand - 1 - d));
    let firstContent = cls.indexOf('content');
    if (firstContent < 0) firstContent = maxBand;
    let lastFrozen = -1, frozenRows = 0;
    for (let d = 0; d < firstContent; d++) if (cls[d] === 'frozen') { lastFrozen = d; frozenRows++; }
    const depth = lastFrozen + 1;
    return depth >= 12 && frozenRows >= 6 ? depth : 0; // require a real, multi-row frozen bar (not a stray match)
  } catch {
    return 0; // fail-safe: any decode/canvas error → no crop, normal stitch
  }
}

interface LinkRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  url: string;
}
/** A link in content image-px (top-left origin) — as consumed by linkRectForPage. */
export interface LinkPx {
  top: number;
  left: number;
  w: number;
  h: number;
  url: string;
}
/**
 * Map a content-px link onto a page whose content range is [cStart, cEnd), with the content's top edge
 * at `topPt` (PDF points, y-up) and left edge at `xOffPt`. Clips the link to the page; returns null if
 * it doesn't intersect. Pure — unit-tested (the y-flip + clipping are the error-prone part).
 */
export function linkRectForPage(
  link: LinkPx,
  cStart: number,
  cEnd: number,
  topPt: number,
  xOffPt: number,
  scalePtPerPx: number,
): LinkRect | null {
  const top = Math.max(link.top, cStart);
  const bot = Math.min(link.top + link.h, cEnd);
  if (bot <= top) return null;
  return {
    x1: xOffPt + link.left * scalePtPerPx,
    x2: xOffPt + (link.left + link.w) * scalePtPerPx,
    y1: topPt - (bot - cStart) * scalePtPerPx, // bottom (y-up)
    y2: topPt - (top - cStart) * scalePtPerPx, // top
    url: link.url,
  };
}
/** Re-validate a link URL at the PDF sink (defense in depth — never trust the collector alone): allow
 *  only http/https/mailto/tel, strip control bytes, cap length. Returns null to drop the annotation. */
export function sanitizeLinkUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  if (!/^(https?|mailto|tel):/i.test(trimmed)) return null; // scheme allowlist (defense in depth)
  return trimmed;
}
/** Encode a URL as the PDF string for a /URI action: a HEX string of the URL's raw UTF-8 bytes.
 *  Two properties, both required:
 *   - delimiter-proof (security T-1): hex digits contain no `(` `)` `\`, so an attacker-controlled href
 *     cannot break out of the PDF string and inject annotation/action tokens.
 *   - viewer-parseable (clickable): the bytes are the plain URL. Do NOT use `PDFHexString.fromText`,
 *     which encodes UTF-16BE with a leading BOM (FEFF …) — PDF viewers do not recognise that as a URI,
 *     so the link renders but is not clickable (the regression this replaces). */
export function pdfUriHexString(url: string): PDFHexString {
  const bytes = new TextEncoder().encode(url);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return PDFHexString.of(hex);
}
/** Attach clickable URI link annotations (PDF points, y-up) to a page. Pages start with no Annots. */
function addLinksToPage(doc: PDFDocument, page: PDFPage, rects: LinkRect[]): void {
  const refs = rects.flatMap((r) => {
    const url = sanitizeLinkUrl(r.url);
    if (!url) return [];
    return [
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [Math.min(r.x1, r.x2), Math.min(r.y1, r.y2), Math.max(r.x1, r.x2), Math.max(r.y1, r.y2)],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: pdfUriHexString(url) },
        }),
      ),
    ];
  });
  if (refs.length > 0) page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
}

/**
 * Render captured tiles into a multi-page PDF. Each screenshot is a full browser viewport; we crop
 * it to `contentRectCss` (the scroll panel's box — the whole viewport for document-scroll pages),
 * remove the overlap band, and lay the unique content into one continuous column. AUTO renders that
 * column as ONE full-bleed page (screen-friendly, no breaks) up to the PDF/canvas caps; A4/LETTER
 * slice it into printable pages with **content-aware breaks** (§28) — each split is pulled up to the
 * nearest whitespace gap (between lines/paragraphs) within ~18% of a page so text is never cut
 * mid-line, Word-style. Memory-safe (§26): tiles are decoded on demand and freed once no later page
 * needs them, and very large PNG captures auto-fall to JPEG to keep the PDF a sane size (§46.3).
 */
export interface FullPageImage {
  bytes: Uint8Array;
  wPx: number;
  hPx: number;
  scaleY: number; // css → device px, so callers can map content-Y anchors into the image
}

/** Crop a sub-rectangle (given in TOP-viewport CSS px) out of a full-viewport screenshot, scaling the CSS
 *  rect to the screenshot's device px via the viewport CSS dims. Used to lift a modal's fixed header/footer
 *  band out of a tile so it can be stacked around the tiled body. Returns a StackedPiece-shaped image. */
export async function cropViewportBandCss(
  tileBytes: Uint8Array,
  cssRect: { left: number; top: number; width: number; height: number },
  fullViewportWidthCss: number,
  fullViewportHeightCss: number,
  format: ImageFormat,
  jpegQuality: number,
): Promise<{ bytes: Uint8Array; wPx: number; hPx: number }> {
  const bmp = await createImageBitmap(new Blob([tileBytes as unknown as BlobPart]));
  try {
    const scaleX = fullViewportWidthCss > 0 ? bmp.width / fullViewportWidthCss : 1;
    const scaleY = fullViewportHeightCss > 0 ? bmp.height / fullViewportHeightCss : 1;
    const sx = Math.max(0, Math.round(cssRect.left * scaleX));
    const sy = Math.max(0, Math.round(cssRect.top * scaleY));
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(cssRect.width * scaleX)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(cssRect.height * scaleY)));
    const cv = new OffscreenCanvas(sw, sh);
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const useJpeg = format === 'jpeg';
    const blob = await cv.convertToBlob(useJpeg ? { type: 'image/jpeg', quality: jpegQuality } : { type: 'image/png' });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), wPx: sw, hPx: sh };
  } finally {
    bmp.close();
  }
}

/**
 * WC-M12: composite full-page tiles into ONE content image (not a PDF) — the "base atlas" that marked
 * sections are later spliced into. Same stitch geometry as renderFullPagePdf, but emits a single image.
 * Falls back to the geometric estimate ('scroll' mode). A very tall page may exceed the canvas limit;
 * that is acceptable for Phase 1 (typical lessons fit) and surfaces as a capture error, not corruption.
 */
export async function renderFullPageImage(
  tileBytes: Uint8Array[],
  params: { cropTopsCss: number[]; fullViewportWidthCss: number; fullViewportHeightCss: number; contentRectCss: { top: number; left: number; width: number; height: number }; format: ImageFormat; jpegQuality: number },
): Promise<FullPageImage> {
  if (tileBytes.length === 0) throw new Error('no tiles to render');
  const decoded = new Map<number, ImageBitmap>();
  const decode = async (i: number): Promise<ImageBitmap> => {
    let bmp = decoded.get(i);
    if (!bmp) {
      bmp = await createImageBitmap(new Blob([tileBytes[i] as unknown as BlobPart]));
      decoded.set(i, bmp);
    }
    return bmp;
  };
  try {
    const first = await decode(0);
    const scaleX = params.fullViewportWidthCss > 0 ? first.width / params.fullViewportWidthCss : 1;
    const scaleY = params.fullViewportHeightCss > 0 ? first.height / params.fullViewportHeightCss : 1;
    const rect = params.contentRectCss;
    const rx = Math.round(rect.left * scaleX);
    const ry = Math.round(rect.top * scaleY);
    const rw = Math.max(1, Math.round(rect.width * scaleX));
    const rh = Math.max(1, Math.round(rect.height * scaleY));
    const imageHeightsPx = tileBytes.map(() => rh);
    const estCropTopsPx = params.cropTopsCss.map((c, i) => (i === 0 ? 0 : Math.min(rh - 1, Math.round(c * scaleY))));
    // A FROZEN header/footer (identical across the tiles where it's pinned) must appear ONCE, not per tile.
    // Detect BEFORE aligning so the overlap-matcher matches the CONTENT below the header (skipTop) / above the
    // footer (skipBottom) — otherwise the header at each tile's top defeats the match and drops a line at the
    // seam. Fail-safe: 0 when nothing is confidently frozen → the plain overlap match.
    const headerH = await detectFrozenBand(tileBytes, rx, ry, rw, rh, 'top');
    const footerH = await detectFrozenBand(tileBytes, rx, ry, rw, rh, 'bottom');
    const frozenTop = headerH > 0;
    // PRINCIPLED STITCH on a frozen-header page — place tiles by ABSOLUTE document position, not by pixel-
    // guessing each seam. Every tile is a screenshot at a scroll recorded AT SHOT TIME, so a content row y
    // (below the pinned chrome) is exactly at document position S_i + y, and `cropTopsCss` (the overlap derived
    // from those recorded scrolls) is the EXACT crop that makes tile i continue tile i-1 with no gap and no
    // duplicate — PROVIDED capture guaranteed overlap ≥ chrome, which `scrollAndTile` enforces by adding a
    // generous content margin on top of the measured header. So trust that geometry EXACTLY and do NOT run the
    // free pixel overlap-search here: on repetitive content (specs/code) it locks onto a false deeper match and
    // over-crops (drops a band); on a content-varying sticky sub-header it under-cropped and duplicated it. Both
    // failure classes came from letting a pixel heuristic override exact geometry. Non-frozen scroll pages keep
    // the drift-correcting matcher (feeds / lazy-grow have no reliable per-row geometry).
    const cropTopsPx = frozenTop ? estCropTopsPx.slice() : await alignCropTops(tileBytes, estCropTopsPx, rx, ry, rw, rh, 'scroll', headerH, footerH);
    const EDGE = Math.round(26 * scaleY);
    if (!frozenTop) for (let i = 1; i < tileBytes.length; i++) {
      const e = Math.min(EDGE, Math.max(0, cropTopsPx[i] - 1));
      imageHeightsPx[i - 1] = rh - e;
      cropTopsPx[i] = cropTopsPx[i] - e;
    }
    // Header kept on tile 0, stripped from 1..N-1 (floor, in case the matcher under-cropped after EDGE);
    // footer kept on the last tile, stripped from 0..N-2 (crop the bottom band).
    if (headerH > 0) for (let i = 1; i < tileBytes.length; i++) cropTopsPx[i] = Math.max(cropTopsPx[i], Math.min(headerH, imageHeightsPx[i] - 1));
    if (footerH > 0) for (let i = 0; i < tileBytes.length - 1; i++) imageHeightsPx[i] = Math.max(cropTopsPx[i] + 1, Math.min(imageHeightsPx[i], rh - footerH));
    const totalContentPx = imageHeightsPx.reduce((sum, h, i) => sum + Math.max(0, h - cropTopsPx[i]), 0);
    const useJpeg = params.format === 'jpeg' || needsJpegFallback(params.format, rw * totalContentPx);
    const mime = useJpeg ? 'image/jpeg' : 'image/png';
    const canvas = new OffscreenCanvas(rw, Math.max(1, totalContentPx));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rw, totalContentPx);
    for (const s of contentSlices(imageHeightsPx, cropTopsPx, 0, totalContentPx)) {
      const bmp = await decode(s.tileIndex);
      ctx.drawImage(bmp, rx, ry + s.srcY, rw, s.srcH, 0, s.destY, rw, s.srcH);
    }
    const blob = await canvas.convertToBlob(useJpeg ? { type: mime, quality: params.jpegQuality } : { type: mime });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), wPx: rw, hPx: totalContentPx, scaleY };
  } finally {
    for (const bmp of decoded.values()) bmp.close();
  }
}

export async function renderFullPagePdf(tileBytes: Uint8Array[], params: FullPageRenderParams): Promise<FullPageResult> {
  if (tileBytes.length === 0) throw new Error('no tiles to render');
  const decoded = new Map<number, ImageBitmap>();
  // Cast at the Blob boundary: our bytes are backed by a plain ArrayBuffer, never SharedArrayBuffer.
  const decode = async (i: number): Promise<ImageBitmap> => {
    let bmp = decoded.get(i);
    if (!bmp) {
      bmp = await createImageBitmap(new Blob([tileBytes[i] as unknown as BlobPart]));
      decoded.set(i, bmp);
    }
    return bmp;
  };
  try {
    const first = await decode(0); // all tiles are full-viewport screenshots at one scale
    const scaleX = params.fullViewportWidthCss > 0 ? first.width / params.fullViewportWidthCss : 1;
    const scaleY = params.fullViewportHeightCss > 0 ? first.height / params.fullViewportHeightCss : 1;
    const rect = params.contentRectCss;
    const rx = Math.round(rect.left * scaleX);
    const ry = Math.round(rect.top * scaleY);
    const rw = Math.max(1, Math.round(rect.width * scaleX));
    const rh = Math.max(1, Math.round(rect.height * scaleY)); // usable content height per tile (px)
    const imageHeightsPx = tileBytes.map(() => rh);
    const estCropTopsPx = params.cropTopsCss.map((c, i) => (i === 0 ? 0 : Math.min(rh - 1, Math.round(c * scaleY))));
    // A FROZEN header/footer (a fixed/JS-driven bar identical across the tiles where it's pinned) must appear
    // ONCE — the GitHub file-header case the DOM suppressor can't catch. Detect BEFORE aligning so the
    // overlap-matcher matches the CONTENT below the header / above the footer (skipTop/skipBottom); matching
    // the header at each tile's top otherwise defeats the match and drops a line at the seam. Fail-safe: 0
    // when nothing is confidently frozen (a normal capture whose top scrolls is unchanged → plain match).
    const headerH = await detectFrozenBand(tileBytes, rx, ry, rw, rh, 'top');
    const footerH = await detectFrozenBand(tileBytes, rx, ry, rw, rh, 'bottom');
    // PRINCIPLED STITCH on a frozen-header page — place tiles by ABSOLUTE document position, not by pixel-
    // guessing each seam. Every tile is a screenshot at a scroll recorded AT SHOT TIME, so a content row y
    // (below the pinned chrome) is exactly at document position S_i + y, and `cropTopsCss` (the overlap derived
    // from those recorded scrolls) is the EXACT crop that makes tile i continue tile i-1 with no gap and no
    // duplicate — PROVIDED capture guaranteed overlap ≥ chrome, which `scrollAndTile` enforces by adding a
    // generous content margin on top of the measured header. So trust that geometry EXACTLY and do NOT run the
    // free pixel overlap-search here: on repetitive content (specs/code) it locks onto a false deeper match and
    // over-crops (drops a band); on a content-varying sticky sub-header it under-cropped and duplicated it.
    // Scope: a CLEAN scroll-tiling only. A snapshot (stitchMode 'match') has no reliable scroll estimate
    // (accordions insert/remove content between shots), so there the pixel matcher stays authoritative; and a
    // non-frozen scroll page keeps the drift-correcting matcher (feeds / lazy-grow).
    const frozenTop = headerH > 0 && (params.stitchMode ?? 'scroll') === 'scroll';
    const cropTopsPx = frozenTop
      ? estCropTopsPx.slice()
      : await alignCropTops(tileBytes, estCropTopsPx, rx, ry, rw, rh, params.stitchMode ?? 'scroll', headerH, footerH);
    // Edge-trim: never source content from the very bottom of a tile — a line straddling the viewport
    // bottom edge is cut there, but intact near the TOP of the next tile. Shift each seam up by EDGE so
    // both sides come from mid-tile pixels. Content is preserved (the next tile covers the trimmed rows);
    // only the sourcing changes. The last tile keeps its full bottom (the true page end). Skipped on a
    // frozen-header capture (the geometric seam is already clean and edge-trim would erode the chrome crop).
    const EDGE = Math.round(26 * scaleY);
    if (!frozenTop) for (let i = 1; i < tileBytes.length; i++) {
      const e = Math.min(EDGE, Math.max(0, cropTopsPx[i] - 1)); // stay within this seam's available overlap
      imageHeightsPx[i - 1] = rh - e; // trim tile (i-1)'s cut bottom
      cropTopsPx[i] = cropTopsPx[i] - e; // tile i now covers those rows from its intact middle
    }
    // Header kept on tile 0, stripped from 1..N-1 (floor, in case the matcher under-cropped after EDGE);
    // footer kept on the last tile, stripped from 0..N-2 (crop the bottom band).
    if (headerH > 0) for (let i = 1; i < tileBytes.length; i++) cropTopsPx[i] = Math.max(cropTopsPx[i], Math.min(headerH, imageHeightsPx[i] - 1));
    if (footerH > 0) for (let i = 0; i < tileBytes.length - 1; i++) imageHeightsPx[i] = Math.max(cropTopsPx[i] + 1, Math.min(imageHeightsPx[i], rh - footerH));
    // Geometry drives the printable (A4/LETTER) path; AUTO borrows A4's width for a consistent column.
    const geoPaper = params.paperSize === 'AUTO' ? 'A4' : params.paperSize;
    const geo = pageContentGeometry(geoPaper, params.orientation, rw);
    const totalContentPx = imageHeightsPx.reduce((sum, h, i) => sum + Math.max(0, h - cropTopsPx[i]), 0);
    // AUTO = ONE continuous page for on-screen viewing (screenshot-like, no breaks / margin gaps),
    // composited in vertical strips so a very tall capture is not blocked by the single-canvas limit
    // (the only hard ceiling is the PDF page dimension). A4/LETTER = printable, uniform pages with
    // content-aware breaks. AUTO falls back to paginated only when it is too tall for one PDF page.
    const PAGE_MAX_PT = 14400; // PDF viewers cap page dimensions near 200in
    const totalDrawH = totalContentPx * geo.scalePtPerPx;
    const oneTall = params.paperSize === 'AUTO' && totalContentPx > 0 && totalDrawH <= PAGE_MAX_PT;
    // AUTO taller than one PDF page (~200in): stay continuous with the FEWEST full-bleed TALL pages,
    // not A4-shaped fallback pages (operator 2026-08-24).
    const autoOverflow = params.paperSize === 'AUTO' && !oneTall && totalContentPx > 0;

    const useJpeg = params.format === 'jpeg' || needsJpegFallback(params.format, rw * totalContentPx);
    const mime = useJpeg ? 'image/jpeg' : 'image/png';
    const encode = (canvas: OffscreenCanvas) =>
      canvas.convertToBlob(useJpeg ? { type: mime, quality: params.jpegQuality } : { type: mime });

    const doc = await PDFDocument.create();
    doc.setProducer(`${PRODUCT_NAME} ${VERSION}`);
    doc.setCreator(PRODUCT_NAME);
    if (params.title) doc.setTitle(params.title);
    if (params.url) doc.setSubject(params.url);

    // Composite an arbitrary content-row range [start, start+height) onto a white canvas.
    const composite = async (start: number, height: number): Promise<OffscreenCanvas> => {
      const canvas = new OffscreenCanvas(rw, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d canvas context unavailable');
      ctx.fillStyle = '#ffffff'; // avoid transparent -> black in some viewers (§27.1 background)
      ctx.fillRect(0, 0, rw, height);
      for (const s of contentSlices(imageHeightsPx, cropTopsPx, start, start + height)) {
        const bmp = await decode(s.tileIndex);
        // Source is offset by the panel box (rx, ry); crop overlap via s.srcY within the panel.
        ctx.drawImage(bmp, rx, ry + s.srcY, rw, s.srcH, 0, s.destY, rw, s.srcH);
      }
      return canvas;
    };

    // Content end-offset per tile, so tiles are freed once no later output needs them (§26).
    const contentEnds: number[] = [];
    {
      let acc = 0;
      for (let i = 0; i < imageHeightsPx.length; i++) {
        acc += Math.max(0, imageHeightsPx[i] - cropTopsPx[i]);
        contentEnds.push(acc);
      }
    }
    const freeConsumedTiles = (upto: number): void => {
      for (const [ti, bmp] of decoded) {
        if ((contentEnds[ti] ?? 0) <= upto) {
          bmp.close();
          decoded.delete(ti);
        }
      }
    };

    // Links, converted to content image-px. placeLinks maps those overlapping a page's content range
    // [cStart, cEnd) onto the page (content top at `topPt`, left at `xOffPt`), clipping to the page.
    const linksPx = (params.links ?? []).map((l) => ({
      href: l.href,
      top: l.yCss * scaleY,
      left: l.xCss * scaleX,
      w: l.wCss * scaleX,
      h: l.hCss * scaleY,
    }));
    const placeLinks = (page: PDFPage, cStart: number, cEnd: number, topPt: number, xOffPt: number): void => {
      if (linksPx.length === 0) return;
      const rects: LinkRect[] = [];
      for (const l of linksPx) {
        const rect = linkRectForPage({ top: l.top, left: l.left, w: l.w, h: l.h, url: l.href }, cStart, cEnd, topPt, xOffPt, geo.scalePtPerPx);
        if (rect) rects.push(rect);
      }
      addLinksToPage(doc, page, rects);
    };

    // Optional header/footer stamp. AUTO (no margins) reserves bands; printable pages use their margins.
    const wantStamp = params.stamp === true;
    const stampData: StampData = wantStamp ? { title: params.title, url: params.url, capturedAt: params.capturedAt } : {};
    const fonts = wantStamp ? await embedStampFonts(doc) : null;
    const bandTop = wantStamp ? HEADER_BAND_PT : 0;
    const bandBottom = wantStamp ? FOOTER_BAND_PT : 0;

    let pageCount = 0;
    if (oneTall) {
      // One full-bleed page. Composite + embed in strips (bounded memory / canvas size) that stack
      // seamlessly onto the single tall page. Accumulate a whitespace profile for later re-split.
      const pdfPage = doc.addPage([geo.contentWidthPt, totalDrawH + bandTop + bandBottom]);
      const stripPx = Math.max(1, Math.min(ONE_TALL_STRIP_MAX_PX, Math.floor(ONE_TALL_STRIP_MAX_AREA / rw)));
      const gaps: [number, number][] = [];
      for (let sy = 0; sy < totalContentPx; sy += stripPx) {
        const sh = Math.min(stripPx, totalContentPx - sy);
        const strip = await composite(sy, sh);
        const sctx = strip.getContext('2d');
        if (sctx) for (const [s, l] of computeBlankGaps(sctx, rw, sh, BLANK_FRACTION)) gaps.push([sy + s, l]);
        const blob = await encode(strip);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = useJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        pdfPage.drawImage(img, {
          x: 0,
          y: bandBottom + totalDrawH - (sy + sh) * geo.scalePtPerPx, // stack strips top-down above the footer band
          width: geo.contentWidthPt,
          height: sh * geo.scalePtPerPx,
        });
        freeConsumedTiles(sy + sh);
      }
      if (gaps.length > 8000) gaps.splice(0, gaps.length, ...gaps.filter(([, l]) => l >= 3));
      doc.setKeywords([encodeBreakProfile({ h: totalContentPx, gaps, contentTopPt: bandTop, contentHeightPt: totalDrawH })]);
      placeLinks(pdfPage, 0, totalContentPx, bandBottom + totalDrawH, 0);
      pageCount = 1;
    } else if (autoOverflow) {
      // AUTO overflow (> ~200in): keep it continuous — split into the FEWEST full-bleed TALL pages (each
      // <= the PDF page limit), breaking on whitespace. Not A4-shaped, so the on-screen feel survives.
      const maxContentPx = Math.max(1, Math.floor((PAGE_MAX_PT - bandTop - bandBottom) / geo.scalePtPerPx));
      const detectBand = Math.min(2000, Math.max(24, Math.floor(maxContentPx * BREAK_LOOKBACK_FRACTION)));
      const stripPx = Math.max(1, Math.min(ONE_TALL_STRIP_MAX_PX, Math.floor(ONE_TALL_STRIP_MAX_AREA / rw)));
      const gaps: [number, number][] = []; // whitespace runs (global content-px) for the re-split profile
      const pageMeta: Array<{ s: number; h: number; ct: number; ch: number }> = []; // per source page geometry
      let start = 0;
      while (start < totalContentPx) {
        const regionH = Math.min(maxContentPx, totalContentPx - start);
        const isLast = start + regionH >= totalContentPx;
        let pageH = regionH;
        if (!isLast) {
          // Only the bottom band is needed to place the break — compositing the whole ~200in region would
          // blow the canvas limit. Find the break in the band, then map it back to the region.
          const band = await composite(start + regionH - detectBand, detectBand);
          const bctx = band.getContext('2d');
          if (!bctx) throw new Error('2d canvas context unavailable');
          const ink = computeRowInk(bctx, rw, detectBand, 0);
          pageH = regionH - detectBand + findBreakRow(ink, detectBand, detectBand, BLANK_FRACTION);
        }
        const drawH = pageH * geo.scalePtPerPx;
        const pdfPage = doc.addPage([geo.contentWidthPt, drawH + bandTop + bandBottom]);
        for (let sy = start; sy < start + pageH; sy += stripPx) {
          const sh = Math.min(stripPx, start + pageH - sy);
          const strip = await composite(sy, sh);
          const sctx = strip.getContext('2d');
          if (sctx) for (const [s0, l0] of computeBlankGaps(sctx, rw, sh, BLANK_FRACTION)) gaps.push([sy + s0, l0]); // global content-px
          const blob = await encode(strip);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const img = useJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
          pdfPage.drawImage(img, { x: 0, y: bandBottom + drawH - (sy - start + sh) * geo.scalePtPerPx, width: geo.contentWidthPt, height: sh * geo.scalePtPerPx });
        }
        placeLinks(pdfPage, start, start + pageH, bandBottom + drawH, 0);
        pageMeta.push({ s: start, h: pageH, ct: bandTop, ch: drawH }); // this source page's content range + pt geometry
        start += pageH;
        freeConsumedTiles(start);
        pageCount++;
      }
      if (gaps.length > 8000) gaps.splice(0, gaps.length, ...gaps.filter(([, l]) => l >= 3));
      // Store the break profile so re-split can do content-aware A4/Letter breaks page-by-page.
      doc.setKeywords([encodeBreakProfile({ h: totalContentPx, gaps, pages: pageMeta })]);
    } else {
      // Printable pagination: UNIFORM full-size pages, content top-aligned with extra top padding,
      // split at whitespace gaps so no line is cut mid-content. Trailing whitespace fills each page's
      // bottom, like Word. The extra top room shrinks the usable content height per page.
      const topExtraPx = Math.round(TOP_EXTRA_PT / geo.scalePtPerPx);
      const pageContentHeightPx = Math.max(1, geo.pageContentHeightPx - topExtraPx);
      const lookback = Math.max(24, Math.floor(pageContentHeightPx * BREAK_LOOKBACK_FRACTION));
      let start = 0;
      while (start < totalContentPx) {
        const regionH = Math.min(pageContentHeightPx, totalContentPx - start);
        const isLast = start + regionH >= totalContentPx;
        const region = await composite(start, regionH);
        let pageH = regionH;
        if (!isLast) {
          const rctx = region.getContext('2d');
          if (!rctx) throw new Error('2d canvas context unavailable');
          const ink = computeRowInk(rctx, rw, regionH, Math.max(0, regionH - lookback));
          pageH = findBreakRow(ink, regionH, lookback, BLANK_FRACTION);
        }
        // Embed only [0, pageH]; the rows below the break carry to the next page.
        let pageCanvas = region;
        if (pageH !== regionH) {
          pageCanvas = new OffscreenCanvas(rw, pageH);
          pageCanvas.getContext('2d')?.drawImage(region, 0, 0); // top-aligned; rows below pageH are clipped
        }
        const blob = await encode(pageCanvas);
        const pageBytes = new Uint8Array(await blob.arrayBuffer());
        const img = useJpeg ? await doc.embedJpg(pageBytes) : await doc.embedPng(pageBytes);
        const drawH = pageH * geo.scalePtPerPx;
        const pdfPage = doc.addPage([geo.pageWpt, geo.pageHpt]); // uniform page size
        pdfPage.drawImage(img, { x: MARGIN_PT, y: geo.pageHpt - MARGIN_PT - TOP_EXTRA_PT - drawH, width: geo.contentWidthPt, height: drawH });
        placeLinks(pdfPage, start, start + pageH, geo.pageHpt - MARGIN_PT - TOP_EXTRA_PT, MARGIN_PT);
        pageCount++;
        start += pageH;
        freeConsumedTiles(start);
      }
    }

    if (wantStamp && fonts) {
      // Second pass so the footer can show "p N/M" with the final page count known.
      const pages = doc.getPages();
      const M = pages.length;
      const bleed = oneTall || autoOverflow; // full-bleed AUTO pages carry the stamp in the reserved bands
      pages.forEach((pg, i) => {
        const layout = bleed
          ? { xLeft: 12, width: geo.contentWidthPt - 24, headerBaseline: pg.getHeight() - bandTop + (HEADER_BAND_PT - 11) / 2, footerBaseline: (FOOTER_BAND_PT - 7.5) / 2 + 1 }
          : { xLeft: MARGIN_PT, width: geo.contentWidthPt, headerBaseline: geo.pageHpt - 13, footerBaseline: 6 };
        drawFooter(pg, fonts, stampData, i + 1, M, layout.xLeft, layout.width, layout.footerBaseline);
        if (i === 0 && stampData.title) drawHeader(pg, fonts, stampData.title, layout.xLeft, layout.width, layout.headerBaseline);
      });
    }
    return { bytes: await doc.save(), pageCount, downgraded: useJpeg && params.format === 'png' };
  } finally {
    for (const bmp of decoded.values()) bmp.close();
  }
}

export interface StackedPiece {
  bytes: Uint8Array;
  wPx: number;
  hPx: number;
  links?: LinkPx[]; // clickable links inside THIS piece, in the piece's own image px (top-left origin) — G2
}
export interface StackedParams {
  paperSize: PaperSize;
  orientation: Orientation;
  format: ImageFormat;
  jpegQuality: number;
  title?: string;
  url?: string;
  stamp?: boolean; // draw the header (title) + footer (URL · time · page) — parity with the full-page capture
  capturedAt?: string; // human-readable local timestamp for the footer
}

// Shared page stamp for the stacked/atlas renderers (mirrors renderFullPagePdf's header/footer + bands).
interface StampCtx { on: boolean; fonts: StampFonts | null; data: StampData; bandTop: number; bandBottom: number; }
async function prepareStamp(doc: PDFDocument, p: { stamp?: boolean; title?: string; url?: string; capturedAt?: string }): Promise<StampCtx> {
  const on = p.stamp === true;
  return {
    on,
    fonts: on ? await embedStampFonts(doc) : null,
    data: on ? { title: p.title, url: p.url, capturedAt: p.capturedAt } : {},
    bandTop: on ? HEADER_BAND_PT : 0,
    bandBottom: on ? FOOTER_BAND_PT : 0,
  };
}
function drawStampPages(doc: PDFDocument, sc: StampCtx, oneTall: boolean, contentWidthPt: number, pageHpt: number, totalDrawH: number): void {
  if (!(sc.on && sc.fonts)) return;
  const pages = doc.getPages();
  const M = pages.length;
  const layout = oneTall
    ? { xLeft: 12, width: contentWidthPt - 24, headerBaseline: sc.bandBottom + totalDrawH + (HEADER_BAND_PT - 11) / 2, footerBaseline: (FOOTER_BAND_PT - 7.5) / 2 + 1 }
    : { xLeft: MARGIN_PT, width: contentWidthPt, headerBaseline: pageHpt - 13, footerBaseline: 6 };
  pages.forEach((pg, i) => {
    drawFooter(pg, sc.fonts!, sc.data, i + 1, M, layout.xLeft, layout.width, layout.footerBaseline);
    if (i === 0 && sc.data.title) drawHeader(pg, sc.fonts!, sc.data.title, layout.xLeft, layout.width, layout.headerBaseline);
  });
}

// Paginate a tall content column into printable pages with CONTENT-AWARE breaks (each split pulled up to
// whitespace so no line/heading is cut) — shared by the stacked + atlas renderers so their A4/LETTER output
// matches the full-page renderer instead of slicing at a blind fixed height. `slice(start,h)` returns the
// column rows [start, start+h) on a white canvas of width `colW`; `embed` encodes + embeds a page canvas.
async function paginateColumnWithBreaks(
  doc: PDFDocument,
  geo: PageGeometry,
  colW: number,
  totalContentPx: number,
  slice: (startPx: number, heightPx: number) => OffscreenCanvas,
  embed: (cv: OffscreenCanvas) => Promise<import('pdf-lib').PDFImage>,
  onPage?: (page: PDFPage, startPx: number, pageHpx: number) => void, // per-page hook (e.g. lay link annotations)
): Promise<number> {
  const topExtraPx = Math.round(TOP_EXTRA_PT / geo.scalePtPerPx);
  const pageContentHeightPx = Math.max(1, geo.pageContentHeightPx - topExtraPx);
  const lookback = Math.max(24, Math.floor(pageContentHeightPx * BREAK_LOOKBACK_FRACTION));
  let start = 0;
  let pageCount = 0;
  while (start < totalContentPx) {
    const regionH = Math.min(pageContentHeightPx, totalContentPx - start);
    const isLast = start + regionH >= totalContentPx;
    const region = slice(start, regionH);
    let pageH = regionH;
    if (!isLast) {
      const rctx = region.getContext('2d');
      if (!rctx) throw new Error('2d canvas context unavailable');
      const ink = computeRowInk(rctx, colW, regionH, Math.max(0, regionH - lookback));
      pageH = findBreakRow(ink, regionH, lookback, BLANK_FRACTION); // land the split on whitespace
    }
    let pageCanvas = region;
    if (pageH !== regionH) {
      pageCanvas = new OffscreenCanvas(colW, pageH);
      pageCanvas.getContext('2d')?.drawImage(region, 0, 0); // top-aligned; rows below the break carry over
    }
    const img = await embed(pageCanvas);
    const drawH = pageH * geo.scalePtPerPx;
    const page = doc.addPage([geo.pageWpt, geo.pageHpt]);
    page.drawImage(img, { x: MARGIN_PT, y: geo.pageHpt - MARGIN_PT - TOP_EXTRA_PT - drawH, width: geo.contentWidthPt, height: drawH });
    if (onPage) onPage(page, start, pageH);
    pageCount++;
    start += pageH;
  }
  return pageCount;
}

/**
 * Lay clickable link annotations for an image-stacked column (Mark / atlas / modal). `columnLinks` are in
 * the column's native image px (top-left origin, x already offset by any per-piece centering). Fail-safe
 * by design: a mapping error drops the annotations but never corrupts the image PDF — the baseline capture
 * is guaranteed, links are the bonus. Reuses the tested `linkRectForPage` + `addLinksToPage` primitives.
 */
function layColumnLinks(
  doc: PDFDocument,
  columnLinks: LinkPx[],
  geo: PageGeometry,
  scalePtPerPx: number,
): { oneTall: (page: PDFPage, colHpx: number, bandBottomPt: number) => void; onPage: (page: PDFPage, startPx: number, pageHpx: number) => void } {
  const links = columnLinks.filter((l) => sanitizeLinkUrl(l.url));
  return {
    // AUTO one-tall page: the whole column is on one page; content top sits `bandBottom` up from the page
    // bottom, so a column row cy maps to PDF y = bandBottom + (colHpx - cy) * scale.
    oneTall: (page, colHpx, bandBottomPt): void => {
      if (links.length === 0) return;
      const topPt = bandBottomPt + colHpx * scalePtPerPx; // PDF-y of column row 0 (content top)
      const rects: LinkRect[] = [];
      for (const l of links) {
        const r = linkRectForPage(l, 0, colHpx, topPt, 0, scalePtPerPx);
        if (r) rects.push(r);
      }
      addLinksToPage(doc, page, rects);
    },
    // Paginated (A4/LETTER) page covering column rows [startPx, startPx+pageHpx): same content-top model as
    // the image draw (content top at pageHpt - MARGIN - TOP_EXTRA, left at MARGIN).
    onPage: (page, startPx, pageHpx): void => {
      if (links.length === 0) return;
      const topPt = geo.pageHpt - MARGIN_PT - TOP_EXTRA_PT;
      const rects: LinkRect[] = [];
      for (const l of links) {
        const r = linkRectForPage(l, startPx, startPx + pageHpx, topPt, MARGIN_PT, scalePtPerPx);
        if (r) rects.push(r);
      }
      addLinksToPage(doc, page, rects);
    },
  };
}

/**
 * WC-M11 assembly: stack pre-composed content images (marked regions — and, in a mixed session, per-shot
 * viewport crops) top-to-bottom into one PDF. No overlap, no dedup: each piece is placed whole, so
 * nothing is duplicated or lost. AUTO = one continuous page; A4/LETTER = printable pages sliced across
 * the column (a piece may span a page boundary, fine for images). Pieces are left-aligned on white.
 */
export async function renderStackedImages(pieces: StackedPiece[], params: StackedParams): Promise<FullPageResult> {
  if (pieces.length === 0) throw new Error('no regions to assemble');
  const bmps = await Promise.all(pieces.map((p) => createImageBitmap(new Blob([p.bytes as unknown as BlobPart]))));
  try {
    const colW = Math.max(...bmps.map((b) => b.width));
    const tops: number[] = [];
    let colH = 0;
    for (const b of bmps) {
      tops.push(colH);
      colH += b.height;
    }
    if (colH < 1) throw new Error('empty region column');

    // G2: map each piece's links into the COLUMN's image px — add the piece's vertical offset (tops[i]) and
    // the same horizontal centering (dx) the draw uses, so a link lands exactly over its raster.
    const columnLinks: LinkPx[] = [];
    for (let i = 0; i < bmps.length; i++) {
      const dx = Math.round((colW - bmps[i].width) / 2);
      for (const l of pieces[i].links ?? []) columnLinks.push({ top: l.top + tops[i], left: l.left + dx, w: l.w, h: l.h, url: l.url });
    }

    const useJpeg = params.format === 'jpeg' || needsJpegFallback(params.format, colW * colH);
    const mime = useJpeg ? 'image/jpeg' : 'image/png';
    const encode = (cv: OffscreenCanvas): Promise<Blob> => cv.convertToBlob(useJpeg ? { type: mime, quality: params.jpegQuality } : { type: mime });

    // Draw the column range [startPx, startPx+heightPx) onto a fresh white canvas (native px).
    const sliceCanvas = (startPx: number, heightPx: number): OffscreenCanvas => {
      const cv = new OffscreenCanvas(colW, heightPx);
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('2d canvas context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, colW, heightPx);
      const end = startPx + heightPx;
      for (let i = 0; i < bmps.length; i++) {
        const pTop = tops[i];
        const pBot = pTop + bmps[i].height;
        if (pBot <= startPx || pTop >= end) continue;
        const srcY = Math.max(0, startPx - pTop);
        const dstY = Math.max(0, pTop - startPx);
        const h = Math.min(bmps[i].height - srcY, heightPx - dstY);
        // Center each piece horizontally on the column (sections narrower than the page look better
        // centered than left-pinned); pieces at the full width start at x=0 as before.
        const dx = Math.round((colW - bmps[i].width) / 2);
        if (h > 0) ctx.drawImage(bmps[i], 0, srcY, bmps[i].width, h, dx, dstY, bmps[i].width, h);
      }
      return cv;
    };

    const doc = await PDFDocument.create();
    doc.setProducer(`${PRODUCT_NAME} ${VERSION}`);
    doc.setCreator(PRODUCT_NAME);
    if (params.title) doc.setTitle(params.title);
    if (params.url) doc.setSubject(params.url);

    const geoPaper = params.paperSize === 'AUTO' ? 'A4' : params.paperSize;
    const geo = pageContentGeometry(geoPaper, params.orientation, colW);
    const PAGE_MAX_PT = 14400;
    const totalDrawH = colH * geo.scalePtPerPx;
    const sc = await prepareStamp(doc, params);
    const oneTall = params.paperSize === 'AUTO' && totalDrawH <= PAGE_MAX_PT;
    const linker = layColumnLinks(doc, columnLinks, geo, geo.scalePtPerPx); // G2 (fail-safe: laying is wrapped below)
    let pageCount = 0;

    if (oneTall) {
      const page = doc.addPage([geo.contentWidthPt, totalDrawH + sc.bandTop + sc.bandBottom]);
      const stripPx = Math.max(1, Math.min(ONE_TALL_STRIP_MAX_PX, Math.floor(ONE_TALL_STRIP_MAX_AREA / colW)));
      // Accumulate a whitespace profile so a later re-split lands on the SAME clean gaps — exactly like the
      // renderFullPagePdf one-tall path. Without this, a stacked/atlas capture (e.g. a GitHub page whose sticky
      // header routes it here) carried NO profile, so re-split fell back to fixed bands that sliced text lines.
      const gaps: [number, number][] = [];
      for (let sy = 0; sy < colH; sy += stripPx) {
        const sh = Math.min(stripPx, colH - sy);
        const strip = sliceCanvas(sy, sh);
        const sctx = strip.getContext('2d');
        if (sctx) for (const [s, l] of computeBlankGaps(sctx, colW, sh, BLANK_FRACTION)) gaps.push([sy + s, l]);
        const bytes = new Uint8Array(await (await encode(strip)).arrayBuffer());
        const img = useJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        page.drawImage(img, { x: 0, y: sc.bandBottom + totalDrawH - (sy + sh) * geo.scalePtPerPx, width: colW * geo.scalePtPerPx, height: sh * geo.scalePtPerPx });
      }
      if (gaps.length > 8000) gaps.splice(0, gaps.length, ...gaps.filter(([, l]) => l >= 3));
      doc.setKeywords([encodeBreakProfile({ h: colH, gaps, contentTopPt: sc.bandTop, contentHeightPt: totalDrawH })]);
      try { linker.oneTall(page, colH, sc.bandBottom); } catch { /* fail-safe: keep the image PDF, drop links */ }
      pageCount = 1;
    } else {
      pageCount = await paginateColumnWithBreaks(doc, geo, colW, colH, sliceCanvas, async (cv) => {
        const b = new Uint8Array(await (await encode(cv)).arrayBuffer());
        return useJpeg ? doc.embedJpg(b) : doc.embedPng(b);
      }, (page, startPx, pageHpx) => { try { linker.onPage(page, startPx, pageHpx); } catch { /* fail-safe */ } });
    }
    drawStampPages(doc, sc, oneTall, geo.contentWidthPt, geo.pageHpt, totalDrawH);
    return { bytes: await doc.save(), pageCount, downgraded: useJpeg && params.format === 'png' };
  } finally {
    for (const b of bmps) b.close();
  }
}

export interface AtlasInjection {
  bytes: Uint8Array;
  atYpx: number; // where to splice into the base, in base image px (already confidence-checked by the caller)
  replaceBaseHpx?: number; // base rows to OVERWRITE at atYpx (Mark: the collapsed header; Snap: the covered region). 0 = pure insert
  links?: LinkPx[]; // clickable links inside THIS injection, in its own image px (top-left origin) — G2
}

/**
 * WC-M12 Phase 1b: render the base atlas with confidently-placed sections SPLICED IN at their anchor Y —
 * each injection inserts its rows into the base (pushing content below down), so the result reads as the
 * real page with those sections expanded in place. Pieces are centered; the caller has already dropped any
 * piece it couldn't place. Same paper/pagination model as the other renderers.
 */
export async function renderAtlasWithInjections(base: { bytes: Uint8Array; links?: LinkPx[] }, injections: AtlasInjection[], params: StackedParams): Promise<FullPageResult> {
  const baseBmp = await createImageBitmap(new Blob([base.bytes as unknown as BlobPart]));
  const injBmps = await Promise.all(injections.map((j) => createImageBitmap(new Blob([j.bytes as unknown as BlobPart]))));
  try {
    const inj = injections
      .map((j, i) => ({ bmp: injBmps[i], hPx: injBmps[i].height, wPx: injBmps[i].width, replaceH: Math.max(0, Math.round(j.replaceBaseHpx || 0)), atYpx: Math.max(0, Math.min(baseBmp.height, Math.round(j.atYpx))), seq: i, links: j.links ?? [] }))
      .sort((a, b) => a.atYpx - b.atYpx || a.seq - b.seq); // by anchor Y (splice position), then TIMELINE (capture) order for ties
    type Seg = { base: boolean; y0: number; h: number; top: number; bmp: ImageBitmap; wPx: number; links?: LinkPx[] };
    const segs: Seg[] = [];
    let cursor = 0;
    for (const j of inj) {
      // STACK, never skip: a mark whose area overlaps an already-placed one is inserted right AFTER it
      // (in timeline order), like the Mark-only tool — so no shot is lost when several marks share an area
      // (e.g. the tabs of one widget). The FIRST mark at an area replaces the collapsed section (replaceH);
      // later OVERLAPPING marks only INSERT (they must not re-consume base rows already replaced).
      const overlap = j.atYpx < cursor;
      const at = Math.max(j.atYpx, cursor);
      if (at > cursor) segs.push({ base: true, y0: cursor, h: at - cursor, top: 0, bmp: baseBmp, wPx: baseBmp.width });
      segs.push({ base: false, y0: 0, h: j.hPx, top: 0, bmp: j.bmp, wPx: j.wPx, links: j.links });
      cursor = Math.min(baseBmp.height, at + (overlap ? 0 : j.replaceH));
    }
    if (cursor < baseBmp.height) segs.push({ base: true, y0: cursor, h: baseBmp.height - cursor, top: 0, bmp: baseBmp, wPx: baseBmp.width });
    let colH = 0;
    for (const s of segs) {
      s.top = colH;
      colH += s.h;
    }
    const colW = Math.max(baseBmp.width, ...inj.map((j) => j.wPx), 1);

    // G2: map links into COLUMN image px. Injection links ride their seg (offset by seg.top + centering).
    // Base links land in whichever base seg still shows their row (a base link inside a span that an
    // injection replaced is dropped — that base content isn't in the output). Clipped to the seg bottom so
    // a link never bleeds across a splice boundary.
    const columnLinks: LinkPx[] = [];
    for (const s of segs) {
      if (s.base || !s.links) continue;
      const dx = Math.round((colW - s.wPx) / 2);
      for (const l of s.links) columnLinks.push({ top: s.top + l.top, left: dx + l.left, w: l.w, h: l.h, url: l.url });
    }
    const dxBase = Math.round((colW - baseBmp.width) / 2);
    for (const l of base.links ?? []) {
      const seg = segs.find((s) => s.base && l.top >= s.y0 && l.top < s.y0 + s.h);
      if (!seg) continue; // this base row was replaced by an injection → not shown
      const h = Math.min(l.h, seg.y0 + seg.h - l.top); // clip to the seg so it can't cross a splice
      columnLinks.push({ top: seg.top + (l.top - seg.y0), left: dxBase + l.left, w: l.w, h, url: l.url });
    }

    const useJpeg = params.format === 'jpeg' || needsJpegFallback(params.format, colW * colH);
    const mime = useJpeg ? 'image/jpeg' : 'image/png';
    const encode = (cv: OffscreenCanvas): Promise<Blob> => cv.convertToBlob(useJpeg ? { type: mime, quality: params.jpegQuality } : { type: mime });
    const sliceCanvas = (startPx: number, heightPx: number): OffscreenCanvas => {
      const cv = new OffscreenCanvas(colW, heightPx);
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('2d canvas context unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, colW, heightPx);
      const end = startPx + heightPx;
      for (const s of segs) {
        const sBot = s.top + s.h;
        if (sBot <= startPx || s.top >= end) continue;
        const srcYoff = Math.max(0, startPx - s.top);
        const dstY = Math.max(0, s.top - startPx);
        const h = Math.min(s.h - srcYoff, heightPx - dstY);
        if (h <= 0) continue;
        const dx = Math.round((colW - s.wPx) / 2); // center each section on the column
        ctx.drawImage(s.bmp, 0, s.y0 + srcYoff, s.wPx, h, dx, dstY, s.wPx, h);
      }
      return cv;
    };

    const doc = await PDFDocument.create();
    doc.setProducer(`${PRODUCT_NAME} ${VERSION}`);
    doc.setCreator(PRODUCT_NAME);
    if (params.title) doc.setTitle(params.title);
    if (params.url) doc.setSubject(params.url);
    const geoPaper = params.paperSize === 'AUTO' ? 'A4' : params.paperSize;
    const geo = pageContentGeometry(geoPaper, params.orientation, colW);
    const PAGE_MAX_PT = 14400;
    const totalDrawH = colH * geo.scalePtPerPx;
    const sc = await prepareStamp(doc, params);
    const oneTall = params.paperSize === 'AUTO' && totalDrawH <= PAGE_MAX_PT;
    const linker = layColumnLinks(doc, columnLinks, geo, geo.scalePtPerPx); // G2 (fail-safe below)
    let pageCount = 0;
    if (oneTall) {
      const page = doc.addPage([geo.contentWidthPt, totalDrawH + sc.bandTop + sc.bandBottom]);
      const stripPx = Math.max(1, Math.min(ONE_TALL_STRIP_MAX_PX, Math.floor(ONE_TALL_STRIP_MAX_AREA / colW)));
      // Accumulate a whitespace profile so a later re-split lands on the SAME clean gaps — exactly like the
      // renderFullPagePdf one-tall path. Without this, a stacked/atlas capture (e.g. a GitHub page whose sticky
      // header routes it here) carried NO profile, so re-split fell back to fixed bands that sliced text lines.
      const gaps: [number, number][] = [];
      for (let sy = 0; sy < colH; sy += stripPx) {
        const sh = Math.min(stripPx, colH - sy);
        const strip = sliceCanvas(sy, sh);
        const sctx = strip.getContext('2d');
        if (sctx) for (const [s, l] of computeBlankGaps(sctx, colW, sh, BLANK_FRACTION)) gaps.push([sy + s, l]);
        const bytes = new Uint8Array(await (await encode(strip)).arrayBuffer());
        const img = useJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        page.drawImage(img, { x: 0, y: sc.bandBottom + totalDrawH - (sy + sh) * geo.scalePtPerPx, width: colW * geo.scalePtPerPx, height: sh * geo.scalePtPerPx });
      }
      if (gaps.length > 8000) gaps.splice(0, gaps.length, ...gaps.filter(([, l]) => l >= 3));
      doc.setKeywords([encodeBreakProfile({ h: colH, gaps, contentTopPt: sc.bandTop, contentHeightPt: totalDrawH })]);
      try { linker.oneTall(page, colH, sc.bandBottom); } catch { /* fail-safe: keep the image PDF, drop links */ }
      pageCount = 1;
    } else {
      pageCount = await paginateColumnWithBreaks(doc, geo, colW, colH, sliceCanvas, async (cv) => {
        const b = new Uint8Array(await (await encode(cv)).arrayBuffer());
        return useJpeg ? doc.embedJpg(b) : doc.embedPng(b);
      }, (page, startPx, pageHpx) => { try { linker.onPage(page, startPx, pageHpx); } catch { /* fail-safe */ } });
    }
    drawStampPages(doc, sc, oneTall, geo.contentWidthPt, geo.pageHpt, totalDrawH);
    return { bytes: await doc.save(), pageCount, downgraded: useJpeg && params.format === 'png' };
  } finally {
    baseBmp.close();
    for (const b of injBmps) b.close();
  }
}
