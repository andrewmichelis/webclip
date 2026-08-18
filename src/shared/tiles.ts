// Pure tile-stitching + pagination geometry. No DOM/canvas; unit-tested.
// Works in screenshot-pixel space. The compositor + PDF renderer consume these plans.

/**
 * For each captured tile, how much of its TOP overlaps the previous tile and must be
 * cropped away so the stitched output has no duplicated band. Tile 0 crops nothing;
 * the bottom-clamped last tile may overlap more than the nominal overlap.
 * All values in CSS px (convert to image px with the measured scaleY).
 */
export function computeCropTops(positions: number[], viewportHeightCss: number): number[] {
  return positions.map((p, i) => {
    if (i === 0) return 0;
    const overlap = positions[i - 1] + viewportHeightCss - p;
    return Math.max(0, Math.min(viewportHeightCss, overlap));
  });
}

export interface PageSlice {
  tileIndex: number;
  srcY: number; // source row in the tile image (px)
  srcH: number; // rows to copy (px)
  destY: number; // destination row on the page canvas (px)
}
export interface PagePlanEntry {
  heightPx: number;
  slices: PageSlice[];
}

/** For each tile, the index of the LAST page that uses it — so the renderer can decode tiles
 *  on demand and free each one once no later page needs it (bounded memory on long pages). */
export function tileLastPage(pages: PagePlanEntry[]): Map<number, number> {
  const last = new Map<number, number>();
  pages.forEach((page, pageIndex) => {
    for (const s of page.slices) last.set(s.tileIndex, pageIndex);
  });
  return last;
}

/** Above this total pixel area, a lossless (PNG) capture yields an unwieldy PDF — fall back to JPEG. */
export const JPEG_FALLBACK_AREA_PX = 24_000_000;
export function needsJpegFallback(format: 'png' | 'jpeg', totalAreaPx: number): boolean {
  return format === 'png' && totalAreaPx > JPEG_FALLBACK_AREA_PX;
}

/** The tile sub-rectangles that compose an arbitrary content-row range [a, b) onto a canvas
 *  (destY = contentRow - a). Generalizes planPages to any range — used by adaptive pagination. */
export function contentSlices(imageHeightsPx: number[], cropTopsPx: number[], a: number, b: number): PageSlice[] {
  const slices: PageSlice[] = [];
  let acc = 0;
  for (let i = 0; i < imageHeightsPx.length; i++) {
    const unique = Math.max(0, imageHeightsPx[i] - cropTopsPx[i]);
    const cStart = acc;
    const cEnd = acc + unique;
    acc = cEnd;
    const s = Math.max(a, cStart);
    const e = Math.min(b, cEnd);
    if (e > s) slices.push({ tileIndex: i, srcY: cropTopsPx[i] + (s - cStart), srcH: e - s, destY: s - a });
  }
  return slices;
}

/**
 * Find the true overlap (crop-top, px) of a tile against the previous one by matching the previous
 * tile's BOTTOM band to this tile's top. `prev`/`cur` are panel-cropped RGBA buffers (rw×rh). We slide
 * a `band`-row template over [est-search, est+search] and pick the offset with the smallest luminance
 * difference, with a gentle bias to `est` so uniform/blank overlaps don't drift. Pure; unit-tested.
 * Robust to scroll drift and mid-capture reflow that a scroll-position estimate can't catch.
 */
export function refineOverlap(
  prev: Uint8ClampedArray,
  cur: Uint8ClampedArray,
  rw: number,
  rh: number,
  est: number,
  search = 150,
): number {
  if (rh <= 1 || rw <= 0) return est;
  const stepX = Math.max(1, Math.floor(rw / 200));
  const cols: number[] = [];
  for (let x = 0; x < rw; x += stepX) cols.push(x);
  const ncol = cols.length;
  const rowStep = 2; // sample every 2nd overlap row for speed

  // For each candidate overlap `v`, compare prev's LAST v rows to cur's FIRST v rows (the whole overlap).
  // Those two regions are the SAME content only at the true overlap, so the mean difference has a unique
  // minimum there — no small/large-v bias. Fully blank overlaps match at every v (a wide tie); we detect
  // that and leave the crop at the geometric estimate rather than guess.
  const vlo = Math.max(2, Math.floor(est - search));
  const vhi = Math.min(rh - 1, Math.ceil(est + search));
  if (vhi < vlo) return est;
  const dist = new Float64Array(vhi - vlo + 1);
  let dmin = Infinity;
  for (let v = vlo; v <= vhi; v++) {
    let d = 0;
    let n = 0;
    for (let r = 0; r < v; r += rowStep) {
      const pr = (rh - v + r) * rw;
      const cr = r * rw;
      for (let k = 0; k < ncol; k++) {
        const po = (pr + cols[k]) * 4;
        const co = (cr + cols[k]) * 4;
        const e =
          (0.299 * prev[po] + 0.587 * prev[po + 1] + 0.114 * prev[po + 2]) -
          (0.299 * cur[co] + 0.587 * cur[co + 1] + 0.114 * cur[co + 2]);
        d += e < 0 ? -e : e;
        n++;
      }
    }
    d = n > 0 ? d / n : Infinity;
    dist[v - vlo] = d;
    if (d < dmin) dmin = d;
  }
  // Among all MATCHING overlaps (dist within TIE of the best), pick the one CLOSEST to the geometric
  // estimate. This rejects the spurious tiny-overlap match at a blank seam boundary (the estimate is
  // nearer the real overlap), snaps to a reflow-shrunk overlap when the estimate itself no longer
  // matches, and — because a fully blank overlap matches at every v — keeps the estimate's correct
  // spacing on blank seams. The full-overlap comparison (not a bottom band) is what makes the matching
  // set exclude wrong offsets even when the seam ends in a blank gap.
  const TIE = 0.6;
  let bestV = est;
  let bestClose = Infinity;
  for (let v = vlo; v <= vhi; v++) {
    if (dist[v - vlo] <= dmin + TIE) {
      const close = Math.abs(v - est);
      if (close < bestClose) {
        bestClose = close;
        bestV = v;
      }
    }
  }
  return Math.max(0, Math.min(rh - 1, bestV));
}

