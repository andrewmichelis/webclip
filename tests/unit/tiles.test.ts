import { describe, it, expect } from 'vitest';
import {
  computeCropTops,
  planPages,
  tileLastPage,
  needsJpegFallback,
  JPEG_FALLBACK_AREA_PX,
  contentSlices,
  findBreakRow,
  refineOverlap,
  matchOverlap,
} from '../../src/shared/tiles.js';

// Build an rw×rh RGBA buffer where each row carries a UNIQUE binary signature of its "content row"
// (contentStart + y) in the first 16 columns (like the distinctive content of a real screenshot row,
// non-periodic), plus a column gradient so no band is blank. Two bands match iff their content rows
// line up exactly — modelling a scrolled screenshot's overlap.
function contentBuf(rw: number, rh: number, contentStart: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(rw * rh * 4);
  const BND = 24; // matches matchOverlap's band count so band-means stay distinctive per row
  const bw = rw / BND;
  for (let y = 0; y < rh; y++) {
    const cr = contentStart + y;
    for (let x = 0; x < rw; x++) {
      // Per-(row, BAND) value: constant within a band so band-means survive averaging (like real text,
      // whose horizontal structure is distinctive per row); identical content rows match, different
      // rows score high. Non-periodic in the content row.
      const b = Math.floor(x / bw);
      let h = (Math.imul(cr + 1, 2654435761) ^ Math.imul(b + 1, 40503)) >>> 0;
      h ^= h >>> 13;
      h = Math.imul(h, 3266489917) >>> 0;
      h ^= h >>> 16;
      const v = h & 255;
      const o = (y * rw + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

describe('matchOverlap (snapshot stitching, est-seeded + match-fraction gate)', () => {
  const rw = 200;
  const rh = 300;
  it('dedupes a genuine scroll overlap (seeded by the recorded scroll delta)', () => {
    const prev = contentBuf(rw, rh, 0); // content rows 0..299
    const cur = contentBuf(rw, rh, rh - 80); // overlaps prev's bottom 80 rows
    const v = matchOverlap(prev, cur, rw, rh, 80); // est = 80 (the true scroll overlap)
    expect(Math.abs(v - 80)).toBeLessThanOrEqual(6);
  });
  it('returns 0 when est is 0 (no overlap → stack)', () => {
    const prev = contentBuf(rw, rh, 0);
    const cur = contentBuf(rw, rh, rh - 80);
    expect(matchOverlap(prev, cur, rw, rh, 0)).toBe(0);
  });
  it('STACKS (0) when content changed between shots even though scroll suggests overlap', () => {
    // The Rise/SCORM case: the user opened a different accordion, so the "overlap" region is actually
    // new content. Even though est says 80 rows overlap, the pixels there differ → must NOT crop (would
    // drop the freshly revealed section) → stack.
    const prev = contentBuf(rw, rh, 0);
    const cur = contentBuf(rw, rh, 9999); // wholly different content in the claimed overlap region
    expect(matchOverlap(prev, cur, rw, rh, 80)).toBe(0);
  });
  it('recovers a reflow-shrunk overlap near the estimate', () => {
    const prev = contentBuf(rw, rh, 0);
    const cur = contentBuf(rw, rh, rh - 70); // true overlap 70, est slightly off at 90
    const v = matchOverlap(prev, cur, rw, rh, 90);
    expect(Math.abs(v - 70)).toBeLessThanOrEqual(8);
  });
});

describe('computeCropTops', () => {
  it('crops nothing from the first tile', () => {
    expect(computeCropTops([0, 900, 1500], 1000)[0]).toBe(0);
  });
  it('crops the nominal overlap for regular tiles', () => {
    // positions 0,900 with viewport 1000 -> overlap 100
    expect(computeCropTops([0, 900], 1000)[1]).toBe(100);
  });
  it('crops more for a bottom-clamped last tile', () => {
    // last tile jumps from 900 to 1500 (step 600) -> overlap = 900+1000-1500 = 400
    expect(computeCropTops([0, 900, 1500], 1000)[2]).toBe(400);
  });
});

describe('planPages', () => {
  it('produces one page when content fits', () => {
    const pages = planPages([1000], [0], 1200);
    expect(pages).toHaveLength(1);
    expect(pages[0].heightPx).toBe(1000);
    expect(pages[0].slices).toEqual([{ tileIndex: 0, srcY: 0, srcH: 1000, destY: 0 }]);
  });

  it('slices a tile across a page boundary without gaps or overlaps', () => {
    // one 1000px tile, page holds 600 -> two pages: [0..600) and [600..1000)
    const pages = planPages([1000], [0], 600);
    expect(pages).toHaveLength(2);
    expect(pages[0].slices).toEqual([{ tileIndex: 0, srcY: 0, srcH: 600, destY: 0 }]);
    expect(pages[1].slices).toEqual([{ tileIndex: 0, srcY: 600, srcH: 400, destY: 0 }]);
  });

  it('stitches two overlapping tiles into a continuous column', () => {
    // tiles each 1000px tall; tile 1 crops 100 top -> uniques 1000 + 900 = 1900 content
    const pages = planPages([1000, 1000], [0, 100], 5000); // single tall page
    expect(pages).toHaveLength(1);
    expect(pages[0].heightPx).toBe(1900);
    expect(pages[0].slices).toEqual([
      { tileIndex: 0, srcY: 0, srcH: 1000, destY: 0 },
      { tileIndex: 1, srcY: 100, srcH: 900, destY: 1000 }, // cropped band removed
    ]);
  });
});

describe('tileLastPage', () => {
  it('maps each tile to the last page that uses it', () => {
    // 3 tiles of 600px into 500px pages -> tiles span page boundaries
    const pages = planPages([600, 600, 600], [0, 0, 0], 500);
    const last = tileLastPage(pages);
    // tile 0 ends at content 600 (pages 0-1), tile 1 spans ~600..1200 (pages 1-2), tile 2 ~1200..1800 (pages 2-3)
    expect(last.get(0)).toBe(1);
    expect(last.get(2)).toBe(pages.length - 1);
    // the map covers every tile
    expect(new Set(last.keys())).toEqual(new Set([0, 1, 2]));
  });
});

describe('contentSlices', () => {
  it('returns the whole single tile for the full range', () => {
    expect(contentSlices([1000], [0], 0, 1000)).toEqual([{ tileIndex: 0, srcY: 0, srcH: 1000, destY: 0 }]);
  });

  it('slices a sub-range of one tile with the right source offset', () => {
    expect(contentSlices([1000], [0], 600, 1000)).toEqual([{ tileIndex: 0, srcY: 600, srcH: 400, destY: 0 }]);
  });

  it('spans two overlapping tiles, honouring the crop and dest offset', () => {
    // uniques 1000 + 900 -> content [0,1000)+[1000,1900); range [500,1500)
    expect(contentSlices([1000, 1000], [0, 100], 500, 1500)).toEqual([
      { tileIndex: 0, srcY: 500, srcH: 500, destY: 0 },
      { tileIndex: 1, srcY: 100, srcH: 500, destY: 500 }, // srcY = cropTop(100) + (1000-1000)
    ]);
  });

  it('matches planPages slice-for-slice on a page-sized range', () => {
    const page = planPages([1000], [0], 600)[1]; // second page: [600,1000)
    expect(contentSlices([1000], [0], 600, 1000)).toEqual(page.slices);
  });
});

describe('findBreakRow', () => {
  const blank = 2; // threshold: rows with activity <= 2 are whitespace

  it('breaks at the nominal boundary when the bottom is already whitespace', () => {
    const ink = new Array(1000).fill(50);
    for (let y = 980; y < 1000; y++) ink[y] = 0; // gap runs to the bottom
    expect(findBreakRow(ink, 1000, 180, blank)).toBe(1000);
  });

  it('pulls the break up to a line gap instead of cutting a line', () => {
    const ink = new Array(1000).fill(50); // dense text everywhere...
    ink[990] = 0; // ...except one blank row (a line gap) near the bottom
    // gap [990,991) closes at 991 -> break there rather than the mid-line 1000
    expect(findBreakRow(ink, 1000, 180, blank)).toBe(991);
  });

  it('prefers a larger (paragraph) gap over a closer line gap', () => {
    const ink = new Array(1000).fill(50);
    ink[995] = 0; // tiny line gap, close (waste 5, score 6-5=1)
    for (let y = 900; y < 920; y++) ink[y] = 0; // paragraph gap (waste 80, score 120-80=40)
    // breaks in the paragraph gap, pulled up by the 8px safety margin (920 - 8)
    expect(findBreakRow(ink, 1000, 180, blank)).toBe(912);
  });

  it('falls back to a hard cut when the window has no whitespace', () => {
    const ink = new Array(1000).fill(50); // no blank rows in the window at all
    expect(findBreakRow(ink, 1000, 180, blank)).toBe(1000);
  });

  it('never moves the break further up than the lookback window', () => {
    const ink = new Array(1000).fill(50);
    for (let y = 700; y < 720; y++) ink[y] = 0; // a big gap, but ABOVE the 180px window
    expect(findBreakRow(ink, 1000, 180, blank)).toBe(1000); // out of reach -> hard cut
  });
});

describe('refineOverlap', () => {
  const rw = 40;
  const rh = 300;
  // A distinctive per-content-row pattern so bands match at exactly one offset.
  const lumFor = (contentY: number, x: number): number => (contentY * 13 + x * 5) % 240;
  // Build a panel buffer for a tile that shows content rows [startContent, startContent+rh).
  const tile = (startContent: number): Uint8ClampedArray => {
    const buf = new Uint8ClampedArray(rw * rh * 4);
    for (let r = 0; r < rh; r++) {
      for (let x = 0; x < rw; x++) {
        const v = lumFor(startContent + r, x);
        const o = (r * rw + x) * 4;
        buf[o] = v;
        buf[o + 1] = v;
        buf[o + 2] = v;
        buf[o + 3] = 255;
      }
    }
    return buf;
  };

  it('recovers the true overlap even when the estimate is off (reflow shrank the overlap)', () => {
    // prev shows content [0,300); cur shows content [200,500) -> scroll delta 200, overlap 100 rows.
    const prev = tile(0);
    const cur = tile(200);
    // true cropTop for cur = 300 - 200 = 100; feed wrong estimates on both sides.
    expect(refineOverlap(prev, cur, rw, rh, 125)).toBe(100); // estimate 25px too high (the real bug shape)
    expect(refineOverlap(prev, cur, rw, rh, 80)).toBe(100);
  });

  it('keeps the estimate when the overlap band is blank (ambiguous — many offsets tie)', () => {
    const blank = new Uint8ClampedArray(rw * rh * 4).fill(255);
    expect(refineOverlap(blank, blank, rw, rh, 96)).toBe(96);
  });
});

describe('needsJpegFallback', () => {
  it('keeps PNG below the area threshold, falls back above it', () => {
    expect(needsJpegFallback('png', JPEG_FALLBACK_AREA_PX - 1)).toBe(false);
    expect(needsJpegFallback('png', JPEG_FALLBACK_AREA_PX + 1)).toBe(true);
  });
  it('never overrides an explicit JPEG choice', () => {
    expect(needsJpegFallback('jpeg', JPEG_FALLBACK_AREA_PX + 1)).toBe(false);
  });
});
