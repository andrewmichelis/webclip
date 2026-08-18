import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  encodeBreakProfile,
  parseBreakProfile,
  inkFromGaps,
  planBands,
} from '../../src/shared/resplit-plan.js';
import { resplitPdfToPrintable } from '../../src/renderer/resplit.js';

describe('break profile encode/parse', () => {
  it('round-trips a profile through a keyword string', () => {
    const p = { h: 4000, gaps: [[10, 3], [500, 20]] as [number, number][] };
    const parsed = parseBreakProfile(encodeBreakProfile(p));
    expect(parsed).toEqual(p);
  });

  it('finds the tag even alongside other keywords', () => {
    const kw = 'unrelated ' + encodeBreakProfile({ h: 100, gaps: [] });
    expect(parseBreakProfile(kw)?.h).toBe(100);
  });

  it('returns null for absent or malformed profiles', () => {
    expect(parseBreakProfile(undefined)).toBeNull();
    expect(parseBreakProfile('nothing here')).toBeNull();
    expect(parseBreakProfile('webclip-breaks/1:{not json')).toBeNull();
  });
});

describe('inkFromGaps', () => {
  it('marks rows inside gaps blank and the rest solid', () => {
    const ink = inkFromGaps(10, [[2, 3]]); // rows 2,3,4 blank
    expect(ink[1]).toBeGreaterThan(0);
    expect(ink[2]).toBe(0);
    expect(ink[4]).toBe(0);
    expect(ink[5]).toBeGreaterThan(0);
  });
});

describe('planBands', () => {
  it('produces fixed bands when no whitespace profile is given', () => {
    // 2500px into 1000px pages -> [0,1000,2000,2500]
    expect(planBands(2500, 1000, 180, 2.5, null)).toEqual([0, 1000, 2000, 2500]);
  });

  it('pulls a band up to a whitespace gap so a line is not cut', () => {
    // dense content with a single gap at row 990 (a line gap just inside the window)
    const gaps: [number, number][] = [[990, 2]];
    const ink = inkFromGaps(2500, gaps);
    const bands = planBands(2500, 1000, 180, 2.5, ink);
    expect(bands[1]).toBe(991); // snapped into the gap (bottom 992 minus the 1px available safety margin)
    expect(bands[0]).toBe(0);
    expect(bands[bands.length - 1]).toBe(2500);
  });
});

async function makeTallPdf(widthPt: number, heightPt: number, keywords?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([widthPt, heightPt]);
  page.drawRectangle({ x: 0, y: 0, width: widthPt, height: heightPt }); // some content
  if (keywords) doc.setKeywords([keywords]);
  return doc.save();
}

describe('resplitPdfToPrintable', () => {
  const A4_W = 595.28;
  const A4_H = 841.89;

  it('splits a tall page into multiple A4 pages, all A4 width', async () => {
    const src = await makeTallPdf(559.28, 3000); // ~A4 content width, no profile -> fixed bands
    const { bytes, pageCount, smart } = await resplitPdfToPrintable(src, 'A4');
    expect(pageCount).toBeGreaterThan(1);
    expect(smart).toBe(false);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(pageCount);
    for (const pg of out.getPages()) {
      expect(pg.getWidth()).toBeCloseTo(A4_W, 1);
      expect(pg.getHeight()).toBeLessThanOrEqual(A4_H + 0.5);
    }
  });

  it('uses the embedded whitespace profile for a content-aware split (smart=true)', async () => {
    const profile = encodeBreakProfile({ h: 4000, gaps: [[1000, 30], [2000, 30], [3000, 30]] });
    const src = await makeTallPdf(559.28, 3000, profile);
    const { pageCount, smart } = await resplitPdfToPrintable(src, 'A4');
    expect(smart).toBe(true);
    expect(pageCount).toBeGreaterThan(1);
  });

  it('supports Letter output width', async () => {
    const src = await makeTallPdf(559.28, 2000);
    const { bytes } = await resplitPdfToPrintable(src, 'LETTER');
    const out = await PDFDocument.load(bytes);
    expect(out.getPage(0).getWidth()).toBeCloseTo(612, 1);
  });
});
