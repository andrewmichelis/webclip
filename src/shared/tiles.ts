// Pure tile-stitching + pagination geometry (WC-M4). No DOM/canvas; unit-tested.
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
 *  on demand and free each one once no later page needs it (bounded memory on long pages, §26). */
export function tileLastPage(pages: PagePlanEntry[]): Map<number, number> {
  const last = new Map<number, number>();
  pages.forEach((page, pageIndex) => {
    for (const s of page.slices) last.set(s.tileIndex, pageIndex);
  });
  return last;
}

/** Above this total pixel area, a lossless (PNG) capture yields an unwieldy PDF — fall back to JPEG (§46.3). */
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
  skipTop = 0, // rows of a FROZEN HEADER at cur's top to ignore (match content BELOW it)
  skipBottom = 0, // rows of a FROZEN FOOTER at prev's bottom to ignore (match content ABOVE it)
): number {
  if (rh <= 1 || rw <= 0) return est;
  const stepX = Math.max(1, Math.floor(rw / 200));
  const cols: number[] = [];
  for (let x = 0; x < rw; x += stepX) cols.push(x);
  const ncol = cols.length;
  const rowStep = 2; // sample every 2nd overlap row for speed

  // Match the CONTENT overlap, ignoring a frozen header on cur's top / footer on prev's bottom. `v` is the
  // content-overlap size; prev's content ends at (rh - skipBottom), cur's content starts at skipTop. The
  // estimate of the content overlap is (est - skipTop). The returned crop is measured from cur's top, so it
  // INCLUDES the header: crop = skipTop + v. (skipTop=skipBottom=0 → identical to the plain overlap match.)
  const prevBottom = rh - skipBottom;
  const estC = est - skipTop;
  const vlo = Math.max(2, Math.floor(estC - search));
  const vhi = Math.min(prevBottom - 1, rh - skipTop - 1, Math.ceil(estC + search));
  if (vhi < vlo) return est;
  const dist = new Float64Array(vhi - vlo + 1);
  let dmin = Infinity;
  for (let v = vlo; v <= vhi; v++) {
    let d = 0;
    let n = 0;
    for (let r = 0; r < v; r += rowStep) {
      const pr = (prevBottom - v + r) * rw;
      const cr = (skipTop + r) * rw;
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
  // Among all MATCHING content overlaps (dist within TIE of the best), pick the one CLOSEST to the geometric
  // content estimate. Rejects the spurious tiny-overlap match at a blank seam, snaps to a reflow-shrunk
  // overlap, and keeps the estimate's spacing on blank seams.
  const TIE = 0.6;
  let bestV = estC;
  let bestClose = Infinity;
  for (let v = vlo; v <= vhi; v++) {
    if (dist[v - vlo] <= dmin + TIE) {
      const close = Math.abs(v - estC);
      if (close < bestClose) {
        bestClose = close;
        bestV = v;
      }
    }
  }
  return Math.max(0, Math.min(rh - 1, skipTop + bestV)); // crop from cur's top = header + content overlap
}

/**
 * Overlap between two consecutive manual snapshots (WC-M10). Manual captures are hard because the page
 * MUTATES between shots — on a course player the user opens an exclusive accordion, which shifts and
 * replaces content, so two shots that "overlap" by scroll may share almost no pixels. Cropping a real
 * scroll-overlap dedupes cleanly; cropping a mutated seam would silently DROP the freshly revealed
 * section. So this is deliberately conservative:
 *   1. seed the overlap from the recorded scroll delta (`est`) and refine it to the exact pixel seam
 *      (`refineOverlap` — robust to reflow and blank gaps, which pure pixel search is not); then
 *   2. GATE it: only crop when the WHOLE overlap region is genuinely a pixel duplicate (a high fraction
 *      of its rows match). If content changed between the shots, the fraction collapses and we return 0
 *      → the shots STACK. Losing a section is unacceptable; a little duplication is fine.
 * Determined against real LinkedIn + Wind River SCORM captures. Pure; unit-tested.
 */
export function matchOverlap(prev: Uint8ClampedArray, cur: Uint8ClampedArray, rw: number, rh: number, est: number): number {
  if (rh <= 16 || rw <= 0 || est <= 4) return 0;
  // Row-BAND signature: BND band-means of luminance per row. Averaging across a band absorbs the
  // subpixel text-rendering noise that scrolled captures have (a real duplicate row still differs by
  // ~15-20 in raw pixels — enough to defeat exact matching), while keeping horizontal structure so
  // different rows stay distinguishable. This is what makes the LinkedIn feed dedupe correctly.
  const BND = 24;
  const lum = (buf: Uint8ClampedArray, o: number): number => 0.299 * buf[o] + 0.587 * buf[o + 1] + 0.114 * buf[o + 2];
  const sigOf = (buf: Uint8ClampedArray): Float64Array => {
    const s = new Float64Array(rh * BND);
    const bw = rw / BND;
    for (let y = 0; y < rh; y++) {
      for (let b = 0; b < BND; b++) {
        const x0 = Math.floor(b * bw);
        const x1 = Math.floor((b + 1) * bw);
        let sum = 0;
        let cnt = 0;
        for (let x = x0; x < x1; x += 3) {
          sum += lum(buf, (y * rw + x) * 4);
          cnt++;
        }
        s[y * BND + b] = cnt ? sum / cnt : 0;
      }
    }
    return s;
  };
  const P = sigOf(prev);
  const C = sigOf(cur);
  const sdiff = (prow: number, crow: number): number => {
    let d = 0;
    for (let b = 0; b < BND; b++) {
      const e = P[prow * BND + b] - C[crow * BND + b];
      d += e < 0 ? -e : e;
    }
    return d / BND;
  };
  const T = 14; // band-diff below which two rows are "the same content"
  const TOL = 4; // ± rows of vertical tolerance — the scroll estimate is often off by a few px, and
  // pixel-exact alignment is impossible for scrolled text; take the best match within a small window.
  const rowMatch = (aroundPrev: number, crow: number): number => {
    let bd = Infinity;
    for (let t = -TOL; t <= TOL; t++) {
      const pr = aroundPrev + t;
      if (pr >= 0 && pr < rh) {
        const d = sdiff(pr, crow);
        if (d < bd) bd = d;
      }
    }
    return bd;
  };
  // 1. Alignment: search m near the scroll estimate; score = fraction of cur's top rows that find a
  //    match in prev's bottom (with tolerance). Pick the best-scoring m, tie → closest to the estimate.
  const lo = Math.max(8, est - 300);
  const hi = Math.min(rh - 1, est + 300);
  const probe = Math.min(260, Math.floor(rh * 0.4));
  let bestM = -1;
  let bestScore = -1;
  for (let m = lo; m <= hi; m += 2) {
    let match = 0;
    let total = 0;
    for (let k = 0; k < probe && rh - m + k >= 0; k += 4) {
      total++;
      if (rowMatch(rh - m + k, k) <= T) match++;
    }
    const score = total ? match / total : 0;
    if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) < 1e-6 && bestM >= 0 && Math.abs(m - est) < Math.abs(bestM - est))) {
      bestScore = score;
      bestM = m;
    }
  }
  if (bestM < 8 || bestScore < 0.5) return 0; // no reliable overlap → stack, never lose content
  const m = bestM;
  // 2. Crop ONLY the contiguous matched PREFIX (cur top vs prev bottom, top-down), stopping at the
  //    first sustained mismatch — that is where the page CHANGED between shots (an accordion opened);
  //    everything below it is kept. This is what makes SCORM/accordion captures lose nothing.
  let crop = 0;
  let miss = 0;
  for (let k = 0; k < m; k += 2) {
    if (rowMatch(rh - m + k, k) <= T) {
      crop = k + 2;
      miss = 0;
    } else if (++miss >= 6) {
      break;
    }
  }
  return crop >= 8 ? Math.min(crop, m) : 0;
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
 * column into page-height segments (fit-to-width flow, §28). Each returned page lists
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