/**
 * Word-style page break: within the bottom `lookback` rows of a page region, choose a break that
 * falls on WHITESPACE (a gap between lines/paragraphs) instead of through a line. `ink[y]` is a
 * per-row activity measure (≈0 = blank). Breaks at the BOTTOM of a gap (start of the next content)
 * to minimize wasted space, prefers LARGER gaps (paragraph breaks), and penalizes moving too far
 * up. Returns `regionHeight` (a hard cut at the nominal boundary) only if no gap exists in the
 * window (dense text or an image spanning the boundary). Never moves further up than `lookback`.
 */
export function findBreakRow(ink: number[], regionHeight: number, lookback: number, blankThreshold: number): number {
  const SAFETY = 8; // stop a few px INSIDE the gap, clear of the next line's antialiased top (no sliver)
  const winStart = Math.max(1, regionHeight - lookback);
  let best = regionHeight; // default: hard break at the nominal boundary
  let bestScore = -Infinity;
  let bestRunStart = regionHeight;
  let runStart = -1;
  for (let y = winStart; y <= regionHeight; y++) {
    const blank = y < regionHeight && (ink[y] ?? 0) <= blankThreshold;
    if (blank && runStart < 0) runStart = y;
    if (!blank && runStart >= 0) {
      const gapSize = y - runStart;
      const breakY = y; // bottom of the gap = top of the next line -> minimal waste, clean break
      const waste = regionHeight - breakY;
      const score = gapSize * 6 - waste; // prefer larger (paragraph) gaps; penalize moving up
      if (score > bestScore) {
        bestScore = score;
        best = breakY;
        bestRunStart = runStart;
      }
      runStart = -1;
    }
  }
  if (best >= regionHeight) return regionHeight; // hard cut — no gap found
  // Pull the break up into the gap by a small safety margin so the next line's top never leaks onto
  // this page (bounded so we never cross back above the gap into the previous line).
  return best - Math.min(SAFETY, best - bestRunStart - 1 > 0 ? best - bestRunStart - 1 : 0);
}

/**
 * Lay the tiles' unique regions into a continuous content column, then slice that
 * column into page-height segments (fit-to-width flow). Each returned page lists
 * the tile sub-rectangles that compose it. `imageHeightsPx[i]` and `cropTopsPx[i]` are
 * per tile; `pageContentHeightPx` is how many source rows fit on one PDF page's content area.
 */
export function planPages(imageHeightsPx: number[], cropTopsPx: number[], pageContentHeightPx: number): PagePlanEntry[] {
  const uniques = imageHeightsPx.map((h, i) => Math.max(0, h - cropTopsPx[i]));
  const offsets: number[] = [];
  let acc = 0;
  for (const u of uniques) {
    offsets.push(acc);
    acc += u;
  }
  const totalHeight = acc;
  if (totalHeight <= 0) return [];

  const step = Math.max(1, Math.floor(pageContentHeightPx));
  const pages: PagePlanEntry[] = [];
  for (let rowStart = 0; rowStart < totalHeight; rowStart += step) {
    const rowEnd = Math.min(rowStart + step, totalHeight);
    const slices: PageSlice[] = [];
    for (let i = 0; i < uniques.length; i++) {
      const contentStart = offsets[i];
      const contentEnd = offsets[i] + uniques[i];
      const a = Math.max(rowStart, contentStart);
      const b = Math.min(rowEnd, contentEnd);
      if (b > a) {
        slices.push({
          tileIndex: i,
          srcY: cropTopsPx[i] + (a - contentStart),
          srcH: b - a,
          destY: a - rowStart,
        });
      }
    }
    pages.push({ heightPx: rowEnd - rowStart, slices });
  }
  return pages;
}
