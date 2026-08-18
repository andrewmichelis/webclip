// PDF renderer (M2): one decoded screenshot -> a single-page PDF.
// pdf-lib is pure JS (no DOM/canvas), so this runs in the MV3 service worker and in tests.
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { PRODUCT_NAME, VERSION } from '../shared/constants.js';
import { contentSlices, findBreakRow, needsJpegFallback, refineOverlap } from '../shared/tiles.js';
import { encodeBreakProfile } from '../shared/resplit-plan.js';
import { embedStampFonts, drawHeader, drawFooter, HEADER_BAND_PT, FOOTER_BAND_PT, type StampData } from './stamp.js';
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

  if (opts.paperSize === 'AUTO') {
    // One page exactly matching the capture aspect ratio.
    const page = doc.addPage([imgWpt, imgHpt]);
    page.drawImage(img, { x: 0, y: 0, width: imgWpt, height: imgHpt });
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
  }

  return doc.save();
}

// ---- Full-page: continuous fit-to-width pagination across pages ----

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
  downgraded?: boolean; // PNG was auto-switched to JPEG because the capture was very large
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
function detectBackground(data: Uint8ClampedArray, width: number, height: number): RGB {
  const buckets = new Map<number, number>();
  const sx = Math.max(1, Math.floor(width / 64));
  const sy = Math.max(1, Math.floor(height / 64));
  let bestKey = 0xf8f8f8;
  let bestCount = -1;
  for (let y = 0; y < height; y += sy) {
    for (let x = 0; x < width; x += sx) {
      const o = (y * width + x) * 4;
      const key = ((data[o] & 0xf8) << 16) | ((data[o + 1] & 0xf8) << 8) | (data[o + 2] & 0xf8); // quantize /8
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
    refined[i] = refineOverlap(prev, cur, rw, rh, estCropPx[i]);
    prev = cur;
  }
  return refined;
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
 *   - delimiter-proof: hex digits contain no `(` `)` `\`, so an attacker-controlled href
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
 * slice it into printable pages with **content-aware breaks** — each split is pulled up to the
 * nearest whitespace gap (between lines/paragraphs) within ~18% of a page so text is never cut
 * mid-line, Word-style. Memory-safe: tiles are decoded on demand and freed once no later page
 * needs them, and very large PNG captures auto-fall to JPEG to keep the PDF a sane size.
 */
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
    // Correct the scroll-based overlap by matching actual pixels at each seam (drift / reflow safe).
    const cropTopsPx = await alignCropTops(tileBytes, estCropTopsPx, rx, ry, rw, rh);
    // Edge-trim: never source content from the very bottom of a tile — a line straddling the viewport
    // bottom edge is cut there, but intact near the TOP of the next tile. Shift each seam up by EDGE so
    // both sides come from mid-tile pixels. Content is preserved (the next tile covers the trimmed rows);
    // only the sourcing changes. The last tile keeps its full bottom (the true page end).
    const EDGE = Math.round(26 * scaleY);
    for (let i = 1; i < tileBytes.length; i++) {
      const e = Math.min(EDGE, Math.max(0, cropTopsPx[i] - 1)); // stay within this seam's available overlap
      imageHeightsPx[i - 1] = rh - e; // trim tile (i-1)'s cut bottom
      cropTopsPx[i] = cropTopsPx[i] - e; // tile i now covers those rows from its intact middle
    }
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
      ctx.fillStyle = '#ffffff'; // avoid transparent -> black in some viewers
      ctx.fillRect(0, 0, rw, height);
      for (const s of contentSlices(imageHeightsPx, cropTopsPx, start, start + height)) {
        const bmp = await decode(s.tileIndex);
        // Source is offset by the panel box (rx, ry); crop overlap via s.srcY within the panel.
        ctx.drawImage(bmp, rx, ry + s.srcY, rw, s.srcH, 0, s.destY, rw, s.srcH);
      }
      return canvas;
    };

    // Content end-offset per tile, so tiles are freed once no later output needs them.
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
      doc.setKeywords([encodeBreakProfile({ h: totalContentPx, gaps })]);
      placeLinks(pdfPage, 0, totalContentPx, bandBottom + totalDrawH, 0);
      pageCount = 1;
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
      const layout = oneTall
        ? { xLeft: 12, width: geo.contentWidthPt - 24, headerBaseline: bandBottom + totalDrawH + (HEADER_BAND_PT - 11) / 2, footerBaseline: (FOOTER_BAND_PT - 7.5) / 2 + 1 }
        : { xLeft: MARGIN_PT, width: geo.contentWidthPt, headerBaseline: geo.pageHpt - 13, footerBaseline: 6 };
      pages.forEach((pg, i) => {
        drawFooter(pg, fonts, stampData, i + 1, M, layout.xLeft, layout.width, layout.footerBaseline);
        if (i === 0 && stampData.title) drawHeader(pg, fonts, stampData.title, layout.xLeft, layout.width, layout.headerBaseline);
      });
    }
    return { bytes: await doc.save(), pageCount, downgraded: useJpeg && params.format === 'png' };
  } finally {
    for (const bmp of decoded.values()) bmp.close();
  }
}
