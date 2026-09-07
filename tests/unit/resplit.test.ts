import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  encodeBreakProfile,
  parseBreakProfile,
  inkFromGaps,
  planBands,
  bandsToSourcePt,
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

  // Security T-4: the profile is read from a USER-CHOSEN PDF's Keywords; an absurd `h` would reach
  // inkFromGaps' `new Array(h)` and exhaust memory. Reject it (→ fixed-band fallback), never allocate.
  it('rejects a crafted profile with an out-of-range height (T-4 DoS guard)', () => {
    expect(parseBreakProfile('webclip-breaks/1:{"h":900000000,"g":[]}')).toBeNull(); // huge → reject
    expect(parseBreakProfile('webclip-breaks/1:{"h":-5,"g":[]}')).toBeNull();          // negative → reject
    expect(parseBreakProfile('webclip-breaks/1:{"h":0,"g":[]}')).toBeNull();           // zero → reject
    expect(parseBreakProfile('webclip-breaks/1:{"h":1e400,"g":[]}')).toBeNull();       // Infinity → reject
    // a real-sized profile still parses
    expect(parseBreakProfile('webclip-breaks/1:{"h":4000,"g":[]}')?.h).toBe(4000);
    // one absurd per-source-page height invalidates the whole multi-page profile
    expect(parseBreakProfile('webclip-breaks/1:{"h":4000,"g":[],"p":[[0,900000000,0,500]]}')).toBeNull();
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

// Regression (operator 2026-08-24): when the STAMP is on, the AUTO one-tall PDF has a header/footer band,
// so the content is offset from the page top and shorter than the page. Re-split mapped content-px ->
// source-pt with the FULL page height and no offset, shifting every break up by the header band and
// slicing headings (a "Nice to have" heading was cut across the p2/p3 boundary on a real LinkedIn A4).
describe('re-split band-aware mapping (stamp header/footer bands)', () => {
  it('offsets boundaries by the header band and scales by the content height, excluding the bands', () => {
    // page 550pt = 30 header + 500 content + 20 footer; content is 1000px in the profile.
    const profile = { h: 1000, gaps: [] as [number, number][], contentTopPt: 30, contentHeightPt: 500 };
    const b = bandsToSourcePt([0, 400, 1000], profile, 550);
    expect(b[0]).toBeCloseTo(30, 3); // first content page starts BELOW the header band
    expect(b[1]).toBeCloseTo(30 + 400 * (500 / 1000), 3); // 230
    expect(b[b.length - 1]).toBeCloseTo(530, 3); // last ends at the content bottom (above the footer)
  });

  it('falls back to whole-page mapping for band-less PDFs (old captures / stamp off)', () => {
    const b = bandsToSourcePt([0, 400, 1000], { h: 1000, gaps: [] }, 500);
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBeCloseTo(500, 3); // maps the whole page (no bands to exclude)
  });

  it('keeps a break inside its gap where the old naive mapping sliced the line above', () => {
    // content-px boundary 400 sits in the recorded gap [395,20]. Correct source-pt = 30 + 400*0.5 = 230.
    const profile = { h: 1000, gaps: [[395, 20]] as [number, number][], contentTopPt: 30, contentHeightPt: 500 };
    const bandAware = bandsToSourcePt([0, 400, 1000], profile, 550)[1];
    const naive = 400 * (550 / 1000); // the OLD code: px * (pageHeight / h)
    const toContentPx = (pt: number) => (pt - 30) / (500 / 1000); // back-project via the TRUE geometry
    expect(toContentPx(bandAware)).toBeGreaterThanOrEqual(395);
    expect(toContentPx(bandAware)).toBeLessThanOrEqual(415); // stays in the gap → clean break
    expect(toContentPx(naive)).toBeLessThan(395); // naive lands above the gap → slices the previous line
  });

  it('round-trips the content geometry through encode/parse', () => {
    const enc = encodeBreakProfile({ h: 1000, gaps: [[10, 5]], contentTopPt: 30, contentHeightPt: 500 });
    const p = parseBreakProfile('junk ' + enc);
    expect(p?.contentTopPt).toBe(30);
    expect(p?.contentHeightPt).toBe(500);
    // a band-less profile parses with the fields absent (undefined), preserving old behavior
    const p2 = parseBreakProfile(encodeBreakProfile({ h: 100, gaps: [] }));
    expect(p2?.contentTopPt).toBeUndefined();
    expect(p2?.contentHeightPt).toBeUndefined();
  });
});

// Regression (operator 2026-08-24): AUTO capture > ~200in splits into several TALL source pages; re-split
// only did content-aware breaks for SINGLE-page sources, so a multi-page source fell back to fixed bands
// that cut lines. The AUTO-overflow branch now stores a per-source-page profile; assert it round-trips.
describe('multi-page break profile (AUTO overflow re-split)', () => {
  it('round-trips per-source-page geometry (pages: s,h,ct,ch)', () => {
    const enc = encodeBreakProfile({
      h: 3000,
      gaps: [[100, 20], [1600, 30]],
      pages: [ { s: 0, h: 1600, ct: 30, ch: 900 }, { s: 1600, h: 1400, ct: 30, ch: 800 } ],
    });
    const p = parseBreakProfile('x ' + enc);
    expect(p?.pages?.length).toBe(2);
    expect(p?.pages?.[0]).toEqual({ s: 0, h: 1600, ct: 30, ch: 900 });
    expect(p?.pages?.[1]).toEqual({ s: 1600, h: 1400, ct: 30, ch: 800 });
  });
  it('a profile without pages parses pages as undefined (single-page unaffected)', () => {
    const p = parseBreakProfile(encodeBreakProfile({ h: 100, gaps: [] }));
    expect(p?.pages).toBeUndefined();
  });
});
